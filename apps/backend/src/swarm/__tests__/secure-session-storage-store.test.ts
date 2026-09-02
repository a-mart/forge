import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSecureSessionMigrations } from "../secure-sessions/storage/secure-session-migrations.js";
import {
  SecureSessionAliasConflictError,
  SecureSessionRequestExpiredError,
  SecureSessionRevisionConflictError,
  SecureSessionStore
} from "../secure-sessions/storage/secure-session-store.js";

const NOW = "2026-07-23T12:00:00.000Z";

describe("SecureSessionStore", () => {
  it("persists a private catalog while returning material-free lists and atomic revisions", () => {
    const { database, store } = createMemoryStore();
    store.upsertProvider({
      providerId: "local",
      kind: "local_keychain",
      displayName: "Local keychain"
    });
    const result = store.createSecretWithBindings({
      secret: {
        secretId: "secret-1",
        providerId: "local",
        displayAlias: "deploy-token",
        displayName: "Deploy token",
        username: "deploy-user",
        note: "Used by the production deploy workflow.",
        scopeKind: "instance",
        retention: "saved",
        sourceLocator: "local:secret-1",
        encryptedMaterial: Buffer.from("safe-storage-ciphertext")
      },
      bindings: [
        { bindingId: "env", deliveryKind: "environment", targetName: "DEPLOY_TOKEN" },
        { bindingId: "stdin", deliveryKind: "stdin" }
      ]
    });

    expect(result.bindings.map(({ bindingId }) => bindingId)).toEqual(["env", "stdin"]);
    expect(store.getCatalogState().revision).toBe(4);
    expect(store.listSecrets()).toEqual([
      expect.objectContaining({
        secretId: "secret-1",
        displayAlias: "deploy-token",
        username: "deploy-user",
        note: "Used by the production deploy workflow.",
        retention: "saved"
      })
    ]);
    expect(store.listSecrets()[0]).not.toHaveProperty("encryptedMaterial");
    expect(store.getEncryptedSecret("secret-1")).toEqual(expect.objectContaining({
      sourceLocator: "local:secret-1",
      username: "deploy-user",
      note: "Used by the production deploy workflow.",
      encryptedMaterial: Buffer.from("safe-storage-ciphertext")
    }));

    const before = store.getCatalogState();
    expect(() => store.updateSecretWithBindings({
      secret: {
        secretId: "secret-1",
        providerId: "local",
        displayAlias: "changed-alias",
        scopeKind: "instance",
        retention: "saved",
        sourceLocator: "local:secret-1",
        encryptedMaterial: Buffer.from("new-ciphertext")
      },
      bindings: [
        { bindingId: "bad", deliveryKind: "file" }
      ]
    })).toThrow(/target path/);
    expect(store.getSecret("secret-1")?.displayAlias).toBe("deploy-token");
    expect(store.getCatalogState()).toEqual(before);
    database.close();
  });

  it("keeps Bitwarden credentials backend-only and removes them on cascade delete", () => {
    const { database, store } = createMemoryStore();
    store.upsertProvider({
      providerId: "bws",
      kind: "bitwarden_secrets_manager",
      displayName: "Bitwarden"
    });
    store.upsertProviderBackendConfig({
      providerId: "bws",
      serverOrigin: "https://vault.bitwarden.com",
      organizationId: "org-1",
      projectId: "project-1",
      encryptedAccessToken: Buffer.from("safe-storage-token-ciphertext")
    });
    store.createSecret({
      secretId: "bws-secret",
      providerId: "bws",
      displayAlias: "deploy-token",
      scopeKind: "instance",
      retention: "saved",
      sourceLocator: "00000000-0000-4000-8000-000000000001"
    });
    store.putProjectDefault({
      profileId: "project-a",
      secretId: "bws-secret"
    });

    expect(store.listProviders()[0]).not.toHaveProperty("encryptedAccessToken");
    expect(store.listProviders()[0]).not.toHaveProperty("serverOrigin");
    expect(store.getProviderBackendConfig("bws")).toEqual({
      providerId: "bws",
      serverOrigin: "https://vault.bitwarden.com",
      organizationId: "org-1",
      projectId: "project-1",
      encryptedAccessToken: Buffer.from("safe-storage-token-ciphertext")
    });
    expect(store.deleteProvider("bws")).toBe(true);
    expect(store.getProviderBackendConfig("bws")).toBeNull();
    expect(store.getSecret("bws-secret")).toBeNull();
    expect(store.listProjectDefaults("project-a")).toEqual([]);
    expect(store.listAudit().filter(({ eventType }) =>
      eventType === "project_default_deleted"
    )).toEqual([
      expect.objectContaining({
        profileId: "project-a",
        secretId: "bws-secret",
        outcome: "deleted"
      })
    ]);
    database.close();
  });

  it("persists several Password Manager collections as metadata and cascades them with the provider", () => {
    const { database, store } = createMemoryStore();
    store.upsertProvider({
      providerId: "password-manager",
      kind: "bitwarden_password_manager",
      displayName: "Team Bitwarden",
      status: "locked",
      lastStatusCode: "source_locked",
    });
    expect(store.replaceBitwardenCollections({
      providerId: "password-manager",
      collections: [
        {
          collectionId: "11111111-1111-4111-8111-111111111111",
          organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "Infrastructure",
        },
        {
          collectionId: "22222222-2222-4222-8222-222222222222",
          organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "Development",
        },
      ],
    })).toEqual([
      expect.objectContaining({
        collectionId: "22222222-2222-4222-8222-222222222222",
        name: "Development",
      }),
      expect.objectContaining({
        collectionId: "11111111-1111-4111-8111-111111111111",
        name: "Infrastructure",
      }),
    ]);
    expect(database.prepare(`
      SELECT encrypted_access_token
      FROM secure_session_provider
      WHERE provider_id = 'password-manager'
    `).get()).toEqual({ encrypted_access_token: null });

    expect(store.deleteProvider("password-manager")).toBe(true);
    expect(store.listBitwardenCollections("password-manager")).toEqual([]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("persists and restores only the Password Manager CLI executable path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-secure-cli-path-"));
    const databasePath = join(directory, "secure-sessions.db");
    try {
      const firstDatabase = new Database(databasePath);
      firstDatabase.pragma("foreign_keys = ON");
      runSecureSessionMigrations(firstDatabase);
      const first = new SecureSessionStore(
        firstDatabase,
        undefined,
        () => new Date(NOW),
      );
      first.upsertProvider({
        providerId: "password-manager",
        kind: "bitwarden_password_manager",
        displayName: "Team Bitwarden",
      });
      first.upsertProvider({
        providerId: "local",
        kind: "local_keychain",
        displayName: "Local vault",
      });

      expect(first.updateBitwardenPasswordManagerCliPath(
        "password-manager",
        "C:\\Tools\\Bitwarden CLI\\bw.exe",
      )).toEqual(expect.objectContaining({
        providerId: "password-manager",
        cliExecutablePath: "C:\\Tools\\Bitwarden CLI\\bw.exe",
      }));
      expect(() => first.updateBitwardenPasswordManagerCliPath(
        "local",
        "/usr/local/bin/bw",
      )).toThrow(/Password Manager provider/);
      firstDatabase.close();

      const secondDatabase = new Database(databasePath);
      secondDatabase.pragma("foreign_keys = ON");
      runSecureSessionMigrations(secondDatabase);
      const second = new SecureSessionStore(
        secondDatabase,
        undefined,
        () => new Date(NOW),
      );
      expect(second.getProvider("password-manager")).toEqual(
        expect.objectContaining({
          cliExecutablePath: "C:\\Tools\\Bitwarden CLI\\bw.exe",
        }),
      );
      expect(second.updateBitwardenPasswordManagerCliPath(
        "password-manager",
        null,
      )).toEqual(expect.objectContaining({ cliExecutablePath: null }));
      secondDatabase.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rotates ciphertext with CAS without changing catalog policy state", () => {
    const { database, store } = createMemoryStore();
    store.upsertProvider({
      providerId: "local",
      kind: "local_keychain",
      displayName: "Local keychain",
    });
    store.createSecret({
      secretId: "local-secret",
      providerId: "local",
      displayAlias: "local-token",
      scopeKind: "instance",
      retention: "saved",
      sourceLocator: "local:local-secret",
      encryptedMaterial: Buffer.from("legacy-local-ciphertext"),
    });
    store.upsertProvider({
      providerId: "bws",
      kind: "bitwarden_secrets_manager",
      displayName: "Bitwarden",
    });
    const createdConfig = store.upsertProviderBackendConfig({
      providerId: "bws",
      serverOrigin: "https://vault.example.test",
      organizationId: null,
      projectId: null,
      encryptedAccessToken: Buffer.from("legacy-provider-ciphertext"),
    });
    createdConfig.encryptedAccessToken.fill(0);
    const catalogBefore = store.getCatalogState();
    const auditBefore = store.listAudit();

    expect(store.rotateEncryptedSecretMaterial({
      secretId: "local-secret",
      expectedEncryptedMaterial: Buffer.from("legacy-local-ciphertext"),
      encryptedMaterial: Buffer.from("current-local-ciphertext"),
    })).toBe(true);
    expect(store.rotateEncryptedSecretMaterial({
      secretId: "local-secret",
      expectedEncryptedMaterial: Buffer.from("legacy-local-ciphertext"),
      encryptedMaterial: Buffer.from("stale-write"),
    })).toBe(false);
    expect(store.rotateProviderBackendCredential({
      providerId: "bws",
      expectedEncryptedAccessToken: Buffer.from("legacy-provider-ciphertext"),
      encryptedAccessToken: Buffer.from("current-provider-ciphertext"),
    })).toBe(true);
    expect(store.rotateProviderBackendCredential({
      providerId: "bws",
      expectedEncryptedAccessToken: Buffer.from("legacy-provider-ciphertext"),
      encryptedAccessToken: Buffer.from("stale-write"),
    })).toBe(false);

    const local = store.getEncryptedSecret("local-secret");
    const config = store.getProviderBackendConfig("bws");
    expect(local?.encryptedMaterial).toEqual(
      Buffer.from("current-local-ciphertext"),
    );
    expect(config?.encryptedAccessToken).toEqual(
      Buffer.from("current-provider-ciphertext"),
    );
    expect(store.getCatalogState()).toEqual(catalogBefore);
    expect(store.listAudit()).toEqual(auditBefore);
    local?.encryptedMaterial?.fill(0);
    config?.encryptedAccessToken.fill(0);
    database.close();
  });

  it("atomically replaces only a Bitwarden credential while revoking its leases", () => {
    const { database, store } = createMemoryStore();
    store.upsertProvider({
      providerId: "bws",
      kind: "bitwarden_secrets_manager",
      displayName: "Bitwarden",
      status: "auth_required",
      lastStatusCode: "provider_auth_required",
    });
    const initialConfig = store.upsertProviderBackendConfig({
      providerId: "bws",
      serverOrigin: "https://vault.example.test",
      organizationId: "org-1",
      projectId: "project-1",
      encryptedAccessToken: Buffer.from("old-ciphertext"),
    });
    initialConfig.encryptedAccessToken.fill(0);
    store.createSecretWithBindings({
      secret: {
        secretId: "remote-secret",
        providerId: "bws",
        displayAlias: "remote-token",
        scopeKind: "instance",
        retention: "saved",
        sourceLocator: "11111111-1111-1111-1111-111111111111",
      },
      bindings: [{
        bindingId: "remote-binding",
        deliveryKind: "environment",
        targetName: "REMOTE_TOKEN",
      }],
    });
    store.getOrCreateSessionState("session", {
      profileId: "profile",
      executionMode: "secure",
      environmentStatus: "ready",
    });
    store.createLease({
      leaseId: "remote-lease",
      sessionAgentId: "session",
      secretId: "remote-secret",
      bindingIds: ["remote-binding"],
      leaseKind: "task",
      baseRevision: 0,
    });

    const provider = store.replaceProviderBackendCredential({
      providerId: "bws",
      encryptedAccessToken: Buffer.from("new-ciphertext"),
      lastVerifiedAt: NOW,
    });
    const config = store.getProviderBackendConfig("bws")!;

    expect(provider).toEqual(expect.objectContaining({
      providerId: "bws",
      status: "available",
      lastStatusCode: "ok",
      lastVerifiedAt: NOW,
    }));
    expect(config).toEqual(expect.objectContaining({
      serverOrigin: "https://vault.example.test",
      organizationId: "org-1",
      projectId: "project-1",
    }));
    expect(config.encryptedAccessToken.toString("utf8")).toBe("new-ciphertext");
    config.encryptedAccessToken.fill(0);
    expect(store.getSnapshot("session").leases).toEqual([
      expect.objectContaining({
        leaseId: "remote-lease",
        state: "revoked",
        revocationReason: "policy_changed",
      }),
    ]);
    expect(store.getSecret("remote-secret")).toEqual(
      expect.objectContaining({ secretId: "remote-secret" }),
    );
    database.close();
  });

  it("uses revision CAS and exactly-once one-use operation reservations", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    expect(store.getOrCreateSessionState("session", {
      profileId: "profile",
      executionMode: "secure",
      environmentStatus: "ready"
    })).toEqual(expect.objectContaining({
      revision: 0,
      profileId: "profile",
      executionMode: "secure",
      environmentStatus: "ready"
    }));

    const granted = store.createLease({
      leaseId: "lease-1",
      sessionAgentId: "session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "one_use",
      baseRevision: 0
    });
    expect(granted.revision).toBe(1);
    expect(() => store.createLease({
      leaseId: "lease-stale",
      sessionAgentId: "session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      baseRevision: 0
    })).toThrow(SecureSessionRevisionConflictError);

    const first = store.reserveLeaseUse({
      operationId: "operation-1",
      leaseId: "lease-1",
      sessionAgentId: "session"
    });
    expect(first).toEqual(expect.objectContaining({ reserved: true, idempotent: false }));
    expect(store.reserveLeaseUse({
      operationId: "operation-1",
      leaseId: "lease-1",
      sessionAgentId: "session"
    })).toEqual(expect.objectContaining({ reserved: true, idempotent: true }));
    expect(store.reserveLeaseUse({
      operationId: "operation-2",
      leaseId: "lease-1",
      sessionAgentId: "session"
    })).toEqual(expect.objectContaining({ reserved: false, idempotent: false }));

    store.beginExposure({
      exposureId: "exposure-1",
      operationId: "operation-1",
      bindingId: "binding"
    });
    store.closeExposure({ exposureId: "exposure-1", outcome: "completed" });
    const completed = store.completeLeaseUse({
      operationId: "operation-1",
      outcome: "succeeded"
    });
    expect(completed.revision).toBe(2);
    expect(completed.snapshot.leases[0]).toEqual(expect.objectContaining({
      state: "consumed",
      remainingUses: 0,
      oneUseOperationId: "operation-1"
    }));
    expect(store.completeLeaseUse({
      operationId: "operation-1",
      outcome: "succeeded"
    }).changed).toBe(false);
    database.close();
  });

  it("creates a multi-secret grant in one revision and rolls back deterministic failures", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    store.createSecretWithBindings({
      secret: {
        secretId: "secret-2",
        providerId: "local",
        displayAlias: "deploy-key",
        scopeKind: "instance",
        retention: "saved",
        sourceLocator: "local:secret-2",
        encryptedMaterial: Buffer.from("safe-storage-ciphertext-2")
      },
      bindings: [{
        bindingId: "binding-2",
        deliveryKind: "file",
        targetPath: "/run/forge-secure/bindings/deploy-key",
        fileMode: 0o400
      }]
    });
    store.getOrCreateSessionState("session", {
      profileId: "profile",
      executionMode: "secure",
      environmentStatus: "ready"
    });

    const granted = store.createLeases({
      sessionAgentId: "session",
      baseRevision: 0,
      grants: [
        {
          leaseId: "lease-1",
          secretId: "secret",
          bindingIds: ["binding"],
          leaseKind: "task"
        },
        {
          leaseId: "lease-2",
          secretId: "secret-2",
          bindingIds: ["binding-2"],
          leaseKind: "one_use"
        }
      ]
    });

    expect(granted).toEqual(expect.objectContaining({
      changed: true,
      revision: 1
    }));
    expect(granted.snapshot.leases).toHaveLength(2);
    expect(database.prepare(`
      SELECT event_type, lease_id, affected_count
      FROM secure_session_revision
      WHERE session_agent_id = ? AND revision = 1
    `).get("session")).toEqual({
      event_type: "lease_created",
      lease_id: null,
      affected_count: 2
    });
    expect(store.listAudit("session").filter(({ eventType }) =>
      eventType === "lease_created"
    )).toHaveLength(2);

    const auditCount = store.listAudit("session").length;
    expect(() => store.createLeases({
      sessionAgentId: "session",
      baseRevision: 1,
      grants: [
        {
          leaseId: "lease-3",
          secretId: "secret",
          bindingIds: ["binding"],
          leaseKind: "task"
        },
        {
          leaseId: "lease-4",
          secretId: "secret-2",
          bindingIds: ["missing-binding"],
          leaseKind: "task"
        }
      ]
    })).toThrow(/bindings must all belong/);
    expect(store.getSnapshot("session")).toEqual(expect.objectContaining({
      state: expect.objectContaining({ revision: 1 }),
      leases: expect.arrayContaining([
        expect.objectContaining({ leaseId: "lease-1" }),
        expect.objectContaining({ leaseId: "lease-2" })
      ])
    }));
    expect(store.getLease("lease-3")).toBeNull();
    expect(store.getLease("lease-4")).toBeNull();
    expect(store.listAudit("session")).toHaveLength(auditCount);
    database.close();
  });

  it("allows only one one-use claim across independent SQLite connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-secure-store-cas-"));
    const dbPath = join(directory, "secure-sessions.db");
    const firstDatabase = new Database(dbPath);
    firstDatabase.pragma("journal_mode = WAL");
    firstDatabase.pragma("foreign_keys = ON");
    firstDatabase.pragma("busy_timeout = 5000");
    runSecureSessionMigrations(firstDatabase);
    const first = new SecureSessionStore(firstDatabase, undefined, () => new Date(NOW));
    seedLocalCatalog(first);
    first.getOrCreateSessionState("session", { profileId: "profile" });
    first.createLease({
      leaseId: "lease",
      sessionAgentId: "session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "one_use",
      baseRevision: 0
    });

    const secondDatabase = new Database(dbPath);
    secondDatabase.pragma("journal_mode = WAL");
    secondDatabase.pragma("foreign_keys = ON");
    secondDatabase.pragma("busy_timeout = 5000");
    runSecureSessionMigrations(secondDatabase);
    const second = new SecureSessionStore(secondDatabase, undefined, () => new Date(NOW));

    const attempts = await Promise.all([
      Promise.resolve().then(() => first.reserveLeaseUse({
        operationId: "operation-a",
        leaseId: "lease",
        sessionAgentId: "session"
      })),
      Promise.resolve().then(() => second.reserveLeaseUse({
        operationId: "operation-b",
        leaseId: "lease",
        sessionAgentId: "session"
      }))
    ]);
    expect(attempts.filter(({ reserved }) => reserved)).toHaveLength(1);
    expect(attempts.filter(({ reserved }) => !reserved)).toHaveLength(1);
    expect(firstDatabase.pragma("quick_check", { simple: true })).toBe("ok");
    secondDatabase.close();
    firstDatabase.close();
  });

  it("persists alias-miss requests with independent exposures and resolves them privately", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    store.getOrCreateSessionState("session", { profileId: "profile" });
    const pending = store.createRequest({
      requestId: "request",
      sessionAgentId: "session",
      secretId: null,
      displayAlias: "deploy-token",
      requestedExposures: [
        { deliveryKind: "environment", targetName: "TOKEN" }
      ],
      requestedLeaseKind: "task",
      purposeSummary: "Deploy the reviewed release",
      requestedByAgentId: "session",
      requestedByDisplayName: "Release worker"
    });
    expect(pending.requests[0]).toEqual(expect.objectContaining({
      secretId: null,
      displayAlias: "deploy-token",
      requestedExposures: [{
        deliveryKind: "environment",
        targetName: "TOKEN",
        targetPath: null,
        fileMode: null
      }]
    }));

    const resolved = store.resolveRequest({
      requestId: "request",
      state: "approved",
      selectedSecretId: "secret"
    });
    expect(resolved.requests).toEqual([]);
    const lease = store.createLease({
      leaseId: "lease",
      sessionAgentId: "session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      requestId: "request",
      baseRevision: resolved.state.revision
    });
    expect(lease.snapshot.leases[0]?.requestId).toBe("request");
    database.close();
  });

  it("does not inherit leases on fork and revokes all active leases on lifecycle changes", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    store.getOrCreateSessionState("source", { profileId: "profile" });
    store.createLease({
      leaseId: "task",
      sessionAgentId: "source",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      baseRevision: 0
    });

    const fork = store.createForkSessionState("source", "fork");
    expect(fork.state).toEqual(expect.objectContaining({
      forkedFromSessionAgentId: "source",
      revision: 0,
      profileId: "profile"
    }));
    expect(fork.leases).toEqual([]);

    const revoked = store.revokeSessionLeases("source", "session_stopped");
    expect(revoked.snapshot.leases[0]).toEqual(expect.objectContaining({
      state: "revoked",
      revocationReason: "session_stopped"
    }));
    expect(store.deleteSessionState("source")).toBe(true);
    database.close();
  });

  it("expires timed leases in one revision per affected session", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    store.getOrCreateSessionState("session", { profileId: "profile" });
    store.createLease({
      leaseId: "timed",
      sessionAgentId: "session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "timed",
      baseRevision: 0,
      expiresAt: "2026-07-23T12:00:01.000Z"
    });
    const [expired] = store.expireLeases("2026-07-23T12:00:02.000Z");
    expect(expired).toEqual(expect.objectContaining({ changed: true, revision: 2 }));
    expect(expired?.snapshot.leases[0]?.state).toBe("expired");
    database.close();
  });

  it("survives close/reopen with pending requests, snapshots, and quick_check intact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-secure-store-restart-"));
    const dbPath = join(directory, "secure-sessions.db");
    const options = { dbPath, loadDatabaseModule: async () => Database };
    const first = await SecureSessionStore.open(options, () => new Date(NOW));
    seedLocalCatalog(first);
    first.createSecret({
      secretId: "multi-project-secret",
      providerId: "local",
      displayAlias: "multi-project",
      note: "Persists across Forge restarts.",
      scopeKind: "profile",
      profileIds: ["profile-b", "profile-a"],
      retention: "saved",
      sourceLocator: "local:multi-project-secret",
      encryptedMaterial: Buffer.from("safe-storage-multi-project-ciphertext")
    });
    first.putProjectDefault({ profileId: "profile", secretId: "secret" });
    first.getOrCreateSessionState("session", { profileId: "profile" });
    first.createRequest({
      requestId: "request",
      sessionAgentId: "session",
      displayAlias: "missing-alias",
      requestedExposures: [{ deliveryKind: "stdin" }],
      requestedLeaseKind: "one_use",
      purposeSummary: "Authenticate the reviewed operation",
      requestedByAgentId: "session",
      requestedByDisplayName: "Worker"
    });
    first.createLease({
      leaseId: "project-default-lease",
      sessionAgentId: "session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      grantSource: "project_default",
      baseRevision: 1
    });
    await first.close();

    const second = await SecureSessionStore.open(options, () => new Date(NOW));
    expect(second.getSnapshot("session")).toEqual(expect.objectContaining({
      state: expect.objectContaining({ revision: 2, profileId: "profile" }),
      leases: [expect.objectContaining({
        leaseId: "project-default-lease",
        grantSource: "project_default"
      })],
      requests: [expect.objectContaining({
        requestId: "request",
        secretId: null,
        requestedExposures: [expect.objectContaining({ deliveryKind: "stdin" })]
      })]
    }));
    expect(second.listProjectDefaults("profile")).toEqual([
      expect.objectContaining({ secretId: "secret" })
    ]);
    expect(second.getSecret("multi-project-secret")).toEqual(
      expect.objectContaining({
        note: "Persists across Forge restarts.",
        profileId: "profile-a",
        profileIds: ["profile-a", "profile-b"]
      })
    );
    await second.close();

    const verification = new Database(dbPath, { readonly: true });
    expect(verification.pragma("quick_check", { simple: true })).toBe("ok");
    verification.close();
  });

  it("stores project defaults with audit metadata and revokes only their automatic leases", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    const defaultRecord = store.putProjectDefault({
      profileId: "project-a",
      secretId: "secret"
    });
    expect(defaultRecord).toEqual({
      profileId: "project-a",
      secretId: "secret",
      createdAt: NOW,
      updatedAt: NOW
    });
    expect(store.putProjectDefault({
      profileId: "project-a",
      secretId: "secret"
    })).toEqual(defaultRecord);

    store.getOrCreateSessionState("session", {
      profileId: "project-a",
      executionMode: "secure"
    });
    store.createLease({
      leaseId: "manual",
      sessionAgentId: "session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      grantSource: "manual",
      baseRevision: 0
    });
    store.createLease({
      leaseId: "automatic",
      sessionAgentId: "session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      grantSource: "project_default",
      baseRevision: 1
    });
    expect(store.listActiveProjectDefaultLeases("project-a")).toEqual([
      expect.objectContaining({
        leaseId: "automatic",
        grantSource: "project_default"
      })
    ]);

    expect(store.deleteProjectDefault("project-a", "secret")).toBe(true);
    expect(store.getSnapshot("session").leases).toEqual([
      expect.objectContaining({ leaseId: "manual", state: "active" }),
      expect.objectContaining({
        leaseId: "automatic",
        state: "revoked",
        revocationReason: "policy_changed"
      })
    ]);
    const projectPolicyAudit = store.listAudit().filter(({ eventType }) =>
      eventType === "project_default_put" || eventType === "project_default_deleted"
    );
    expect(projectPolicyAudit).toEqual([
      expect.objectContaining({
        eventType: "project_default_put",
        profileId: "project-a",
        secretId: "secret"
      }),
      expect.objectContaining({
        eventType: "project_default_deleted",
        profileId: "project-a",
        secretId: "secret"
      })
    ]);
    expect(JSON.stringify(projectPolicyAudit)).not.toContain("safe-storage-ciphertext");
    expect(JSON.stringify(projectPolicyAudit)).not.toContain("sourceLocator");
    database.close();
  });

  it("persists all-project policy for future projects and revokes only automatic leases on replacement", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    expect(store.replaceAutomaticGrantPolicy({
      secretId: "secret",
      policy: { kind: "all_projects" },
    })).toEqual({ kind: "all_projects" });
    expect(store.listProjectDefaults()).toEqual([]);
    expect(store.listEffectiveProjectDefaults("future-project")).toEqual([
      expect.objectContaining({
        profileId: "future-project",
        secretId: "secret",
      }),
    ]);

    store.getOrCreateSessionState("future-session", {
      profileId: "future-project",
      executionMode: "secure",
    });
    store.createLease({
      leaseId: "manual",
      sessionAgentId: "future-session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      grantSource: "manual",
      baseRevision: 0,
    });
    store.createLease({
      leaseId: "automatic",
      sessionAgentId: "future-session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      grantSource: "project_default",
      baseRevision: 1,
    });

    expect(store.replaceAutomaticGrantPolicy({
      secretId: "secret",
      policy: { kind: "projects", profileIds: ["project-a", "project-b"] },
    })).toEqual({
      kind: "projects",
      profileIds: ["project-a", "project-b"],
    });
    expect(store.getSnapshot("future-session").leases).toEqual([
      expect.objectContaining({ leaseId: "manual", state: "active" }),
      expect.objectContaining({
        leaseId: "automatic",
        state: "revoked",
        revocationReason: "policy_changed",
      }),
    ]);
    expect(store.listEffectiveProjectDefaults("project-a")).toEqual([
      expect.objectContaining({ secretId: "secret" }),
    ]);
    expect(store.listEffectiveProjectDefaults("future-project")).toEqual([]);

    store.replaceAutomaticGrantPolicy({
      secretId: "secret",
      policy: { kind: "all_projects" },
    });
    expect(store.deleteProjectSecretState("project-a")).toEqual({
      projectDefaultsDeleted: 0,
      secretsDeleted: 0,
      secretsUpdated: 0,
      trustedSshHostsDeleted: 0,
    });
    expect(store.getAutomaticGrantPolicy("secret")).toEqual({
      kind: "all_projects",
    });
    database.close();
  });

  it("enforces project ownership, prunes invalid defaults on scope changes, and cleans up projects", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    store.createSecretWithBindings({
      secret: {
        secretId: "project-secret",
        providerId: "local",
        displayAlias: "project-token",
        scopeKind: "profile",
        profileId: "project-a",
        retention: "saved",
        sourceLocator: "local:project-secret",
        encryptedMaterial: Buffer.from("safe-storage-project-ciphertext")
      },
      bindings: [{
        bindingId: "project-binding",
        deliveryKind: "environment",
        targetName: "PROJECT_TOKEN"
      }]
    });
    store.putProjectDefault({ profileId: "project-a", secretId: "project-secret" });
    expect(() => store.putProjectDefault({
      profileId: "project-b",
      secretId: "project-secret"
    })).toThrow(/another project's secret/);

    store.updateSecret({
      secretId: "project-secret",
      providerId: "local",
      displayAlias: "project-token",
      scopeKind: "profile",
      profileId: "project-b",
      retention: "saved",
      sourceLocator: "local:project-secret",
      encryptedMaterial: Buffer.from("safe-storage-project-ciphertext")
    });
    expect(store.listProjectDefaults()).toEqual([]);
    store.putProjectDefault({ profileId: "project-b", secretId: "project-secret" });
    store.putProjectDefault({ profileId: "project-b", secretId: "secret" });
    expect(store.deleteProjectSecretState("project-b")).toEqual({
      projectDefaultsDeleted: 2,
      secretsDeleted: 1,
      secretsUpdated: 0,
      trustedSshHostsDeleted: 0
    });
    expect(store.getSecret("project-secret")).toBeNull();
    expect(store.getSecret("secret")).not.toBeNull();
    expect(store.listProjectDefaults("project-b")).toEqual([]);
    store.putProjectDefault({ profileId: "project-c", secretId: "secret" });
    expect(store.deleteSecret("secret")).toBe(true);
    expect(store.listProjectDefaults("project-c")).toEqual([]);

    store.createSecret({
      secretId: "session-secret",
      providerId: "local",
      displayAlias: "session-token",
      scopeKind: "profile",
      profileId: "project-b",
      retention: "session",
      sourceLocator: "local:session-secret",
      encryptedMaterial: Buffer.from("safe-storage-session-ciphertext")
    });
    expect(() => store.putProjectDefault({
      profileId: "project-b",
      secretId: "session-secret"
    })).toThrow(/Session-only secrets/);
    database.close();
  });

  it("persists multi-project availability and removes only a deleted project association", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    const secret = store.createSecret({
      secretId: "shared-project-secret",
      providerId: "local",
      displayAlias: "shared-token",
      scopeKind: "profile",
      profileIds: ["project-b", "project-a"],
      retention: "saved",
      sourceLocator: "local:shared-project-secret",
      encryptedMaterial: Buffer.from("safe-storage-shared-ciphertext")
    });

    expect(secret).toEqual(expect.objectContaining({
      profileId: "project-a",
      profileIds: ["project-a", "project-b"]
    }));
    store.putProjectDefault({
      profileId: "project-a",
      secretId: secret.secretId
    });
    store.putProjectDefault({
      profileId: "project-b",
      secretId: secret.secretId
    });
    expect(() => store.putProjectDefault({
      profileId: "project-c",
      secretId: secret.secretId
    })).toThrow(/another project's secret/);

    expect(() => store.createSecret({
      secretId: "overlapping-alias",
      providerId: "local",
      displayAlias: "shared-token",
      scopeKind: "profile",
      profileIds: ["project-b", "project-c"],
      retention: "saved",
      sourceLocator: "local:overlapping-alias",
      encryptedMaterial: Buffer.from("safe-storage-overlap-ciphertext")
    })).toThrow(SecureSessionAliasConflictError);
    expect(store.createSecret({
      secretId: "disjoint-alias",
      providerId: "local",
      displayAlias: "shared-token",
      scopeKind: "profile",
      profileIds: ["project-c"],
      retention: "saved",
      sourceLocator: "local:disjoint-alias",
      encryptedMaterial: Buffer.from("safe-storage-disjoint-ciphertext")
    })).toEqual(expect.objectContaining({
      profileIds: ["project-c"]
    }));

    expect(store.deleteProjectSecretState("project-a")).toEqual({
      projectDefaultsDeleted: 1,
      secretsDeleted: 0,
      secretsUpdated: 1,
      trustedSshHostsDeleted: 0
    });
    expect(store.getSecret(secret.secretId)).toEqual(expect.objectContaining({
      profileId: "project-b",
      profileIds: ["project-b"]
    }));
    expect(store.listProjectDefaults("project-b")).toEqual([
      expect.objectContaining({ secretId: secret.secretId })
    ]);

    expect(store.deleteProjectSecretState("project-b")).toEqual({
      projectDefaultsDeleted: 1,
      secretsDeleted: 1,
      secretsUpdated: 0,
      trustedSshHostsDeleted: 0
    });
    expect(store.getSecret(secret.secretId)).toBeNull();
    expect(store.getSecret("disjoint-alias")).not.toBeNull();
    database.close();
  });

  it("atomically selects an existing secret for an alias-miss request and expires stale requests", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    store.getOrCreateSessionState("session", { profileId: "project" });
    store.createRequest({
      requestId: "request",
      sessionAgentId: "session",
      displayAlias: "deploy-token",
      requestedExposures: [{
        deliveryKind: "environment",
        targetName: "TOKEN"
      }],
      requestedLeaseKind: "task",
      purposeSummary: "Deploy",
      requestedByAgentId: "session",
      requestedByDisplayName: "Agent"
    });
    const granted = store.createLease({
      leaseId: "lease",
      sessionAgentId: "session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      requestId: "request",
      baseRevision: 1
    });
    expect(granted.snapshot).toEqual(expect.objectContaining({
      requests: [],
      leases: [expect.objectContaining({
        leaseId: "lease",
        requestId: "request",
        grantSource: "access_request"
      })]
    }));

    store.getOrCreateSessionState("expired-session", { profileId: "project" });
    store.createRequest({
      requestId: "expired-request",
      sessionAgentId: "expired-session",
      secretId: "secret",
      displayAlias: "deploy-token",
      requestedExposures: [{
        deliveryKind: "environment",
        targetName: "TOKEN"
      }],
      requestedLeaseKind: "task",
      purposeSummary: "Deploy",
      requestedByAgentId: "expired-session",
      requestedByDisplayName: "Agent",
      expiresAt: "2026-07-23T11:59:59.000Z"
    });
    expect(() => store.createLease({
      leaseId: "expired-lease",
      sessionAgentId: "expired-session",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      requestId: "expired-request",
      baseRevision: 1
    })).toThrow(SecureSessionRequestExpiredError);
    expect(store.expireRequests(NOW, "expired-session")).toEqual([
      expect.objectContaining({
        changed: true,
        snapshot: expect.objectContaining({ requests: [] })
      })
    ]);
    database.close();
  });

  it("rolls back saved fulfillment and keeps the request pending when lease creation fails", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    store.getOrCreateSessionState("session", { profileId: "project" });
    store.createRequest({
      requestId: "request",
      sessionAgentId: "session",
      displayAlias: "new-token",
      requestedExposures: [{
        deliveryKind: "environment",
        targetName: "NEW_TOKEN"
      }],
      requestedLeaseKind: "task",
      purposeSummary: "Deploy",
      requestedByAgentId: "session",
      requestedByDisplayName: "Agent"
    });

    expect(() => store.withTransaction(() => {
      const created = store.createSecretWithBindings({
        secret: {
          secretId: "new-secret",
          providerId: "local",
          displayAlias: "new-token",
          scopeKind: "profile",
          profileId: "project",
          retention: "saved",
          sourceLocator: "local:new-secret",
          encryptedMaterial: Buffer.from("safe-storage-new-ciphertext")
        },
        bindings: [{
          bindingId: "new-binding",
          deliveryKind: "environment",
          targetName: "NEW_TOKEN"
        }]
      });
      store.putProjectDefault({ profileId: "project", secretId: "new-secret" });
      store.createLease({
        leaseId: "new-lease",
        sessionAgentId: "session",
        secretId: "new-secret",
        requestId: "request",
        bindingIds: created.bindings.map(({ bindingId }) => bindingId),
        leaseKind: "task",
        baseRevision: 0
      });
    })).toThrow(SecureSessionRevisionConflictError);

    expect(store.getSecret("new-secret")).toBeNull();
    expect(store.listProjectDefaults("project")).toEqual([]);
    expect(store.getSnapshot("session")).toEqual(expect.objectContaining({
      state: expect.objectContaining({ revision: 1 }),
      leases: [],
      requests: [expect.objectContaining({
        requestId: "request",
        secretId: null,
        state: "pending"
      })]
    }));
    database.close();
  });

  it("initializes independent team principals and rejects immutable identity drift", () => {
    const { database, store } = createMemoryStore();
    const manager = store.initializePrincipalState("manager", {
      profileId: "project",
      principalKind: "manager",
      executionMode: "secure",
      environmentStatus: "ready"
    });
    const worker = store.initializePrincipalState("worker", {
      profileId: "project",
      principalKind: "worker",
      ownerManagerAgentId: "manager",
      workerAssignmentId: null,
      executionMode: "secure",
      environmentStatus: "ready"
    });

    expect(manager).toEqual(expect.objectContaining({
      principalKind: "manager",
      ownerManagerAgentId: null,
      workerAssignmentId: null
    }));
    expect(worker).toEqual(expect.objectContaining({
      principalKind: "worker",
      ownerManagerAgentId: "manager",
      workerAssignmentId: null
    }));
    expect(store.listPrincipalStatesForManager("manager").map((state) => ({
      sessionAgentId: state.sessionAgentId,
      principalKind: state.principalKind
    }))).toEqual([
      { sessionAgentId: "manager", principalKind: "manager" },
      { sessionAgentId: "worker", principalKind: "worker" }
    ]);
    expect(store.listPrincipalSnapshotsForManager("manager")).toHaveLength(2);

    store.updateWorkerAssignment({
      sessionAgentId: "worker",
      workerAssignmentId: "assignment-1"
    });
    expect(store.initializePrincipalState("worker", {
      profileId: "project",
      principalKind: "worker",
      ownerManagerAgentId: "manager",
      workerAssignmentId: null
    }).workerAssignmentId).toBe("assignment-1");
    expect(() => store.initializePrincipalState("worker", {
      profileId: "other-project",
      principalKind: "worker",
      ownerManagerAgentId: "manager",
      workerAssignmentId: null
    })).toThrow(/principal identity/);
    expect(() => store.getOrCreateSessionState("worker", {
      profileId: "project",
      principalKind: "manager"
    })).toThrow(/principal identity/);
    expect(() => store.updateSessionRuntimeState({
      sessionAgentId: "worker",
      profileId: "other-project"
    })).toThrow(/principal profile/);
    database.close();
  });

  it("keeps legacy worker rows recoverable but rejects new worker-owned requests", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    store.initializePrincipalState("manager", {
      profileId: "project",
      principalKind: "manager"
    });
    store.initializePrincipalState("worker", {
      profileId: "project",
      principalKind: "worker",
      ownerManagerAgentId: "manager",
      workerAssignmentId: "assignment-1"
    });
    store.createLease({
      leaseId: "task",
      sessionAgentId: "worker",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      baseRevision: 0
    });
    store.createLease({
      leaseId: "timed",
      sessionAgentId: "worker",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "timed",
      expiresAt: "2026-07-23T13:00:00.000Z",
      baseRevision: 1
    });
    store.createLease({
      leaseId: "one-use",
      sessionAgentId: "worker",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "one_use",
      baseRevision: 2
    });

    const advanced = store.updateWorkerAssignment({
      sessionAgentId: "worker",
      workerAssignmentId: "assignment-2",
      baseRevision: 3
    });
    expect(advanced).toEqual(expect.objectContaining({
      changed: true,
      revision: 4,
      snapshot: expect.objectContaining({
        state: expect.objectContaining({
          workerAssignmentId: "assignment-2"
        })
      })
    }));
    expect(advanced.snapshot.leases).toEqual([
      expect.objectContaining({ leaseId: "task", state: "active" }),
      expect.objectContaining({ leaseId: "timed", state: "active" }),
      expect.objectContaining({
        leaseId: "one-use",
        state: "revoked",
        revocationReason: "policy_changed"
      })
    ]);
    expect(() => store.createRequest({
      requestId: "old-assignment-request",
      sessionAgentId: "worker",
      workerAssignmentId: "assignment-1",
      displayAlias: "deploy-token",
      requestedExposures: [{ deliveryKind: "stdin" }],
      requestedLeaseKind: "task",
      purposeSummary: "Use a stale assignment",
      requestedByAgentId: "worker",
      requestedByDisplayName: "Worker"
    })).toThrow(/request session authority/);
    expect(() => store.createRequest({
      requestId: "current-request",
      sessionAgentId: "worker",
      workerAssignmentId: "assignment-2",
      displayAlias: "deploy-token",
      requestedExposures: [{ deliveryKind: "stdin" }],
      requestedLeaseKind: "task",
      purposeSummary: "Use the current assignment",
      requestedByAgentId: "worker",
      requestedByDisplayName: "Worker"
    })).toThrow(/request session authority/);
    expect(store.listAudit("worker")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "worker_assignment_updated",
        principalKind: "worker",
        ownerManagerAgentId: "manager",
        workerAssignmentId: "assignment-2"
      })
    ]));
    database.close();
  });

  it("materializes project defaults as distinct principal-owned leases", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    store.putProjectDefault({ profileId: "project", secretId: "secret" });
    store.initializePrincipalState("manager", {
      profileId: "project",
      principalKind: "manager"
    });
    for (const workerId of ["worker-a", "worker-b"]) {
      store.initializePrincipalState(workerId, {
        profileId: "project",
        principalKind: "worker",
        ownerManagerAgentId: "manager",
        workerAssignmentId: null
      });
    }
    for (const [sessionAgentId, leaseId] of [
      ["manager", "manager-default"],
      ["worker-a", "worker-a-default"],
      ["worker-b", "worker-b-default"]
    ] as const) {
      store.createLease({
        leaseId,
        sessionAgentId,
        secretId: "secret",
        bindingIds: ["binding"],
        leaseKind: "task",
        grantSource: "project_default",
        baseRevision: 0
      });
    }

    expect(store.listActiveProjectDefaultLeases("project").map((lease) => ({
      leaseId: lease.leaseId,
      sessionAgentId: lease.sessionAgentId
    }))).toEqual([
      { leaseId: "manager-default", sessionAgentId: "manager" },
      { leaseId: "worker-a-default", sessionAgentId: "worker-a" },
      { leaseId: "worker-b-default", sessionAgentId: "worker-b" }
    ]);
    expect(() => store.createLease({
      leaseId: "duplicate-manager-default",
      sessionAgentId: "manager",
      secretId: "secret",
      bindingIds: ["binding"],
      leaseKind: "task",
      grantSource: "project_default",
      baseRevision: 1
    })).toThrow(/UNIQUE constraint/);
    expect(store.getSnapshot("manager").state.revision).toBe(1);
    database.close();
  });

  it("reports a stable domain conflict for duplicate aliases in one scope", () => {
    const { database, store } = createMemoryStore();
    seedLocalCatalog(store);
    expect(() => store.createSecret({
      secretId: "duplicate",
      providerId: "local",
      displayAlias: "deploy-token",
      scopeKind: "instance",
      retention: "saved",
      sourceLocator: "local:duplicate",
      encryptedMaterial: Buffer.from("safe-storage-duplicate-ciphertext")
    })).toThrow(SecureSessionAliasConflictError);
    database.close();
  });
});

function createMemoryStore(): {
  database: Database.Database;
  store: SecureSessionStore;
} {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runSecureSessionMigrations(database);
  return {
    database,
    store: new SecureSessionStore(database, undefined, () => new Date(NOW))
  };
}

function seedLocalCatalog(store: SecureSessionStore): void {
  store.upsertProvider({
    providerId: "local",
    kind: "local_keychain",
    displayName: "Local"
  });
  store.createSecretWithBindings({
    secret: {
      secretId: "secret",
      providerId: "local",
      displayAlias: "deploy-token",
      scopeKind: "instance",
      retention: "saved",
      sourceLocator: "local:secret",
      encryptedMaterial: Buffer.from("safe-storage-ciphertext")
    },
    bindings: [{
      bindingId: "binding",
      deliveryKind: "environment",
      targetName: "TOKEN"
    }]
  });
}
