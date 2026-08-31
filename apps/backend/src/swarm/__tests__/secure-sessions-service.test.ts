import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  type AgentDescriptor,
  type SecureSessionSnapshotEvent,
} from "@forge/protocol";
import type {
  SecureExecutionBackend,
  SecureExecutionRequest,
  SecureExecutionTask,
} from "../secure-sessions/execution/secure-execution-backend.js";
import { SecureExecutionError } from "../secure-sessions/execution/secure-execution-error.js";
import {
  SECURE_OUTPUT_QUARANTINE,
  SecureValueGuard,
} from "../secure-sessions/redaction/secure-value-guard.js";
import { SecureSessionsService } from "../secure-sessions/secure-sessions-service.js";
import type { SecureVaultCipher } from "../secure-sessions/sources/electron-safe-storage-client.js";
import type {
  BitwardenPasswordManagerCollection,
  BitwardenPasswordManagerItemMetadata,
  BitwardenPasswordManagerSource,
  BitwardenPasswordManagerStatus,
} from "../secure-sessions/sources/bitwarden-password-manager-source.js";
import {
  HostOnlySecret,
  SecureSourceError,
  type SecureSecretSource,
} from "../secure-sessions/sources/host-only-secret.js";
import { runSecureSessionMigrations } from "../secure-sessions/storage/secure-session-migrations.js";
import { SecureSessionStore } from "../secure-sessions/storage/secure-session-store.js";

const NOW = "2026-07-23T12:00:00.000Z";
const ALPHA = "alpha-secret-3f4d2c";
const BETA = "beta-secret-8e7a1b";

function testBitwardenCliSummary() {
  return {
    state: "ready" as const,
    source: "system" as const,
    executablePath: "/usr/local/bin/bw",
    configuredExecutablePath: null,
    version: "2026.8.0",
    managedVersion: "2026.8.0",
    canInstall: true,
  };
}

describe("SecureSessionsService", () => {
  it("exports and transactionally re-seals machine-bound vault material", async () => {
    const harness = createHarness();
    const local = await harness.service.createLocalSecureSecret({
      displayAlias: "migration/local",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      scope: { kind: "instance" },
    });
    await harness.service.connectBitwardenSecureSecretProvider({
      displayName: "Migration provider",
      serverOrigin: "https://vault.example.test",
      encryptedAccessToken: Buffer.from("synthetic-bws-token").toString("base64"),
    });

    const exported = await harness.service.exportSecureVaultTransfer();
    expect(exported).toMatchObject({
      localSecretCount: 1,
      providerCredentialCount: 1,
    });
    expect(exported.bundle.itemCount).toBe(2);
    expect(JSON.stringify(exported.bundle)).not.toContain(ALPHA);
    expect(JSON.stringify(exported.bundle)).not.toContain("synthetic-bws-token");

    await expect(harness.service.importSecureVaultTransfer({
      bundle: exported.bundle,
      transferCode: exported.transferCode,
    })).resolves.toEqual({
      importedItemCount: 2,
      localSecretCount: 1,
      providerCredentialCount: 1,
    });

    const wrongCode = `${exported.transferCode.slice(0, -1)}${
      exported.transferCode.endsWith("A") ? "B" : "A"
    }`;
    await expect(harness.service.importSecureVaultTransfer({
      bundle: exported.bundle,
      transferCode: wrongCode,
    })).rejects.toMatchObject({ code: "SECURE_VAULT_TRANSFER_INVALID" });

    await harness.service.updateSecureSecret(local.secretId, {
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
    });
    await expect(harness.service.importSecureVaultTransfer({
      bundle: exported.bundle,
      transferCode: exported.transferCode,
    })).rejects.toMatchObject({ code: "SECURE_VAULT_TRANSFER_MISMATCH" });
    const stillUpdated = harness.store.getEncryptedSecret(local.secretId);
    expect(stillUpdated?.encryptedMaterial?.toString("utf8")).toBe(BETA);
    stillUpdated?.encryptedMaterial?.fill(0);
    await harness.close();
  });

  it("seals a bounded trusted-browser private entry", async () => {
    const harness = createHarness();
    const encodedValue = Buffer.from(ALPHA).toString("base64");

    await expect(
      harness.service.encryptTrustedBrowserPrivateEntry(encodedValue),
    ).resolves.toBe(encodedValue);
    await expect(
      harness.service.encryptTrustedBrowserPrivateEntry(`${encodedValue}=`),
    ).rejects.toThrow("SECURE_REQUEST_INVALID");
    await harness.close();
  });

  it("unlocks Password Manager from encrypted private entry without persisting the password", async () => {
    const collection = {
      id: "11111111-1111-4111-8111-111111111111",
      organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Infrastructure",
    };
    const harness = createHarness({
      passwordManagerCollections: [collection],
    });
    const provider = await harness.service.connectBitwardenPasswordManager({
      displayName: "Team Bitwarden",
    });
    expect(provider).toMatchObject({
      kind: "bitwarden_password_manager",
      status: "locked",
      lastStatusCode: "source_locked",
    });

    const settings = await harness.service.unlockBitwardenPasswordManager(
      provider.providerId,
      {
        encryptedMasterPassword: Buffer.from("synthetic-master-password")
          .toString("base64"),
      },
    );
    expect(settings).toEqual({
      providerId: provider.providerId,
      accountEmail: null,
      serverUrl: null,
      cli: {
        state: "ready",
        source: "system",
        executablePath: "/usr/local/bin/bw",
        configuredExecutablePath: null,
        version: "2026.8.0",
        managedVersion: "2026.8.0",
        canInstall: true,
      },
      collections: [{
        collectionId: collection.id,
        organizationId: collection.organizationId,
        name: collection.name,
        selected: false,
      }],
    });
    expect(harness.passwordManagerUnlocks).toEqual(["synthetic-master-password"]);
    expect(harness.store.getProviderBackendConfig(provider.providerId)).toBeNull();
    expect(JSON.stringify(harness.store.listProviders())).not.toContain(
      "synthetic-master-password",
    );
    await harness.close();
  });

  it("installs a managed Password Manager CLI or persists a custom executable path", async () => {
    const harness = createHarness();
    const provider = await harness.service.connectBitwardenPasswordManager({
      displayName: "Team Bitwarden",
    });

    const installed = await harness.service.installBitwardenPasswordManagerCli(
      provider.providerId,
    );
    expect(installed.cli).toEqual(expect.objectContaining({
      state: "ready",
      source: "managed",
      executablePath: "/forge/managed/bw",
      configuredExecutablePath: null,
    }));
    expect(harness.passwordManagerCliInstalls).toHaveLength(1);
    expect(harness.store.getProvider(provider.providerId)?.cliExecutablePath).toBeNull();

    const customPath = "C:\\Tools\\Bitwarden CLI\\bw.exe";
    const configured = await harness.service.updateBitwardenPasswordManagerCli(
      provider.providerId,
      { executablePath: customPath },
    );
    expect(configured.cli).toEqual(expect.objectContaining({
      state: "ready",
      source: "configured",
      executablePath: customPath,
      configuredExecutablePath: customPath,
    }));
    expect(harness.passwordManagerStatusPaths).toContain(customPath);
    expect(harness.store.getProvider(provider.providerId)?.cliExecutablePath).toBe(
      customPath,
    );

    await harness.service.updateBitwardenPasswordManagerCli(
      provider.providerId,
      { executablePath: null },
    );
    expect(harness.store.getProvider(provider.providerId)?.cliExecutablePath).toBeNull();
    await harness.close();
  });

  it("synchronizes several Password Manager collections into requestable catalog metadata", async () => {
    const collections = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Infrastructure",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Development",
      },
    ];
    const items: BitwardenPasswordManagerItemMetadata[] = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Ansible Vault",
        collectionIds: [collections[0]!.id],
        revisionDate: NOW,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "GitHub Work Token",
        collectionIds: [collections[1]!.id],
        revisionDate: NOW,
      },
    ];
    const harness = createHarness({
      passwordManagerStatus: {
        state: "available",
        accountEmail: "forge@example.test",
        serverUrl: "https://vault.example.test",
        cli: testBitwardenCliSummary(),
      },
      passwordManagerCollections: collections,
      passwordManagerItems: items,
    });
    const provider = await harness.service.connectBitwardenPasswordManager({
      displayName: "Team Bitwarden",
    });
    const result = await harness.service.replaceBitwardenPasswordManagerCollections(
      provider.providerId,
      { collectionIds: collections.map(({ id }) => id) },
    );

    expect(result).toMatchObject({ addedSecrets: 2, removedSecrets: 0 });
    expect(harness.passwordManagerSyncs).toHaveLength(1);
    expect(result.settings.collections).toEqual([
      expect.objectContaining({ name: "Development", selected: true }),
      expect.objectContaining({ name: "Infrastructure", selected: true }),
    ]);
    expect(harness.store.listSecrets(provider.providerId)).toEqual([
      expect.objectContaining({
        displayAlias: "bitwarden/ansible-vault-33333333",
        displayName: "Ansible Vault",
        sourceLocator: items[0]!.id,
        retention: "saved",
        scopeKind: "instance",
      }),
      expect.objectContaining({
        displayAlias: "bitwarden/github-work-token-44444444",
        displayName: "GitHub Work Token",
        sourceLocator: items[1]!.id,
        retention: "saved",
        scopeKind: "instance",
      }),
    ]);
    expect(harness.store.listProjectDefaults()).toEqual([]);

    await expect(
      harness.service.replaceBitwardenPasswordManagerCollections(
        provider.providerId,
        { collectionIds: ["99999999-9999-4999-8999-999999999999"] },
      ),
    ).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    expect(harness.store.getProvider(provider.providerId)?.status).toBe("available");

    const syncedSecret = harness.store.listSecrets(provider.providerId)[0]!;
    const started = await harness.service.startSecureSession("manager-a");
    const granted = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: syncedSecret.secretId,
      exposures: [{
        deliveryKind: "environment",
        targetName: syncedSecret.bindings[0]!.targetName!,
      }],
      leaseKind: "task",
    });
    expect(granted.leases).toHaveLength(1);
    await expect(
      harness.service.lockBitwardenPasswordManager(provider.providerId),
    ).resolves.toMatchObject({ status: "locked", lastStatusCode: "source_locked" });
    expect(harness.store.getSnapshot("manager-a").leases).toEqual([
      expect.objectContaining({ state: "revoked", revocationReason: "policy_changed" }),
    ]);
    await harness.close();
  });

  it("persists local key rotation without revoking the newly active lease", async () => {
    const harness = createHarness({
      rotatedLocalCiphertext: "current-local-ciphertext",
    });
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "rotating_secret",
      encryptedMaterial: Buffer.from("legacy-local-ciphertext").toString("base64"),
      scope: { kind: "instance" },
    });
    const catalogBeforeGrant = harness.store.getCatalogState();

    const started = await harness.service.startSecureSession("manager-a");
    const binding = secret.bindings[0]!;
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{
        deliveryKind: binding.deliveryKind,
        ...(binding.targetName ? { targetName: binding.targetName } : {}),
        ...(binding.targetPath ? { targetPath: binding.targetPath } : {}),
        ...(binding.fileMode ? { fileMode: binding.fileMode } : {}),
      }],
      leaseKind: "task",
    });

    const encrypted = harness.store.getEncryptedSecret(secret.secretId);
    expect(encrypted?.encryptedMaterial).toEqual(
      Buffer.from("current-local-ciphertext"),
    );
    expect(harness.store.getCatalogState()).toEqual(catalogBeforeGrant);
    expect(harness.store.getSnapshot("manager-a").leases).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        state: "active",
      }),
    ]);
    encrypted?.encryptedMaterial?.fill(0);
    await harness.close();
  });

  it("creates a stable automatic delivery for secrets saved without bindings", async () => {
    const harness = createHarness();
    const created = await harness.service.createLocalSecureSecret({
      displayAlias: "server/password",
      note: "Rotated by the infrastructure team.",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
    });

    expect(created.note).toBe("Rotated by the infrastructure team.");
    expect(created.bindings).toEqual([expect.objectContaining({
      deliveryKind: "environment",
      targetName: expect.stringMatching(/^FORGE_SECRET_SERVER_PASSWORD_[A-Z0-9]+$/),
    })]);
    const originalBinding = created.bindings[0];

    const renamed = await harness.service.updateSecureSecret(created.secretId, {
      displayAlias: "renamed/password",
      note: null,
    });
    expect(renamed.note).toBeNull();
    expect(renamed.bindings).toEqual([originalBinding]);
    await harness.close();
  });

  it("accepts an agent-proposed SSH key and delivers it through SSH_AUTH_SOCK", async () => {
    const harness = createHarness();
    await harness.service.requestSecureSecretAccess("manager-a", "ssh-tool", {
      displayAlias: "deployment-key",
      exposures: [{ deliveryKind: "ssh_agent" }],
      leaseKind: "task",
      purposeSummary: "Authenticate an approved SSH connection.",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    const approved = await harness.service.fulfillSecureAccessRequest(
      "manager-a",
      pending.pendingRequests[0]!.requestId,
      {
        baseRevision: pending.revision,
        displayAlias: "deployment-key",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        exposures: [{ deliveryKind: "ssh_agent" }],
        retention: "saved",
        scope: { kind: "profile", profileId: "profile-a" },
        leaseKind: "task",
      },
    );

    expect(approved.leases).toEqual([
      expect.objectContaining({
        exposures: [{ deliveryKind: "ssh_agent" }],
        status: "active",
      }),
    ]);
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    await binding.executeBash({
      secretAliases: ["deployment-key"],
      command: "safe-ssh-agent-use",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    expect(harness.execution.sshAgentDeliveryValues.at(-1)).toEqual([ALPHA]);
    await harness.close();
  });

  it("delivers only the selected automatic SSH keys for each command", async () => {
    const harness = createHarness();
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "ssh-alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "ssh_agent" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "ssh-beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "ssh_agent" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(alpha.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await harness.service.setSecureSecretProjectDefault(beta.secretId, {
      profileId: "profile-a",
      enabled: true,
    });

    const started = await harness.service.startSecureSession("manager-a");
    expect(started.leases).toHaveLength(2);
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    await binding.executeBash({
      secretAliases: ["ssh-alpha"],
      command: "safe-multiple-ssh-agent-use",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    expect(harness.execution.sshAgentDeliveryValues.at(-1)).toEqual([ALPHA]);
    await binding.executeBash({
      secretAliases: ["ssh-alpha", "ssh-beta"],
      command: "safe-multiple-ssh-agent-use",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    expect(new Set(harness.execution.sshAgentDeliveryValues.at(-1))).toEqual(
      new Set([ALPHA, BETA]),
    );
    await harness.close();
  });

  it("keeps unrelated SSH keys out of a password-only command", async () => {
    const harness = createHarness();
    const sshKey = await harness.service.createLocalSecureSecret({
      displayAlias: "unrelated-key",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "ssh_agent" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    const password = await harness.service.createLocalSecureSecret({
      displayAlias: "server-password",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SERVER_PASSWORD" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(sshKey.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await harness.service.setSecureSecretProjectDefault(password.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await harness.service.startSecureSession("manager-a");

    await harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!.executeBash({
      secretAliases: ["server-password"],
      command: "safe-password-use",
      cwd: "/workspace-a",
      onData: () => undefined,
    });

    expect(harness.execution.sshAgentDeliveryValues.at(-1)).toEqual([]);
    expect(harness.execution.environmentDeliveryNames.at(-1))
      .toEqual(["SERVER_PASSWORD"]);
    await harness.close();
  });

  it("backfills a default delivery for legacy secrets that have no bindings", async () => {
    const harness = createHarness();
    const created = await harness.service.createLocalSecureSecret({
      displayAlias: "legacy/password",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
    });
    const [existingBinding] = harness.store.listBindings(created.secretId);
    expect(existingBinding).toBeDefined();
    harness.store.deleteBinding(existingBinding!.bindingId);
    expect(harness.store.listBindings(created.secretId)).toEqual([]);

    await harness.service.initializeSecureSessions();

    const backfilledBindings = harness.store.listBindings(created.secretId);
    expect(backfilledBindings).toEqual([
      expect.objectContaining({
        deliveryKind: "environment",
        targetName: expect.stringMatching(/^FORGE_SECRET_LEGACY_PASSWORD_[A-Z0-9]+$/),
      }),
    ]);
    await harness.service.initializeSecureSessions();
    expect(harness.store.listBindings(created.secretId)).toEqual(backfilledBindings);
    await harness.close();
  });

  it("recovers every stale sandbox once before authorizing secure execution", async () => {
    const harness = createHarness({ recoveredSandboxIds: ["stale-a", "stale-b"] });

    await expect(harness.service.initializeSecureSessions()).resolves.toEqual({
      destroyedSandboxIds: ["stale-a", "stale-b"],
    });
    await harness.service.startSecureSession("manager-a");
    await harness.service.startSecureSession("manager-b");

    expect(harness.execution.recoveryCalls).toEqual([[]]);
    expect(harness.execution.ensured).toEqual(["manager-a", "manager-b"]);
    await harness.close();
  });

  it("returns an unlocked Password Manager source to locked after restart recovery", async () => {
    const harness = createHarness({
      passwordManagerStatus: {
        state: "available",
        accountEmail: "forge@example.com",
        serverUrl: "https://vault.bitwarden.com",
        cli: testBitwardenCliSummary(),
      },
    });
    const provider = await harness.service.connectBitwardenPasswordManager({
      displayName: "Bitwarden Password Manager",
    });
    expect(harness.store.getProvider(provider.providerId)?.status).toBe("available");

    await harness.service.initializeSecureSessions();

    expect(harness.store.getProvider(provider.providerId)).toEqual(
      expect.objectContaining({
        status: "locked",
        lastStatusCode: "source_locked",
      }),
    );
    await harness.close();
  });

  it("removes legacy worker principals during manager-authority startup recovery", async () => {
    const harness = createHarness();
    harness.store.initializePrincipalState("manager-a", {
      profileId: "profile-a",
      principalKind: "manager",
      ownerManagerAgentId: null,
      workerAssignmentId: null,
      executionMode: "secure",
      environmentStatus: "ready",
    });
    harness.store.initializePrincipalState("legacy-worker", {
      profileId: "profile-a",
      principalKind: "worker",
      ownerManagerAgentId: "manager-a",
      workerAssignmentId: "legacy-assignment",
      executionMode: "secure",
      environmentStatus: "ready",
    });

    await harness.service.initializeSecureSessions();

    expect(harness.store.getSessionState("legacy-worker")).toBeNull();
    expect(harness.store.getSessionState("manager-a")).toEqual(
      expect.objectContaining({
        principalKind: "manager",
        executionMode: "standard",
        environmentStatus: "stopped",
      }),
    );
    expect(harness.execution.recoveryCalls).toEqual([[]]);
    await harness.close();
  });

  it("keeps secure execution fail-closed until startup recovery can succeed", async () => {
    const harness = createHarness({ recoveryFailures: 1 });

    await expect(
      harness.service.startSecureSession("manager-a"),
    ).rejects.toThrow("SECURE_OPERATION_FAILED");
    expect(harness.execution.ensured).toEqual([]);
    expect(harness.execution.recoveryCalls).toHaveLength(1);

    await expect(harness.service.startSecureSession("manager-a")).resolves.toEqual(
      expect.objectContaining({
        executionMode: "secure",
        environmentStatus: "ready",
      }),
    );
    expect(harness.execution.recoveryCalls).toHaveLength(2);
    expect(harness.execution.ensured).toEqual(["manager-a"]);
    await harness.close();
  });

  it("blocks lifecycle deletion until persisted orphan recovery succeeds", async () => {
    const harness = createHarness({ recoveryFailures: 1 });
    harness.store.getOrCreateSessionState("manager-a", {
      profileId: "profile-a",
      executionMode: "secure",
      environmentStatus: "ready",
    });

    await expect(harness.service.stopSecureSessionForLifecycle(
      "manager-a",
      { deleteState: true },
    )).rejects.toThrow("SECURE_OPERATION_FAILED");
    expect(harness.store.listSessionStates().some(
      (state) => state.sessionAgentId === "manager-a",
    )).toBe(true);

    await expect(harness.service.stopSecureSessionForLifecycle(
      "manager-a",
      { deleteState: true },
    )).resolves.toBeUndefined();
    expect(harness.store.listSessionStates().some(
      (state) => state.sessionAgentId === "manager-a",
    )).toBe(false);
    expect(harness.execution.recoveryCalls).toHaveLength(2);
    await harness.close();
  });

  it("deletes ordinary stopped session metadata without requiring Docker", async () => {
    const harness = createHarness({ recoveryFailures: 1 });
    harness.store.getOrCreateSessionState("manager-a", {
      profileId: "profile-a",
      executionMode: "standard",
      environmentStatus: "stopped",
    });

    await expect(harness.service.stopSecureSessionForLifecycle(
      "manager-a",
      { deleteState: true },
    )).resolves.toBeUndefined();
    expect(harness.execution.recoveryCalls).toEqual([]);
    expect(harness.store.listSessionStates()).toEqual([]);
    await harness.close();
  });

  it("fences secure authority during lifecycle teardown and cancellation restores it", async () => {
    const harness = createHarness();
    const grantedSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "lifecycle-grant",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "LIFECYCLE_GRANT" }],
    });
    const defaultSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "lifecycle-default",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "LIFECYCLE_DEFAULT" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.requestSecureSecretAccess("manager-a", "lifecycle-tool", {
      displayAlias: "lifecycle-missing",
      exposures: [{ deliveryKind: "environment", targetName: "LIFECYCLE_MISSING" }],
      leaseKind: "task",
      purposeSummary: "Exercise lifecycle fencing",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    const fenceId = await harness.service.beginSecureSessionLifecycleFence(
      "profile-a",
      ["manager-a"],
    );

    await expect(harness.service.startSecureSession("manager-a"))
      .rejects.toMatchObject({ code: "SECURE_OPERATION_FAILED" });
    await expect(harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: pending.revision,
      secretId: grantedSecret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "LIFECYCLE_GRANT" }],
      leaseKind: "task",
    })).rejects.toMatchObject({ code: "SECURE_OPERATION_FAILED" });
    await expect(harness.service.fulfillSecureAccessRequest(
      "manager-a",
      pending.pendingRequests[0]!.requestId,
      {
        baseRevision: pending.revision,
        displayAlias: "lifecycle-missing",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        exposures: [{
          deliveryKind: "environment",
          targetName: "LIFECYCLE_MISSING",
        }],
        retention: "saved",
        scope: { kind: "profile", profileId: "profile-a" },
        makeProjectDefault: true,
        leaseKind: "task",
      },
    )).rejects.toMatchObject({ code: "SECURE_OPERATION_FAILED" });
    await expect(harness.service.setSecureSecretProjectDefault(
      defaultSecret.secretId,
      { profileId: "profile-a", enabled: true },
    )).rejects.toMatchObject({ code: "SECURE_OPERATION_FAILED" });
    await expect(harness.service.createLocalSecureSecret({
      displayAlias: "lifecycle-profile-create",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      scope: { kind: "profile", profileId: "profile-a" },
    })).rejects.toMatchObject({ code: "SECURE_OPERATION_FAILED" });

    await expect(harness.service.prepareSecureSessionForDeletion("manager-a"))
      .resolves.toBeUndefined();
    const stopped = harness.store.getSnapshot("manager-a");
    expect(stopped.state.environmentStatus).toBe("stopped");
    expect(stopped.requests).toEqual([
      expect.objectContaining({ requestId: pending.pendingRequests[0]!.requestId }),
    ]);
    expect(harness.execution.destroyed).toContain("manager-a");

    await harness.service.cancelSecureSessionLifecycleFence(fenceId);
    await expect(harness.service.startSecureSession("manager-a"))
      .resolves.toEqual(expect.objectContaining({
        executionMode: "secure",
        environmentStatus: "ready",
      }));
    expect(started.executionMode).toBe("secure");
    await harness.close();
  });

  it("uses durable archive callbacks after the transient lifecycle fence completes", async () => {
    const harness = createHarness();
    const fenceId = await harness.service.beginSecureSessionLifecycleFence(
      "profile-a",
      ["manager-a"],
    );
    await harness.service.completeSecureSessionLifecycleFence(
      fenceId,
      "archived",
    );
    harness.archivedSessions.add("manager-a");

    await expect(harness.service.startSecureSession("manager-a"))
      .rejects.toMatchObject({ code: "SECURE_OPERATION_FAILED" });
    harness.archivedSessions.delete("manager-a");
    harness.archivedProfiles.add("profile-a");
    await expect(harness.service.startSecureSession("manager-a"))
      .rejects.toMatchObject({ code: "SECURE_OPERATION_FAILED" });

    harness.archivedProfiles.delete("profile-a");
    await harness.service.clearSecureSessionLifecycleFenceForRestore(
      "profile-a",
      ["manager-a"],
    );
    await expect(harness.service.startSecureSession("manager-a"))
      .resolves.toEqual(expect.objectContaining({
        executionMode: "secure",
        environmentStatus: "ready",
      }));
    await harness.close();
  });

  it("preserves session secrets until descriptor-independent post-core cleanup", async () => {
    const harness = createHarness();
    await harness.service.requestSecureSecretAccess("manager-a", "delete-tool", {
      displayAlias: "delete-session-secret",
      exposures: [{ deliveryKind: "environment", targetName: "DELETE_SESSION_SECRET" }],
      leaseKind: "task",
      purposeSummary: "Exercise deletion ordering",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    await harness.service.fulfillSecureAccessRequest(
      "manager-a",
      pending.pendingRequests[0]!.requestId,
      {
        baseRevision: pending.revision,
        displayAlias: "delete-session-secret",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        exposures: [{
          deliveryKind: "environment",
          targetName: "DELETE_SESSION_SECRET",
        }],
        retention: "session",
        leaseKind: "task",
      },
    );
    const fenceId = await harness.service.beginSecureSessionLifecycleFence(
      "profile-a",
      ["manager-a"],
    );

    await harness.service.prepareSecureSessionForDeletion("manager-a");
    expect(harness.store.listSecrets().some(
      (secret) => secret.retention === "session",
    )).toBe(true);
    expect(harness.store.listSessionStates().some(
      (state) => state.sessionAgentId === "manager-a",
    )).toBe(true);

    harness.descriptors.delete("manager-a");
    await harness.service.deleteSecureSessionStateAfterCoreDeletion("manager-a");
    await harness.service.completeSecureSessionLifecycleFence(fenceId, "deleted");
    expect(harness.store.listSecrets().some(
      (secret) => secret.retention === "session",
    )).toBe(false);
    expect(harness.store.listSessionStates().some(
      (state) => state.sessionAgentId === "manager-a",
    )).toBe(false);
    await harness.close();
  });

  it("reconciles orphaned project and session secret state during startup", async () => {
    const harness = createHarness();
    const instanceSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "surviving-instance",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
    });
    const projectSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "orphaned-project",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(projectSecret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    harness.store.getOrCreateSessionState("missing-session", {
      profileId: "missing-profile",
      executionMode: "standard",
      environmentStatus: "stopped",
    });
    harness.store.createSecretWithBindings({
      secret: {
        secretId: "orphaned-session-secret",
        providerId: instanceSecret.providerId,
        displayAlias: "orphaned-session",
        scopeKind: "profile",
        profileId: "missing-profile",
        retention: "session",
        sourceLocator: "session:missing-session",
        encryptedMaterial: Buffer.from(ALPHA),
      },
      bindings: [{
        bindingId: "orphaned-session-binding",
        deliveryKind: "environment",
        targetName: "ORPHANED_SESSION",
      }],
    });
    harness.descriptors.delete("manager-a");

    await harness.service.initializeSecureSessions();

    expect(harness.store.listSecrets()).toEqual([
      expect.objectContaining({ secretId: instanceSecret.secretId }),
    ]);
    expect(harness.store.listProjectDefaults()).toEqual([]);
    expect(harness.store.listSessionStates()).toEqual([]);
    await harness.close();
  });

  it("continues shutdown cleanup after one task destroy fails", async () => {
    const harness = createHarness({ destroyFailures: ["manager-a"] });
    await harness.service.startSecureSession("manager-a");
    await harness.service.startSecureSession("manager-b");

    await expect(harness.service.closeSecureSessions()).resolves.toBeUndefined();
    expect(harness.execution.destroyed).toEqual(
      expect.arrayContaining(["manager-a", "manager-b"]),
    );
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeUndefined();
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-b")!,
    )).toBeUndefined();
  });

  it("drains an admitted start before taking the final shutdown task snapshot", async () => {
    const harness = createHarness({ blockEnsures: ["manager-a"] });
    const starting = harness.service.startSecureSession("manager-a");
    await harness.execution.waitForBlockedEnsure("manager-a");

    const closing = harness.service.closeSecureSessions();
    await Promise.resolve();
    expect(harness.execution.destroyed).not.toContain("manager-a");

    harness.execution.releaseBlockedEnsure("manager-a");
    await expect(starting).resolves.toEqual(expect.objectContaining({
      executionMode: "secure",
      environmentStatus: "ready",
    }));
    await expect(closing).resolves.toBeUndefined();
    expect(harness.execution.destroyed).toContain("manager-a");
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeUndefined();
  });

  it("keeps explicit stop authoritative over an in-flight execution failure", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    harness.execution.destroyed.length = 0;
    const execution = binding.executeBash({
      secretAliases: [],
      command: "wait-for-destroy",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await vi.waitFor(() => {
      expect(harness.execution.hasBlockedExecution("manager-a")).toBe(true);
    });
    const snapshot = await harness.service.getSecureSessionSnapshot("manager-a");
    const stopping = harness.service.stopSecureSession("manager-a", {
      baseRevision: snapshot.revision,
      stopProcesses: true,
    });
    await vi.waitFor(() => {
      expect(harness.execution.destroyed).toContain("manager-a");
    });
    harness.execution.rejectBlockedExecution("manager-a");

    await expect(execution).rejects.toThrow("SECURE_OPERATION_FAILED");
    await expect(stopping).resolves.toEqual(expect.objectContaining({
      executionMode: "standard",
      environmentStatus: "stopped",
    }));
    expect(
      await harness.service.getSecureSessionSnapshot("manager-a"),
    ).toEqual(expect.objectContaining({
      executionMode: "standard",
      environmentStatus: "stopped",
    }));
    await harness.close();
  });

  it("keeps revoke authoritative over an in-flight execution failure", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    harness.execution.destroyed.length = 0;
    const execution = binding.executeBash({
      secretAliases: [],
      command: "wait-for-destroy",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await vi.waitFor(() => {
      expect(harness.execution.hasBlockedExecution("manager-a")).toBe(true);
    });
    const snapshot = await harness.service.getSecureSessionSnapshot("manager-a");
    const revoking = harness.service.revokeSecureSessionLease("manager-a", {
      baseRevision: snapshot.revision,
      leaseId: snapshot.leases[0]!.leaseId,
    });
    await vi.waitFor(() => {
      expect(harness.execution.destroyed).toContain("manager-a");
    });
    harness.execution.rejectBlockedExecution("manager-a");

    await expect(execution).rejects.toThrow("SECURE_OPERATION_FAILED");
    await expect(revoking).resolves.toEqual(expect.objectContaining({
      executionMode: "secure",
      environmentStatus: "stopped",
      leases: [expect.objectContaining({ status: "revoked" })],
    }));
    await harness.close();
  });

  it("does not revoke an active lease while recording a provider health check", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const before = await harness.service.getSecureSessionSnapshot("manager-a");
    const destroysBefore = harness.execution.destroyed.length;

    await expect(
      harness.service.testSecureSecretProvider("forge-local-keychain"),
    ).resolves.toEqual(expect.objectContaining({
      code: "ok",
      affectedSecrets: [],
      provider: expect.objectContaining({
        providerId: "forge-local-keychain",
        status: "available",
      }),
    }));

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.leases).toEqual([
      expect.objectContaining({
        leaseId: before.leases[0]!.leaseId,
        status: "active",
      }),
    ]);
    expect(after.environmentStatus).toBe("ready");
    expect(harness.execution.destroyed).toHaveLength(destroysBefore);
    await harness.close();
  });

  it("heals stale local-vault health when a project default resolves successfully", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "recovered-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{
        deliveryKind: "environment",
        targetName: "RECOVERED_DEFAULT",
      }],
    });
    await harness.service.setSecureSecretProjectDefault(secret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    harness.store.updateProviderStatus({
      providerId: "forge-local-keychain",
      status: "unreachable",
      lastStatusCode: "source_unreachable",
      lastVerifiedAt: NOW,
    });

    expect(await harness.service.listSecureSecrets()).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        available: false,
      }),
    ]);

    await expect(harness.service.startSecureSession("manager-a")).resolves
      .toEqual(expect.objectContaining({
        leases: [expect.objectContaining({
          secretId: secret.secretId,
          status: "active",
          grantSource: "project_default",
        })],
        projectDefaults: [expect.objectContaining({
          secretId: secret.secretId,
          state: "active",
          statusCode: "ok",
        })],
      }));
    await expect(harness.service.listSecureSecretProviders()).resolves.toEqual([
      expect.objectContaining({
        providerId: "forge-local-keychain",
        status: "available",
        lastStatusCode: "ok",
      }),
    ]);
    expect(await harness.service.listSecureSecrets()).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        available: true,
      }),
    ]);
    await harness.close();
  });

  it("reports secure execution readiness with fixed codes and sanitizes probe failures", async () => {
    const unavailable = createHarness({
      probeAvailability: {
        available: false,
        code: "image_unavailable",
      },
    });
    await expect(unavailable.service.getSecureSessionReadiness()).resolves.toEqual({
      available: false,
      code: "image_unavailable",
    });
    await unavailable.close();

    const failed = createHarness({ probeThrows: true });
    await expect(failed.service.getSecureSessionReadiness()).resolves.toEqual({
      available: false,
      code: "backend_unavailable",
    });
    await failed.close();
  });

  it("installs the secure runner through fixed readiness metadata", async () => {
    const installed = createHarness({
      installAvailability: {
        available: true,
        code: "available",
      },
    });
    await expect(installed.service.installSecureRunner()).resolves.toEqual({
      available: true,
      code: "available",
    });
    await installed.close();

    const failed = createHarness({ installThrows: true });
    await expect(failed.service.installSecureRunner()).resolves.toEqual({
      available: false,
      code: "image_unavailable",
    });
    await failed.close();
  });

  it("tests every saved local ciphertext, releases successful plaintexts, and reports safe failures", async () => {
    const harness = createHarness({
      failSourceMaterials: [BETA, "session-only"],
    });
    const first = await harness.service.createLocalSecureSecret({
      displayAlias: "saved-alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
    });
    const failed = await harness.service.createLocalSecureSecret({
      displayAlias: "saved-beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
    });
    const last = await harness.service.createLocalSecureSecret({
      displayAlias: "saved-gamma",
      encryptedMaterial: Buffer.from("gamma").toString("base64"),
    });
    await harness.service.createLocalSecureSecret({
      displayAlias: "session-only",
      encryptedMaterial: Buffer.from("session-only").toString("base64"),
      retention: "session",
      scope: { kind: "profile", profileId: "profile-a" },
    });

    await expect(
      harness.service.testSecureSecretProvider("forge-local-keychain"),
    ).resolves.toEqual({
      provider: expect.objectContaining({
        providerId: "forge-local-keychain",
        status: "unreachable",
        lastStatusCode: "source_unreachable",
      }),
      code: "local_secret_decrypt_failed",
      affectedSecrets: [{
        secretId: failed.secretId,
        displayAlias: "saved-beta",
      }],
    });
    expect(harness.sourceResolutions.get(ALPHA)).toBe(1);
    expect(harness.sourceResolutions.get("gamma")).toBe(1);
    expect(harness.sourceResolutions.has("session-only")).toBe(false);
    expect(harness.resolvedMaterials).toHaveLength(2);
    expect(harness.resolvedMaterials.every((material) => material.released)).toBe(true);
    expect([first.secretId, last.secretId]).not.toContain(failed.secretId);
    await harness.close();
  });

  it("validates Bitwarden credentials before atomic replacement and revokes active authority", async () => {
    const harness = createHarness({
      rejectedBitwardenCredentials: ["invalid-ciphertext"],
    });
    const originalCiphertext = Buffer.from("original-ciphertext").toString("base64");
    const connected = await harness.service.connectBitwardenSecureSecretProvider({
      displayName: "Bitwarden test",
      serverOrigin: "https://vault.example.test",
      organizationId: "organization-1",
      projectId: "project-1",
      encryptedAccessToken: originalCiphertext,
    });
    const secret = await harness.service.importBitwardenSecureSecret(
      connected.providerId,
      {
        sourceLocator: "11111111-1111-1111-1111-111111111111",
        displayAlias: "remote-token",
        bindings: [{
          deliveryKind: "environment",
          targetName: "REMOTE_TOKEN",
        }],
        scope: { kind: "profile", profileId: "profile-a" },
      },
    );
    const started = await harness.service.startSecureSession("manager-a");
    const granted = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{
        deliveryKind: "environment",
        targetName: "REMOTE_TOKEN",
      }],
      leaseKind: "task",
    });
    const projectDefault = await harness.service.setSecureSecretProjectDefault(
      secret.secretId,
      { profileId: "profile-a", enabled: true },
    );

    await expect(
      harness.service.updateBitwardenSecureSecretProviderCredential(
        connected.providerId,
        {
          encryptedAccessToken: Buffer.from("invalid-ciphertext").toString("base64"),
        },
      ),
    ).rejects.toThrow("SECURE_PROVIDER_AUTH_REQUIRED");
    const afterRejected = harness.store.getProviderBackendConfig(connected.providerId)!;
    expect(afterRejected.encryptedAccessToken.toString("utf8")).toBe(
      "original-ciphertext",
    );
    expect(
      (await harness.service.getSecureSessionSnapshot("manager-a")).leases,
    ).toEqual([
      expect.objectContaining({
        leaseId: granted.leases[0]!.leaseId,
        status: "active",
      }),
    ]);
    afterRejected.encryptedAccessToken.fill(0);

    const rotated = await harness.service.updateBitwardenSecureSecretProviderCredential(
      connected.providerId,
      {
        encryptedAccessToken: Buffer.from("replacement-ciphertext").toString("base64"),
      },
    );
    const afterRotation = harness.store.getProviderBackendConfig(connected.providerId)!;
    expect(rotated).toEqual(expect.objectContaining({
      providerId: connected.providerId,
      status: "available",
      lastStatusCode: "ok",
    }));
    expect(afterRotation).toEqual(expect.objectContaining({
      providerId: connected.providerId,
      serverOrigin: "https://vault.example.test",
      organizationId: "organization-1",
      projectId: "project-1",
    }));
    expect(afterRotation.encryptedAccessToken.toString("utf8")).toBe(
      "replacement-ciphertext",
    );
    afterRotation.encryptedAccessToken.fill(0);
    expect(await harness.service.listSecureSecrets()).toEqual([
      expect.objectContaining({ secretId: secret.secretId }),
    ]);
    expect(await harness.service.listSecureSecretProjectDefaults("profile-a")).toEqual([
      projectDefault,
    ]);
    expect(await harness.service.getSecureSessionSnapshot("manager-a")).toEqual(
      expect.objectContaining({
        environmentStatus: "stopped",
        leases: [expect.objectContaining({
          leaseId: granted.leases[0]!.leaseId,
          status: "revoked",
        })],
      }),
    );
    expect(harness.bitwardenTests).toEqual([
      {
        credential: "original-ciphertext",
        endpointOrigin: "https://vault.example.test",
      },
      {
        credential: "invalid-ciphertext",
        endpointOrigin: "https://vault.example.test",
      },
      {
        credential: "replacement-ciphertext",
        endpointOrigin: "https://vault.example.test",
      },
    ]);
    await harness.close();
  });

  it("records a provider resolution failure without invalidating another session", async () => {
    const harness = createHarness({ failSourceResolutionAfter: 1 });
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "shared",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "shared");
    harness.execution.destroyed.length = 0;

    await expect(
      grant(harness, "manager-b", secret.secretId, "shared"),
    ).rejects.toThrow("SECURE_SOURCE_UNAVAILABLE");

    const unaffected = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(unaffected.environmentStatus).toBe("ready");
    expect(unaffected.leases).toEqual([
      expect.objectContaining({ secretId: secret.secretId, status: "active" }),
    ]);
    expect(harness.execution.destroyed).not.toContain("manager-a");
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeDefined();
    await harness.close();
  });

  it("serializes provider testing with deletion so status cannot resurrect a provider", async () => {
    const harness = createHarness({ blockProviderStatus: true });
    await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });

    const testing = harness.service.testSecureSecretProvider(
      "forge-local-keychain",
    );
    await harness.waitForBlockedProviderStatus();
    let deletionSettled = false;
    const deleting = harness.service.deleteSecureSecretProvider(
      "forge-local-keychain",
    ).finally(() => {
      deletionSettled = true;
    });
    await Promise.resolve();
    expect(deletionSettled).toBe(false);

    harness.releaseBlockedProviderStatus();
    await expect(testing).resolves.toEqual(expect.objectContaining({
      code: "ok",
      provider: expect.objectContaining({
        status: "available",
      }),
    }));
    await expect(deleting).resolves.toBeUndefined();
    expect(
      (await harness.service.listSecureSecretProviders())
        .some((provider) => provider.providerId === "forge-local-keychain"),
    ).toBe(false);
    await harness.close();
  });

  it("preserves unrelated leases when intentional revocation tears down an in-flight task", async () => {
    const harness = createHarness();
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
    });
    await grant(harness, "manager-a", alpha.secretId, "alpha");
    const first = await harness.service.getSecureSessionSnapshot("manager-a");
    const withBeta = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: first.revision,
      secretId: beta.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
      leaseKind: "task",
    });
    const alphaLease = withBeta.leases.find((lease) => lease.secretId === alpha.secretId)!;
    const betaLease = withBeta.leases.find((lease) => lease.secretId === beta.secretId)!;
    harness.execution.destroyed.length = 0;
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const execution = binding.executeBash({
      secretAliases: [],
      command: "wait-for-destroy",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await harness.execution.waitForBlockedExecution("manager-a");

    const revoking = harness.service.revokeSecureSessionLease("manager-a", {
      baseRevision: withBeta.revision,
      leaseId: alphaLease.leaseId,
    });
    await vi.waitFor(() => {
      expect(harness.execution.destroyed).toContain("manager-a");
    });
    harness.execution.rejectBlockedExecution("manager-a");
    await expect(execution).rejects.toThrow("SECURE_OPERATION_FAILED");
    await expect(revoking).resolves.toEqual(expect.objectContaining({
      environmentStatus: "ready",
    }));

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.leases.find((lease) => lease.leaseId === alphaLease.leaseId)?.status)
      .toBe("revoked");
    expect(after.leases.find((lease) => lease.leaseId === betaLease.leaseId)?.status)
      .toBe("active");
    await expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )?.executeBash({
      secretAliases: [],
      command: "safe-beta",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).resolves.toEqual({ exitCode: 0 });
    await harness.close();
  });

  it("keeps lease caches and guards session-scoped across repeated execution and stop", async () => {
    const harness = createHarness();
    const alphaSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const betaSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
    });

    await grant(harness, "manager-a", alphaSecret.secretId, "alpha");
    await grant(harness, "manager-b", betaSecret.secretId, "beta");
    const alphaBinding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-a")!)!;
    const betaBinding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-b")!)!;

    for (let index = 0; index < 16; index += 1) {
      const output: string[] = [];
      await alphaBinding.executeBash({
      secretAliases: [],
        command: "safe-alpha",
        cwd: "/workspace-a",
        onData: (bytes) => output.push(Buffer.from(bytes).toString("utf8")),
      });
      expect(output.join("")).toBe("safe");
    }
    expect(harness.sourceResolutions.get(ALPHA)).toBe(1);

    const crossSessionOutput: string[] = [];
    await betaBinding.executeBash({
      secretAliases: [],
      command: "emit-alpha-canary",
      cwd: "/workspace-b",
      onData: (bytes) => crossSessionOutput.push(Buffer.from(bytes).toString("utf8")),
    });
    expect(crossSessionOutput.join("")).toBe(ALPHA);
    expect(harness.sourceResolutions.get(BETA)).toBe(1);

    const alphaSnapshot = await harness.service.getSecureSessionSnapshot("manager-a");
    await harness.service.stopSecureSession("manager-a", {
      baseRevision: alphaSnapshot.revision,
      stopProcesses: true,
    });
    await betaBinding.executeBash({
      secretAliases: [],
      command: "safe-beta",
      cwd: "/workspace-b",
      onData: () => undefined,
    });
    expect(harness.sourceResolutions.get(BETA)).toBe(1);
    await harness.close();
  });

  it("serializes concurrent grants so one stale revision cannot create a second lease", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const request = {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment" as const, targetName: "ALPHA_TOKEN" }],
      leaseKind: "task" as const,
    };

    const results = await Promise.allSettled([
      harness.service.grantSecureSessionLease("manager-a", request),
      harness.service.grantSecureSessionLease("manager-a", request),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      await harness.service.getSecureSessionSnapshot("manager-a"),
    ).toEqual(expect.objectContaining({
      leases: [expect.objectContaining({ status: "active" })],
    }));
    await harness.close();
  });

  it("grants several proactive secrets with one rebuild, revision, and final snapshot", async () => {
    const harness = createHarness();
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{
        deliveryKind: "file",
        targetPath: "/run/forge-secure/bindings/beta",
        fileMode: 0o400,
      }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const snapshotsBefore = harness.snapshots.length;
    const destroysBefore = harness.execution.destroyed.length;
    const ensuresBefore = harness.execution.ensured.length;

    const result = await harness.service.grantSecureSessionLeases("manager-a", {
      baseRevision: started.revision,
      grants: [
        {
          secretId: alpha.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
          leaseKind: "task",
        },
        {
          secretId: beta.secretId,
          exposures: [{
            deliveryKind: "file",
            targetPath: "/run/forge-secure/bindings/beta",
            fileMode: 0o400,
          }],
          leaseKind: "timed",
          durationSeconds: 300,
        },
      ],
    });

    expect(result.revision).toBe(started.revision + 1);
    expect(result.leases).toEqual([
      expect.objectContaining({ secretId: alpha.secretId, status: "active" }),
      expect.objectContaining({ secretId: beta.secretId, status: "active" }),
    ]);
    expect(harness.execution.destroyed).toHaveLength(destroysBefore + 1);
    expect(harness.execution.ensured).toHaveLength(ensuresBefore + 1);
    expect(harness.snapshots).toHaveLength(snapshotsBefore + 1);
    const stored = harness.store.getSnapshot("manager-a");
    expect(new Set(stored.leases.map(({ issuedRevision }) => issuedRevision)))
      .toEqual(new Set([result.revision]));
    expect(harness.store.listAudit("manager-a").filter(({ eventType }) =>
      eventType === "lease_created"
    )).toHaveLength(2);
    expect(harness.sourceResolutions.get(ALPHA)).toBe(1);
    expect(harness.sourceResolutions.get(BETA)).toBe(1);
    expect(harness.resolvedMaterials).toHaveLength(2);
    expect(harness.resolvedMaterials.every(({ released }) => !released)).toBe(true);
    await harness.close();
  });

  it("rejects cross-batch binding collisions before rebuilding or creating any lease", async () => {
    const harness = createHarness();
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const snapshotsBefore = harness.snapshots.length;
    const destroysBefore = harness.execution.destroyed.length;
    const ensuresBefore = harness.execution.ensured.length;
    const auditsBefore = harness.store.listAudit("manager-a").length;

    await expect(harness.service.grantSecureSessionLeases("manager-a", {
      baseRevision: started.revision,
      grants: [
        {
          secretId: alpha.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
          leaseKind: "task",
        },
        {
          secretId: beta.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
          leaseKind: "one_use",
        },
      ],
    })).rejects.toThrow("SECURE_REQUEST_INVALID");

    expect(harness.store.getSnapshot("manager-a")).toEqual(expect.objectContaining({
      state: expect.objectContaining({ revision: started.revision }),
      leases: [],
    }));
    expect(harness.store.listAudit("manager-a")).toHaveLength(auditsBefore);
    expect(harness.execution.destroyed).toHaveLength(destroysBefore);
    expect(harness.execution.ensured).toHaveLength(ensuresBefore);
    expect(harness.snapshots).toHaveLength(snapshotsBefore);
    await harness.close();
  });

  it("releases a pre-resolved batch on source failure without disturbing existing authority", async () => {
    const harness = createHarness({ failSourceResolutionAfter: 2 });
    const existing = await harness.service.createLocalSecureSecret({
      displayAlias: "existing",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "EXISTING_TOKEN" }],
    });
    const proposed = await harness.service.createLocalSecureSecret({
      displayAlias: "proposed",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "PROPOSED_TOKEN" }],
    });
    const failing = await harness.service.createLocalSecureSecret({
      displayAlias: "failing",
      encryptedMaterial: Buffer.from("failing-secret").toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "FAILING_TOKEN" }],
    });
    await grant(harness, "manager-a", existing.secretId, "existing");
    const before = await harness.service.getSecureSessionSnapshot("manager-a");
    const existingMaterial = harness.resolvedMaterials[0]!;
    const destroysBefore = harness.execution.destroyed.length;
    const ensuresBefore = harness.execution.ensured.length;
    const leaseAuditsBefore = harness.store.listAudit("manager-a").filter(
      ({ eventType }) => eventType === "lease_created",
    ).length;

    await expect(harness.service.grantSecureSessionLeases("manager-a", {
      baseRevision: before.revision,
      grants: [
        {
          secretId: proposed.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "PROPOSED_TOKEN" }],
          leaseKind: "task",
        },
        {
          secretId: failing.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "FAILING_TOKEN" }],
          leaseKind: "task",
        },
      ],
    })).rejects.toThrow("SECURE_SOURCE_UNAVAILABLE");

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after).toEqual(expect.objectContaining({
      revision: before.revision,
      environmentStatus: "ready",
      leases: [expect.objectContaining({
        leaseId: before.leases[0]!.leaseId,
        secretId: existing.secretId,
        status: "active",
      })],
    }));
    expect(harness.execution.destroyed).toHaveLength(destroysBefore);
    expect(harness.execution.ensured).toHaveLength(ensuresBefore);
    expect(harness.store.listAudit("manager-a").filter(
      ({ eventType }) => eventType === "lease_created",
    )).toHaveLength(leaseAuditsBefore);
    expect(existingMaterial.released).toBe(false);
    expect(harness.resolvedMaterials[1]?.released).toBe(true);

    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    await expect(binding.executeBash({
      secretAliases: [],
      command: "safe-existing",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).resolves.toEqual({ exitCode: 0 });
    expect(harness.sourceResolutions.get(ALPHA)).toBe(1);
    await harness.close();
  });

  it("makes secret rotation authoritative over an admitted execution", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const execution = binding.executeBash({
      secretAliases: [],
      command: "wait-for-destroy",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await harness.execution.waitForBlockedExecution("manager-a");
    harness.execution.destroyed.length = 0;

    const rotating = harness.service.updateSecureSecret(secret.secretId, {
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
    });
    await vi.waitFor(() => {
      expect(harness.execution.destroyed).toContain("manager-a");
    });
    harness.execution.rejectBlockedExecution("manager-a");

    await expect(execution).rejects.toThrow("SECURE_OPERATION_FAILED");
    await expect(rotating).resolves.toEqual(expect.objectContaining({
      secretId: secret.secretId,
    }));
    expect(
      await harness.service.getSecureSessionSnapshot("manager-a"),
    ).toEqual(expect.objectContaining({
      environmentStatus: "stopped",
    }));
    await harness.close();
  });

  it("runs ordinary secure Bash with zero leases and zeroizes delivery copies", async () => {
    const harness = createHarness();
    await expect(harness.service.getSecureSessionAgentView("manager-a")).resolves.toEqual(
      expect.objectContaining({ executionMode: "standard", leases: [] }),
    );
    await harness.service.startSecureSession("manager-a");
    const binding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-a")!)!;
    const output: string[] = [];
    await binding.executeBash({
      secretAliases: [],
      command: "safe-zero-lease",
      cwd: "/workspace-a",
      onData: (bytes) => output.push(Buffer.from(bytes).toString("utf8")),
    });
    expect(output.join("")).toBe("safe");

    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    await harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!.executeBash({
      secretAliases: ["alpha"],
      command: "safe-alpha",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    expect(harness.execution.lastDeliveryValue).toBeDefined();
    expect([...harness.execution.lastDeliveryValue!]).toEqual(
      new Array(harness.execution.lastDeliveryValue!.byteLength).fill(0),
    );
    await harness.close();
  });

  it("guards non-Bash tool values before first use and fails closed on a stale one-use binding", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{
        deliveryKind: "environment",
        targetName: "ALPHA_TOKEN",
      }],
      leaseKind: "one_use",
    });
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;

    expect(binding.guardValue(ALPHA)).toBe(SECURE_OUTPUT_QUARANTINE);
    await binding.executeBash({
      secretAliases: ["alpha"],
      command: "safe-alpha",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    expect(() => binding.guardValue("workspace file contents")).toThrow(
      "SECURE_OPERATION_FAILED",
    );
    expect(harness.recycles).toContain("manager-a");
    await harness.close();
  });

  it("rebuilds the environment without invalidating the manager-session binding", async () => {
    const harness = createHarness();
    await harness.service.startSecureSession("manager-a");
    const retainedBinding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const before = await harness.service.getSecureSessionSnapshot("manager-a");

    const granted = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: before.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "task",
    });

    expect(harness.execution.destroyed).toContain("manager-a");
    expect(harness.execution.ensured).toEqual(["manager-a", "manager-a"]);
    expect(granted.environmentStatus).toBe("ready");
    expect(retainedBinding.guardValue(ALPHA)).toBe(SECURE_OUTPUT_QUARANTINE);
    const currentBinding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    );
    expect(currentBinding).toBeDefined();
    expect(currentBinding!.guardValue(ALPHA)).toBe(SECURE_OUTPUT_QUARANTINE);
    await harness.service.stopSecureSession("manager-a", {
      baseRevision: granted.revision,
      stopProcesses: true,
    });
    expect(() => retainedBinding.guardValue("after stop")).toThrow(
      "SECURE_OPERATION_FAILED",
    );
    await harness.close();
  });

  it("does not reprovision over an environment whose teardown was unconfirmed", async () => {
    const harness = createHarness();
    const first = await harness.service.createLocalSecureSecret({
      displayAlias: "first",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const second = await harness.service.createLocalSecureSecret({
      displayAlias: "second",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
    });
    await grant(harness, "manager-a", first.secretId, "alpha");
    harness.execution.destroyUnconfirmed.add("manager-a");
    const ensuresBefore = harness.execution.ensured.length;
    const snapshot = await harness.service.getSecureSessionSnapshot("manager-a");

    await expect(
      harness.service.grantSecureSessionLease("manager-a", {
        baseRevision: snapshot.revision,
        secretId: second.secretId,
        exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
        leaseKind: "task",
      }),
    ).rejects.toMatchObject({
      code: "SECURE_OPERATION_FAILED",
    });

    expect(harness.execution.ensured).toHaveLength(ensuresBefore);
    expect(
      (await harness.service.getSecureSessionSnapshot("manager-a"))
        .environmentStatus,
    ).toBe("degraded");
    await harness.close();
  });

  it("rejects reserved and cross-kind guest environment name collisions before execution", async () => {
    const harness = createHarness();
    await expect(
      harness.service.createLocalSecureSecret({
        displayAlias: "reserved",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        bindings: [{ deliveryKind: "environment", targetName: "PATH" }],
      }),
    ).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    await expect(
      harness.service.createLocalSecureSecret({
        displayAlias: "collision",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        bindings: [
          { deliveryKind: "environment", targetName: "FORGE_TOKEN" },
          { deliveryKind: "askpass", targetName: "FORGE_TOKEN" },
        ],
      }),
    ).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });

    const environmentSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "environment",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
    });
    const askpassSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "askpass",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "askpass", targetName: "SHARED_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const first = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: environmentSecret.secretId,
      exposures: [{
        deliveryKind: "environment",
        targetName: "SHARED_TOKEN",
      }],
      leaseKind: "task",
    });
    const destroysBefore = harness.execution.destroyed.length;
    await expect(
      harness.service.grantSecureSessionLease("manager-a", {
        baseRevision: first.revision,
        secretId: askpassSecret.secretId,
        exposures: [{
          deliveryKind: "askpass",
          targetName: "SHARED_TOKEN",
        }],
        leaseKind: "task",
      }),
    ).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    expect(harness.execution.destroyed).toHaveLength(destroysBefore);
    await harness.close();
  });

  it("destroys the process environment when a lease is revoked or consumed", async () => {
    const revoked = createHarness();
    const taskSecret = await revoked.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(revoked, "manager-a", taskSecret.secretId, "alpha");
    const taskSnapshot = await revoked.service.getSecureSessionSnapshot("manager-a");
    const afterRevoke = await revoked.service.revokeSecureSessionLease("manager-a", {
      baseRevision: taskSnapshot.revision,
      leaseId: taskSnapshot.leases[0]!.leaseId,
    });
    expect(afterRevoke.environmentStatus).toBe("stopped");
    expect(revoked.execution.destroyed).toContain("manager-a");
    expect(revoked.service.getSecureRuntimeBinding(
      revoked.descriptors.get("manager-a")!,
    )).toBeUndefined();
    await revoked.close();

    const consumed = createHarness();
    const oneUseSecret = await consumed.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await consumed.service.startSecureSession("manager-a");
    await consumed.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: oneUseSecret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "one_use",
    });
    const binding = consumed.service.getSecureRuntimeBinding(
      consumed.descriptors.get("manager-a")!,
    )!;
    await binding.executeBash({
      secretAliases: ["alpha"],
      command: "safe-alpha",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    const consumedSnapshot = await consumed.service.getSecureSessionSnapshot("manager-a");
    expect(consumedSnapshot.environmentStatus).toBe("stopped");
    expect(consumedSnapshot.leases[0]?.status).toBe("consumed");
    expect(consumed.execution.destroyed).toContain("manager-a");
    expect(consumed.service.getSecureRuntimeBinding(
      consumed.descriptors.get("manager-a")!,
    )).toBeUndefined();
    await consumed.close();
  });

  it("preserves an unselected one-use lease and consumes it only when selected", async () => {
    const harness = createHarness();
    const taskSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "task-secret",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "TASK_TOKEN" }],
    });
    const oneUseSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "one-use-secret",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ONE_USE_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const withTask = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: taskSecret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "TASK_TOKEN" }],
      leaseKind: "task",
    });
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: withTask.revision,
      secretId: oneUseSecret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ONE_USE_TOKEN" }],
      leaseKind: "one_use",
    });
    const recycleCountBeforeUse = harness.recycles.length;
    harness.setRecycleDisposition("deferred");
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;

    await expect(binding.executeBash({
      secretAliases: ["task-secret"],
      command: "safe",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).resolves.toEqual({ exitCode: 0 });

    const afterUse = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(afterUse.environmentStatus).toBe("ready");
    expect(afterUse.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        secretId: taskSecret.secretId,
        status: "active",
      }),
      expect.objectContaining({
        secretId: oneUseSecret.secretId,
        status: "active",
        remainingUses: 1,
      }),
    ]));
    expect(harness.recycles).toHaveLength(recycleCountBeforeUse);
    await expect(binding.executeBash({
      secretAliases: ["one-use-secret"],
      command: "safe-one-use",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).resolves.toEqual({ exitCode: 0 });
    expect((await harness.service.getSecureSessionSnapshot("manager-a")).leases)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          secretId: oneUseSecret.secretId,
          status: "consumed",
          remainingUses: 0,
        }),
      ]));
    await expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!.executeBash({
      secretAliases: ["task-secret"],
      command: "safe-again",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).resolves.toEqual({ exitCode: 0 });
    expect((await harness.service.getSecureSessionSnapshot("manager-a"))
      .environmentStatus).toBe("ready");
    await harness.close();
  });

  it("rejects an unavailable command alias before execution or one-use consumption", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "one-use-secret",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ONE_USE_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ONE_USE_TOKEN" }],
      leaseKind: "one_use",
    });
    const executionsBefore = harness.execution.executed.length;

    await expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!.executeBash({
      secretAliases: ["not-granted"],
      command: "must-not-run",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });

    expect(harness.execution.executed).toHaveLength(executionsBefore);
    expect(await harness.service.getSecureSessionSnapshot("manager-a"))
      .toEqual(expect.objectContaining({
        environmentStatus: "ready",
        leases: [expect.objectContaining({
          secretId: secret.secretId,
          status: "active",
          remainingUses: 1,
        })],
      }));
    await harness.close();
  });

  it("serializes parallel Bash calls across one-use consumption and teardown", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "one_use",
    });
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;

    const first = binding.executeBash({
      secretAliases: ["alpha"],
      command: "wait-for-release",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await harness.execution.waitForBlockedExecution("manager-a");
    const second = binding.executeBash({
      secretAliases: ["alpha"],
      command: "safe-alpha",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await Promise.resolve();
    expect(harness.execution.executed).toEqual(["manager-a"]);

    harness.execution.releaseBlockedExecution("manager-a");
    await expect(first).resolves.toEqual({ exitCode: 0 });
    await expect(second).rejects.toThrow("SECURE_OPERATION_FAILED");
    expect(harness.execution.executed).toEqual(["manager-a"]);
    expect(harness.execution.destroyed).toContain("manager-a");
    await harness.close();
  });

  it("rejects a second worker selecting an in-use one-use lease without stopping the first", async () => {
    const harness = createHarness();
    const workerA = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-a",
    );
    const workerB = workerDescriptor(
      "worker-b",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-b",
    );
    harness.descriptors.set(workerA.agentId, workerA);
    harness.descriptors.set(workerB.agentId, workerB);
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "one_use",
    });
    const first = harness.service.getSecureRuntimeBinding(workerA)!.executeBash({
      secretAliases: ["alpha"],
      command: "wait-for-release",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await harness.execution.waitForBlockedExecution("manager-a");

    await expect(harness.service.getSecureRuntimeBinding(workerB)!.executeBash({
      secretAliases: ["alpha"],
      command: "must-not-run",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    expect(harness.execution.executed).toEqual(["manager-a"]);

    harness.execution.releaseBlockedExecution("manager-a");
    await expect(first).resolves.toEqual({ exitCode: 0 });
    expect(await harness.service.getSecureSessionSnapshot("manager-a"))
      .toEqual(expect.objectContaining({
        environmentStatus: "stopped",
        leases: [expect.objectContaining({ status: "consumed" })],
      }));
    await harness.close();
  });

  it("does not republish a closed environment when one-use completion races a grant", async () => {
    const harness = createHarness();
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const oneUse = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: alpha.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "one_use",
    });
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const execution = binding.executeBash({
      secretAliases: ["alpha"],
      command: "wait-for-release",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await harness.execution.waitForBlockedExecution("manager-a");

    const granting = harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: oneUse.revision,
      secretId: beta.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
      leaseKind: "task",
    });
    await vi.waitFor(() => {
      expect(harness.execution.destroyed).toContain("manager-a");
    });
    harness.execution.releaseBlockedExecution("manager-a");

    await expect(execution).resolves.toEqual({ exitCode: 0 });
    await expect(granting).rejects.toThrow("SECURE_STALE_REVISION");
    const afterRace = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(afterRace.environmentStatus).toBe("stopped");
    expect(afterRace.leases.some((lease) =>
      lease.secretId === beta.secretId && lease.status === "active"
    )).toBe(false);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeUndefined();

    const retried = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: afterRace.revision,
      secretId: beta.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
      leaseKind: "task",
    });
    expect(retried.environmentStatus).toBe("ready");
    expect(retried.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ secretId: beta.secretId, status: "active" }),
    ]));
    await harness.close();
  });

  it("does not tear down an active environment for a secret with only historical leases", async () => {
    const harness = createHarness();
    const historical = await harness.service.createLocalSecureSecret({
      displayAlias: "historical",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "HISTORICAL_TOKEN" }],
    });
    const current = await harness.service.createLocalSecureSecret({
      displayAlias: "current",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "CURRENT_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: historical.secretId,
      exposures: [{
        deliveryKind: "environment",
        targetName: "HISTORICAL_TOKEN",
      }],
      leaseKind: "one_use",
    });
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    await binding.executeBash({
      secretAliases: ["historical"],
      command: "safe-alpha",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    const consumed = await harness.service.getSecureSessionSnapshot("manager-a");
    const active = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: consumed.revision,
      secretId: current.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "CURRENT_TOKEN" }],
      leaseKind: "task",
    });
    harness.execution.destroyed.length = 0;

    await harness.service.updateSecureSecret(historical.secretId, {
      displayName: "Historical credential",
    });

    const afterUpdate = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(afterUpdate.environmentStatus).toBe("ready");
    expect(afterUpdate.leases.find((lease) =>
      lease.secretId === current.secretId
    )).toEqual(expect.objectContaining({ status: "active" }));
    expect(afterUpdate.revision).toBe(active.revision);
    expect(harness.execution.destroyed).toEqual([]);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeDefined();
    await harness.close();
  });

  it("expires timed leases with a real process reaper", async () => {
    vi.useFakeTimers();
    try {
      let logicalNow = Date.parse(NOW);
      const harness = createHarness({
        now: () => new Date(logicalNow).toISOString(),
      });
      const secret = await harness.service.createLocalSecureSecret({
        displayAlias: "alpha",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      });
      const started = await harness.service.startSecureSession("manager-a");
      await harness.service.grantSecureSessionLease("manager-a", {
        baseRevision: started.revision,
        secretId: secret.secretId,
        exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
        leaseKind: "timed",
        durationSeconds: 1,
      });

      logicalNow += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);

      const expired = await harness.service.getSecureSessionSnapshot("manager-a");
      expect(expired.leases[0]?.status).toBe("expired");
      expect(expired.environmentStatus).toBe("stopped");
      expect(harness.execution.destroyed).toContain("manager-a");
      await harness.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects execution and tears down when logical expiry wins before the timer runs", async () => {
    vi.useFakeTimers();
    try {
      let logicalNow = Date.parse(NOW);
      const harness = createHarness({
        now: () => new Date(logicalNow).toISOString(),
      });
      const secret = await harness.service.createLocalSecureSecret({
        displayAlias: "alpha",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      });
      const started = await harness.service.startSecureSession("manager-a");
      await harness.service.grantSecureSessionLease("manager-a", {
        baseRevision: started.revision,
        secretId: secret.secretId,
        exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
        leaseKind: "timed",
        durationSeconds: 1,
      });
      const binding = harness.service.getSecureRuntimeBinding(
        harness.descriptors.get("manager-a")!,
      )!;
      const executionsBeforeExpiry = harness.execution.executed.length;

      logicalNow += 1_001;
      await expect(binding.executeBash({
      secretAliases: [],
        command: "safe-alpha",
        cwd: "/workspace-a",
        onData: () => undefined,
      })).rejects.toThrow("SECURE_OPERATION_FAILED");

      expect(harness.execution.executed).toHaveLength(executionsBeforeExpiry);
      expect(harness.execution.destroyed).toContain("manager-a");
      expect(
        await harness.service.getSecureSessionSnapshot("manager-a"),
      ).toEqual(expect.objectContaining({
        executionMode: "secure",
        environmentStatus: "stopped",
        leases: [expect.objectContaining({ status: "expired" })],
      }));
      await harness.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps timed expiry authoritative over an in-flight execution failure", async () => {
    vi.useFakeTimers();
    try {
      let logicalNow = Date.parse(NOW);
      const harness = createHarness({
        now: () => new Date(logicalNow).toISOString(),
      });
      const secret = await harness.service.createLocalSecureSecret({
        displayAlias: "alpha",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      });
      const started = await harness.service.startSecureSession("manager-a");
      await harness.service.grantSecureSessionLease("manager-a", {
        baseRevision: started.revision,
        secretId: secret.secretId,
        exposures: [{
          deliveryKind: "environment",
          targetName: "ALPHA_TOKEN",
        }],
        leaseKind: "timed",
        durationSeconds: 1,
      });
      const binding = harness.service.getSecureRuntimeBinding(
        harness.descriptors.get("manager-a")!,
      )!;
      const execution = binding.executeBash({
      secretAliases: [],
        command: "wait-for-destroy",
        cwd: "/workspace-a",
        onData: () => undefined,
      });
      await harness.execution.waitForBlockedExecution("manager-a");

      logicalNow += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.execution.destroyed).toContain("manager-a");
      harness.execution.rejectBlockedExecution("manager-a");
      await expect(execution).rejects.toThrow("SECURE_OPERATION_FAILED");
      for (let index = 0; index < 10; index += 1) await Promise.resolve();

      expect(
        await harness.service.getSecureSessionSnapshot("manager-a"),
      ).toEqual(expect.objectContaining({
        executionMode: "secure",
        environmentStatus: "stopped",
        leases: [expect.objectContaining({ status: "expired" })],
      }));
      await harness.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts secure execution before approving a request made in standard mode", async () => {
    const harness = createHarness();
    await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await harness.service.requestSecureSecretAccess("manager-a", "tool-1", {
      displayAlias: "alpha",
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "task",
      purposeSummary: "Use the configured test credential",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(pending.executionMode).toBe("standard");
    const requestId = pending.pendingRequests[0]!.requestId;
    const approved = await harness.service.resolveSecureAccessRequest(
      "manager-a",
      requestId,
      {
        baseRevision: pending.revision,
        requestId,
        decision: "approve",
      },
    );
    expect(approved).toEqual(expect.objectContaining({
      executionMode: "secure",
      environmentStatus: "ready",
    }));
    expect(approved.leases).toHaveLength(1);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeDefined();
    expect(harness.recycles).toEqual(["manager-a"]);

    await harness.service.requestSecureSecretAccess("manager-b", "tool-2", {
      displayAlias: "private-beta",
      exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
      leaseKind: "one_use",
      purposeSummary: "Use a private one-time credential",
    });
    const privatePending = await harness.service.getSecureSessionSnapshot("manager-b");
    const privateRequestId = privatePending.pendingRequests[0]!.requestId;
    const fulfilled = await harness.service.fulfillSecureAccessRequest(
      "manager-b",
      privateRequestId,
      {
        baseRevision: privatePending.revision,
        displayAlias: "private-beta",
        encryptedMaterial: Buffer.from(BETA).toString("base64"),
        exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
        retention: "session",
        leaseKind: "one_use",
      },
    );
    expect(fulfilled).toEqual(expect.objectContaining({
      executionMode: "secure",
      environmentStatus: "ready",
    }));
    expect(fulfilled.leases).toHaveLength(1);
    expect(harness.recycles).toEqual(["manager-a", "manager-b"]);
    await harness.close();
  });

  it("reuses an equivalent active lease instead of creating another request", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "already-active",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [
        { deliveryKind: "environment", targetName: "ACTIVE_TOKEN" },
        {
          deliveryKind: "file",
          targetPath: "/run/forge-secure/bindings/active",
          fileMode: 0o400,
        },
      ],
    });
    const initial = await harness.service.getSecureSessionSnapshot("manager-a");
    const granted = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: initial.revision,
      secretId: secret.secretId,
      exposures: [
        { deliveryKind: "environment", targetName: "ACTIVE_TOKEN" },
        {
          deliveryKind: "file",
          targetPath: "/run/forge-secure/bindings/active",
          fileMode: 0o400,
        },
      ],
      leaseKind: "task",
    });

    await expect(harness.service.requestSecureSecretAccess(
      "manager-a",
      "tool-already-active",
      {
        displayAlias: "already-active",
        exposures: [
          {
            deliveryKind: "file",
            targetPath: "/run/forge-secure/bindings/active",
            fileMode: 0o400,
          },
          { deliveryKind: "environment", targetName: "ACTIVE_TOKEN" },
        ],
        leaseKind: "task",
        purposeSummary: "Reuse the existing authorized delivery",
      },
    )).resolves.toBe("already_granted");

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.revision).toBe(granted.revision);
    expect(after.pendingRequests).toEqual([]);
    expect(after.leases).toHaveLength(1);
    await harness.close();
  });

  it("treats approval as satisfied when an equivalent lease won the race", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "approval-race",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "APPROVAL_RACE" }],
    });
    await harness.service.requestSecureSecretAccess("manager-a", "tool-race", {
      displayAlias: "approval-race",
      exposures: [{ deliveryKind: "environment", targetName: "APPROVAL_RACE" }],
      leaseKind: "task",
      purposeSummary: "Use the credential after another grant path wins",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    const requestId = pending.pendingRequests[0]!.requestId;
    const granted = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: pending.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "APPROVAL_RACE" }],
      leaseKind: "task",
    });
    expect(granted.pendingRequests).toHaveLength(1);
    expect(granted.leases).toHaveLength(1);

    const resolved = await harness.service.resolveSecureAccessRequest(
      "manager-a",
      requestId,
      {
        baseRevision: granted.revision,
        requestId,
        decision: "approve",
      },
    );

    expect(resolved.pendingRequests).toEqual([]);
    expect(resolved.leases).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        grantSource: "manual",
        status: "active",
      }),
    ]);
    await harness.close();
  });

  it("coalesces equivalent pending access requests while retaining distinct requests", async () => {
    const harness = createHarness();
    const first = await harness.service.requestSecureSecretAccess(
      "manager-a",
      "tool-pending-first",
      {
        displayAlias: "pending-alpha",
        exposures: [
          { deliveryKind: "environment", targetName: "PENDING_ALPHA" },
          { deliveryKind: "stdin" },
        ],
        leaseKind: "timed",
        durationSeconds: 600,
        purposeSummary: "First request purpose",
      },
    );
    const duplicate = await harness.service.requestSecureSecretAccess(
      "manager-a",
      "tool-pending-duplicate",
      {
        displayAlias: "pending-alpha",
        exposures: [
          { deliveryKind: "stdin" },
          { deliveryKind: "environment", targetName: "PENDING_ALPHA" },
        ],
        leaseKind: "timed",
        durationSeconds: 600,
        purposeSummary: "A different purpose does not need a second approval",
      },
    );
    const distinct = await harness.service.requestSecureSecretAccess(
      "manager-a",
      "tool-pending-distinct",
      {
        displayAlias: "pending-beta",
        exposures: [{ deliveryKind: "environment", targetName: "PENDING_BETA" }],
        leaseKind: "task",
        purposeSummary: "A genuinely different secret still needs approval",
      },
    );

    expect({ first, duplicate, distinct }).toEqual({
      first: "requested",
      duplicate: "already_requested",
      distinct: "requested",
    });
    expect((await harness.service.getSecureSessionSnapshot("manager-a"))
      .pendingRequests.map(({ displayAlias }) => displayAlias)).toEqual([
        "pending-alpha",
        "pending-beta",
      ]);
    await harness.close();
  });

  it("resolves two distinct requests independently with each current revision", async () => {
    const harness = createHarness();
    for (const [displayAlias, targetName, value] of [
      ["multi-alpha", "MULTI_ALPHA", ALPHA],
      ["multi-beta", "MULTI_BETA", BETA],
    ] as const) {
      await harness.service.createLocalSecureSecret({
        displayAlias,
        encryptedMaterial: Buffer.from(value).toString("base64"),
        bindings: [{ deliveryKind: "environment", targetName }],
      });
      await harness.service.requestSecureSecretAccess(
        "manager-a",
        `tool-${displayAlias}`,
        {
          displayAlias,
          exposures: [{ deliveryKind: "environment", targetName }],
          leaseKind: "task",
          purposeSummary: `Use ${displayAlias}`,
        },
      );
    }

    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(pending.pendingRequests).toHaveLength(2);
    const firstRequestId = pending.pendingRequests[0]!.requestId;
    const afterFirst = await harness.service.resolveSecureAccessRequest(
      "manager-a",
      firstRequestId,
      {
        baseRevision: pending.revision,
        requestId: firstRequestId,
        decision: "approve",
      },
    );
    expect(afterFirst.pendingRequests).toHaveLength(1);
    const secondRequestId = afterFirst.pendingRequests[0]!.requestId;
    const afterSecond = await harness.service.resolveSecureAccessRequest(
      "manager-a",
      secondRequestId,
      {
        baseRevision: afterFirst.revision,
        requestId: secondRequestId,
        decision: "approve",
      },
    );

    expect(afterSecond.pendingRequests).toEqual([]);
    expect(afterSecond.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayAlias: "multi-alpha", status: "active" }),
      expect.objectContaining({ displayAlias: "multi-beta", status: "active" }),
    ]));
    await harness.close();
  });

  it("prefers a project-scoped alias over the instance alias for agent discovery and requests", async () => {
    const harness = createHarness();
    const globalSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "shared",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "GLOBAL_TOKEN" }],
    });
    const projectSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "shared",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "PROJECT_TOKEN" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });

    await expect(harness.service.getSecureSessionAgentView("manager-a")).resolves
      .toEqual(expect.objectContaining({
        availableSecrets: [{
          displayAlias: "shared",
          bindings: [{ deliveryKind: "environment", targetName: "PROJECT_TOKEN" }],
        }],
      }));
    await expect(harness.service.getSecureSessionAgentView("manager-b")).resolves
      .toEqual(expect.objectContaining({
        availableSecrets: [{
          displayAlias: "shared",
          bindings: [{ deliveryKind: "environment", targetName: "GLOBAL_TOKEN" }],
        }],
      }));

    await harness.service.requestSecureSecretAccess("manager-a", "tool-project", {
      displayAlias: "shared",
      exposures: [{ deliveryKind: "environment", targetName: "PROJECT_TOKEN" }],
      leaseKind: "task",
      purposeSummary: "Use the project-specific credential",
    });
    expect((await harness.service.getSecureSessionSnapshot("manager-a"))
      .pendingRequests[0]?.secretId).toBe(projectSecret.secretId);
    expect((await harness.service.getSecureSessionSnapshot("manager-a"))
      .pendingRequests[0]?.secretId).not.toBe(globalSecret.secretId);
    await harness.close();
  });

  it("shares one saved secret across selected projects and prunes grants with its scope", async () => {
    const harness = createHarness();
    const shared = await harness.service.createLocalSecureSecret({
      displayAlias: "selected-projects",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{
        deliveryKind: "environment",
        targetName: "SELECTED_PROJECTS_TOKEN",
      }],
      scope: {
        kind: "profiles",
        profileIds: ["profile-b", "profile-a"],
      },
    });
    expect(shared.scope).toEqual({
      kind: "profiles",
      profileIds: ["profile-a", "profile-b"],
    });
    await expect(harness.service.getSecureSessionAgentView("manager-a"))
      .resolves.toEqual(expect.objectContaining({
        availableSecrets: [
          expect.objectContaining({ displayAlias: "selected-projects" }),
        ],
      }));
    await expect(harness.service.getSecureSessionAgentView("manager-b"))
      .resolves.toEqual(expect.objectContaining({
        availableSecrets: [
          expect.objectContaining({ displayAlias: "selected-projects" }),
        ],
      }));

    await expect(harness.service.replaceSecureSecretAutomaticGrantPolicy(
      shared.secretId,
      { kind: "projects", profileIds: ["profile-a", "profile-b"] },
    )).resolves.toEqual(expect.objectContaining({
      automaticGrantPolicy: {
        kind: "projects",
        profileIds: ["profile-a", "profile-b"],
      },
    }));
    await expect(harness.service.replaceSecureSecretAutomaticGrantPolicy(
      shared.secretId,
      { kind: "projects", profileIds: ["missing-profile"] },
    )).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });

    await expect(harness.service.updateSecureSecret(shared.secretId, {
      scope: { kind: "profile", profileId: "profile-b" },
    })).resolves.toEqual(expect.objectContaining({
      scope: { kind: "profile", profileId: "profile-b" },
      automaticGrantPolicy: {
        kind: "projects",
        profileIds: ["profile-b"],
      },
    }));
    await expect(harness.service.getSecureSessionAgentView("manager-a"))
      .resolves.toEqual(expect.objectContaining({ availableSecrets: [] }));
    await expect(harness.service.getSecureSessionAgentView("manager-b"))
      .resolves.toEqual(expect.objectContaining({
        availableSecrets: [
          expect.objectContaining({ displayAlias: "selected-projects" }),
        ],
      }));
    await harness.close();
  });

  it("rejects forged project scopes", async () => {
    const harness = createHarness();
    await expect(harness.service.createLocalSecureSecret({
      displayAlias: "forged",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      scope: { kind: "profile", profileId: "missing-profile" },
    })).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    await expect(
      harness.service.listSecureSecretProjectDefaults("missing-profile"),
    ).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    await harness.close();
  });

  it("enforces the shared project-default limit without mutating the overflow selection", async () => {
    const harness = createHarness();
    const secrets = [];
    for (let index = 0; index <= SECURE_SECRET_MAX_PROJECT_DEFAULTS; index += 1) {
      secrets.push(await harness.service.createLocalSecureSecret({
        displayAlias: `bounded-default-${index}`,
        encryptedMaterial: Buffer.from(`${ALPHA}-${index}`).toString("base64"),
        bindings: [{
          deliveryKind: "environment",
          targetName: `BOUNDED_DEFAULT_${index}`,
        }],
      }));
    }
    for (const secret of secrets.slice(0, SECURE_SECRET_MAX_PROJECT_DEFAULTS)) {
      await expect(harness.service.setSecureSecretProjectDefault(secret.secretId, {
        profileId: "profile-a",
        enabled: true,
      })).resolves.toEqual(expect.objectContaining({ secretId: secret.secretId }));
    }

    await expect(harness.service.setSecureSecretProjectDefault(
      secrets[SECURE_SECRET_MAX_PROJECT_DEFAULTS]!.secretId,
      { profileId: "profile-a", enabled: true },
    )).rejects.toMatchObject({
      code: "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
    });
    expect(await harness.service.listSecureSecretProjectDefaults("profile-a"))
      .toHaveLength(SECURE_SECRET_MAX_PROJECT_DEFAULTS);
    await harness.close();
  });

  it("enforces a configured project-default limit below the default", async () => {
    const harness = createHarness({ maxProjectDefaults: 2 });
    const secrets = [];
    for (let index = 0; index < 3; index += 1) {
      secrets.push(await harness.service.createLocalSecureSecret({
        displayAlias: `custom-limit-${index}`,
        encryptedMaterial: Buffer.from(`${ALPHA}-${index}`).toString("base64"),
        bindings: [{
          deliveryKind: "environment",
          targetName: `CUSTOM_LIMIT_${index}`,
        }],
      }));
    }
    await expect(harness.service.setSecureSecretProjectDefault(secrets[0]!.secretId, {
      profileId: "profile-a",
      enabled: true,
    })).resolves.toEqual(expect.objectContaining({ secretId: secrets[0]!.secretId }));
    await expect(harness.service.setSecureSecretProjectDefault(secrets[1]!.secretId, {
      profileId: "profile-a",
      enabled: true,
    })).resolves.toEqual(expect.objectContaining({ secretId: secrets[1]!.secretId }));
    await expect(harness.service.setSecureSecretProjectDefault(secrets[2]!.secretId, {
      profileId: "profile-a",
      enabled: true,
    })).rejects.toMatchObject({
      code: "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
    });
    expect(await harness.service.listSecureSecretProjectDefaults("profile-a"))
      .toHaveLength(2);
    await harness.close();
  });

  it("applies a durable all-project policy to current and future projects", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "global-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{
        deliveryKind: "environment",
        targetName: "GLOBAL_DEFAULT",
      }],
    });

    await expect(
      harness.service.replaceSecureSecretAutomaticGrantPolicy(
        secret.secretId,
        { kind: "all_projects" },
      ),
    ).resolves.toEqual(expect.objectContaining({
      secretId: secret.secretId,
      automaticGrantPolicy: { kind: "all_projects" },
    }));
    expect(await harness.service.listSecureSecretProjectDefaults()).toEqual([]);
    await expect(harness.service.startSecureSession("manager-a")).resolves
      .toEqual(expect.objectContaining({
        leases: [expect.objectContaining({
          secretId: secret.secretId,
          grantSource: "project_default",
        })],
      }));
    await expect(harness.service.startSecureSession("manager-b")).resolves
      .toEqual(expect.objectContaining({
        leases: [expect.objectContaining({
          secretId: secret.secretId,
          grantSource: "project_default",
        })],
      }));

    harness.descriptors.set(
      "manager-c",
      descriptor("manager-c", "profile-c", "/workspace-c"),
    );
    await expect(harness.service.startSecureSession("manager-c")).resolves
      .toEqual(expect.objectContaining({
        leases: [expect.objectContaining({
          secretId: secret.secretId,
          grantSource: "project_default",
        })],
      }));
    await harness.close();
  });

  it("never projects or applies all-project defaults to system profiles", async () => {
    const harness = createHarness({ systemProfiles: ["profile-system"] });
    harness.descriptors.set(
      "manager-system",
      descriptor("manager-system", "profile-system", "/workspace-system"),
    );
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "user-project-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
    });
    await harness.service.replaceSecureSecretAutomaticGrantPolicy(
      secret.secretId,
      { kind: "all_projects" },
    );

    const started = await harness.service.startSecureSession("manager-system");
    expect(started.leases).toEqual([]);
    expect(started.projectDefaults).toEqual([]);
    const applied = await harness.service.applySecureSessionProjectDefaults(
      "manager-system",
      { baseRevision: started.revision },
    );
    expect(applied.leases).toEqual([]);
    expect(applied.projectDefaults).toEqual([]);
    expect(harness.sourceResolutions.size).toBe(0);
    await expect(harness.service.setSecureSecretProjectDefault(
      secret.secretId,
      { profileId: "profile-system", enabled: true },
    )).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    await harness.close();
  });

  it("rejects excluding one project through the legacy endpoint without downgrading all-project policy", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "global-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
    });
    await harness.service.replaceSecureSecretAutomaticGrantPolicy(
      secret.secretId,
      { kind: "all_projects" },
    );

    await expect(harness.service.setSecureSecretProjectDefault(
      secret.secretId,
      { profileId: "profile-a", enabled: false },
    )).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    expect(harness.store.getAutomaticGrantPolicy(secret.secretId)).toEqual({
      kind: "all_projects",
    });
    await harness.close();
  });

  it("can set global policy and clear stale mappings when another project is archived", async () => {
    const harness = createHarness({ archivedProfiles: ["profile-a"] });
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "archive-safe-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
    });
    harness.store.putProjectDefault({
      profileId: "profile-a",
      secretId: secret.secretId,
    });

    await expect(
      harness.service.replaceSecureSecretAutomaticGrantPolicy(
        secret.secretId,
        { kind: "none" },
      ),
    ).resolves.toEqual(expect.objectContaining({
      automaticGrantPolicy: { kind: "none" },
    }));
    await expect(
      harness.service.replaceSecureSecretAutomaticGrantPolicy(
        secret.secretId,
        { kind: "all_projects" },
      ),
    ).resolves.toEqual(expect.objectContaining({
      automaticGrantPolicy: { kind: "all_projects" },
    }));
    await harness.close();
  });

  it("validates global policy conflicts even before any project exists", async () => {
    const harness = createHarness();
    const first = await harness.service.createLocalSecureSecret({
      displayAlias: "future-global-a",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "FUTURE_TOKEN" }],
    });
    const conflicting = await harness.service.createLocalSecureSecret({
      displayAlias: "future-global-b",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "FUTURE_TOKEN" }],
    });
    harness.descriptors.clear();

    await harness.service.replaceSecureSecretAutomaticGrantPolicy(
      first.secretId,
      { kind: "all_projects" },
    );
    await expect(
      harness.service.replaceSecureSecretAutomaticGrantPolicy(
        conflicting.secretId,
        { kind: "all_projects" },
      ),
    ).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    expect(harness.store.getAutomaticGrantPolicy(conflicting.secretId)).toEqual({
      kind: "none",
    });
    await harness.close();
  });

  it("rejects all-project limits and binding collisions inherited by archived projects", async () => {
    const harness = createHarness({ archivedProfiles: ["profile-a"] });
    const conflicting = await harness.service.createLocalSecureSecret({
      displayAlias: "archived-conflict",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ARCHIVED_ONLY" }],
    });
    harness.store.putProjectDefault({
      profileId: "profile-a",
      secretId: conflicting.secretId,
    });
    const proposed = await harness.service.createLocalSecureSecret({
      displayAlias: "global-conflict",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ARCHIVED_ONLY" }],
    });

    await expect(
      harness.service.replaceSecureSecretAutomaticGrantPolicy(
        proposed.secretId,
        { kind: "all_projects" },
      ),
    ).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });

    harness.store.replaceAutomaticGrantPolicy({
      secretId: conflicting.secretId,
      policy: { kind: "none" },
    });
    for (let index = 0; index < SECURE_SECRET_MAX_PROJECT_DEFAULTS; index += 1) {
      const defaultSecret = await harness.service.createLocalSecureSecret({
        displayAlias: `archived-limit-${index}`,
        encryptedMaterial: Buffer.from(`${ALPHA}-${index}`).toString("base64"),
        bindings: [{
          deliveryKind: "environment",
          targetName: `ARCHIVED_LIMIT_${index}`,
        }],
      });
      harness.store.putProjectDefault({
        profileId: "profile-a",
        secretId: defaultSecret.secretId,
      });
    }
    await expect(
      harness.service.replaceSecureSecretAutomaticGrantPolicy(
        proposed.secretId,
        { kind: "all_projects" },
      ),
    ).rejects.toMatchObject({
      code: "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
    });
    expect(harness.store.getAutomaticGrantPolicy(proposed.secretId)).toEqual({
      kind: "none",
    });
    await harness.close();
  });

  it("starts legacy over-limit projects with visible conflicts and no partial grants", async () => {
    const harness = createHarness();
    for (let index = 0; index <= SECURE_SECRET_MAX_PROJECT_DEFAULTS; index += 1) {
      const secret = await harness.service.createLocalSecureSecret({
        displayAlias: `legacy-default-${index}`,
        encryptedMaterial: Buffer.from(`${ALPHA}-${index}`).toString("base64"),
        bindings: [{
          deliveryKind: "environment",
          targetName: `LEGACY_DEFAULT_${index}`,
        }],
      });
      harness.store.putProjectDefault({
        profileId: "profile-a",
        secretId: secret.secretId,
      });
    }

    const started = await harness.service.startSecureSession("manager-a");
    expect(started.environmentStatus).toBe("ready");
    expect(started.leases).toEqual([]);
    expect(started.projectDefaults).toHaveLength(
      SECURE_SECRET_MAX_PROJECT_DEFAULTS + 1,
    );
    expect(started.projectDefaults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: "conflict",
        statusCode: "binding_conflict",
      }),
    ]));
    expect(started.projectDefaults.every(({ state }) => state === "conflict"))
      .toBe(true);
    expect(harness.sourceResolutions.size).toBe(0);
    await harness.close();
  });

  it("allows disabling a configured default hidden by a legacy project alias", async () => {
    const harness = createHarness();
    const globalSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "hidden-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "GLOBAL_HIDDEN" }],
    });
    await harness.service.setSecureSecretProjectDefault(globalSecret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    harness.store.createSecretWithBindings({
      secret: {
        secretId: "legacy-project-override",
        providerId: globalSecret.providerId,
        displayAlias: "hidden-default",
        scopeKind: "profile",
        profileId: "profile-a",
        retention: "saved",
        sourceLocator: "local",
        encryptedMaterial: Buffer.from(BETA),
      },
      bindings: [{
        bindingId: "legacy-project-override-binding",
        deliveryKind: "environment",
        targetName: "PROJECT_HIDDEN",
      }],
    });

    await expect(harness.service.setSecureSecretProjectDefault(
      globalSecret.secretId,
      { profileId: "profile-a", enabled: false },
    )).resolves.toBeNull();
    expect(await harness.service.listSecureSecretProjectDefaults("profile-a"))
      .toEqual([]);
    await harness.close();
  });

  it("attaches project defaults once with task provenance and isolates other projects", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "project-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "PROJECT_DEFAULT" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(secret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });

    const first = await harness.service.startSecureSession("manager-a");
    expect(first.leases).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        leaseKind: "task",
        grantSource: "project_default",
        status: "active",
      }),
    ]);
    expect(first.projectDefaults).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        state: "active",
        statusCode: "ok",
      }),
    ]);

    const repeated = await harness.service.startSecureSession("manager-a");
    expect(repeated.revision).toBe(first.revision);
    expect(repeated.leases).toHaveLength(1);
    const other = await harness.service.startSecureSession("manager-b");
    expect(other.leases).toEqual([]);
    expect(other.projectDefaults).toEqual([]);
    await harness.close();
  });

  it("satisfies matching pending requests when secure startup attaches project defaults", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "requested-project-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "REQUESTED_DEFAULT" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(secret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    const initialStart = await harness.service.startSecureSession("manager-a");
    await harness.service.stopSecureSession("manager-a", {
      baseRevision: initialStart.revision,
      stopProcesses: true,
    });
    await harness.service.requestSecureSecretAccess("manager-a", "tool-default", {
      displayAlias: "requested-project-default",
      exposures: [{ deliveryKind: "environment", targetName: "REQUESTED_DEFAULT" }],
      leaseKind: "task",
      purposeSummary: "Use the configured project credential",
    });
    expect((await harness.service.getSecureSessionSnapshot("manager-a"))
      .pendingRequests).toHaveLength(1);

    const started = await harness.service.startSecureSession("manager-a");

    expect(started.pendingRequests).toEqual([]);
    expect(started.leases.filter((lease) => lease.status === "active")).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        leaseKind: "task",
        grantSource: "project_default",
        status: "active",
      }),
    ]);
    await expect(harness.service.requestSecureSecretAccess(
      "manager-a",
      "tool-default-again",
      {
        displayAlias: "requested-project-default",
        exposures: [{ deliveryKind: "environment", targetName: "REQUESTED_DEFAULT" }],
        leaseKind: "task",
        purposeSummary: "Reuse the configured project credential",
      },
    )).resolves.toBe("already_granted");
    await harness.close();
  });

  it("keeps unrelated requests pending when secure startup attaches project defaults", async () => {
    const harness = createHarness();
    const defaultSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "startup-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "STARTUP_DEFAULT" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(defaultSecret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await harness.service.createLocalSecureSecret({
      displayAlias: "still-needs-approval",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "NEEDS_APPROVAL" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.requestSecureSecretAccess("manager-a", "tool-unrelated", {
      displayAlias: "still-needs-approval",
      exposures: [{ deliveryKind: "environment", targetName: "NEEDS_APPROVAL" }],
      leaseKind: "task",
      purposeSummary: "Use a separate project credential",
    });

    const started = await harness.service.startSecureSession("manager-a");

    expect(started.leases).toEqual([
      expect.objectContaining({ secretId: defaultSecret.secretId }),
    ]);
    expect(started.pendingRequests).toEqual([
      expect.objectContaining({ displayAlias: "still-needs-approval" }),
    ]);
    await harness.close();
  });

  it("does not fail secure startup when a matching request expired during preparation", async () => {
    let now = NOW;
    const harness = createHarness({ now: () => now });
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "expired-startup-request",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "EXPIRED_STARTUP" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(secret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await harness.service.requestSecureSecretAccess("manager-a", "tool-expired", {
      displayAlias: "expired-startup-request",
      exposures: [{ deliveryKind: "environment", targetName: "EXPIRED_STARTUP" }],
      leaseKind: "task",
      purposeSummary: "Use the project credential if approval remains current",
    });
    now = new Date(Date.parse(NOW) + 31 * 60 * 1_000).toISOString();

    const started = await harness.service.startSecureSession("manager-a");

    expect(started.environmentStatus).toBe("ready");
    expect(started.pendingRequests).toEqual([]);
    expect(started.leases).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        grantSource: "project_default",
        status: "active",
      }),
    ]);
    await harness.close();
  });

  it("satisfies matching pending requests when defaults are applied to an active session", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "active-project-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ACTIVE_DEFAULT" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.requestSecureSecretAccess("manager-a", "tool-active-default", {
      displayAlias: "active-project-default",
      exposures: [{ deliveryKind: "environment", targetName: "ACTIVE_DEFAULT" }],
      leaseKind: "task",
      purposeSummary: "Use a newly configured project credential",
    });
    await harness.service.setSecureSecretProjectDefault(secret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(pending.revision).toBeGreaterThan(started.revision);
    expect(pending.pendingRequests).toHaveLength(1);

    const applied = await harness.service.applySecureSessionProjectDefaults(
      "manager-a",
      { baseRevision: pending.revision },
    );

    expect(applied.pendingRequests).toEqual([]);
    expect(applied.leases).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        grantSource: "project_default",
        status: "active",
      }),
    ]);
    await harness.close();
  });

  it("keeps secure startup usable when one project default source is unavailable", async () => {
    const harness = createHarness({ failSourceResolutionAfter: 1 });
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "available-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "AVAILABLE_DEFAULT" }],
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "unavailable-default",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "UNAVAILABLE_DEFAULT" }],
    });
    await harness.service.setSecureSecretProjectDefault(alpha.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await harness.service.setSecureSecretProjectDefault(beta.secretId, {
      profileId: "profile-a",
      enabled: true,
    });

    const started = await harness.service.startSecureSession("manager-a");
    expect(started.environmentStatus).toBe("ready");
    expect(started.leases).toHaveLength(1);
    expect(started.projectDefaults).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "active", statusCode: "ok" }),
      expect.objectContaining({
        state: "unavailable",
        statusCode: "source_unavailable",
      }),
    ]));
    await harness.close();
  });

  it("applies newly configured project defaults once for the shared secure team", async () => {
    const harness = createHarness();
    const assignedWorker = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-1",
    );
    const idleWorker = workerDescriptor(
      "worker-idle",
      "manager-a",
      "profile-a",
      "/workspace-a",
    );
    harness.descriptors.set("worker-a", assignedWorker);
    harness.descriptors.set("worker-idle", idleWorker);
    await harness.service.startSecureSession("manager-a");

    const manual = await harness.service.createLocalSecureSecret({
      displayAlias: "manual-team-secret",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "MANUAL_TEAM_TOKEN" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    let managerSnapshot = await harness.service.getSecureSessionSnapshot("manager-a");
    managerSnapshot = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: managerSnapshot.revision,
      secretId: manual.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "MANUAL_TEAM_TOKEN" }],
      leaseKind: "task",
    });
    const validDefault = await harness.service.createLocalSecureSecret({
      displayAlias: "apply-valid-default",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "APPLY_VALID_DEFAULT" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    const conflictingDefault = await harness.service.createLocalSecureSecret({
      displayAlias: "apply-conflicting-default",
      encryptedMaterial: Buffer.from(`${BETA}-conflict`).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "MANUAL_TEAM_TOKEN" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(validDefault.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await harness.service.setSecureSecretProjectDefault(
      conflictingDefault.secretId,
      { profileId: "profile-a", enabled: true },
    );

    const ensuredBeforeApply = harness.execution.ensured.length;
    const emittedBeforeApply = harness.snapshots.length;
    const applied = await harness.service.applySecureSessionProjectDefaults(
      "manager-a",
      { baseRevision: managerSnapshot.revision },
    );
    const team = await harness.service.listSecureSessionTeamSnapshots("manager-a");
    expect(applied.sessionAgentId).toBe("manager-a");
    expect(harness.execution.ensured).toHaveLength(ensuredBeforeApply + 1);
    expect(harness.snapshots.slice(emittedBeforeApply).map(
      ({ sessionAgentId }) => sessionAgentId,
    )).toEqual(["manager-a"]);
    expect(team).toHaveLength(1);
    expect(team[0]).toEqual(expect.objectContaining({
      sessionAgentId: "manager-a",
      environmentStatus: "ready",
      leases: expect.arrayContaining([
        expect.objectContaining({
          secretId: validDefault.secretId,
          grantSource: "project_default",
          leaseKind: "task",
          status: "active",
        }),
        expect.objectContaining({
          secretId: manual.secretId,
          grantSource: "manual",
          status: "active",
        }),
      ]),
      projectDefaults: expect.arrayContaining([
        expect.objectContaining({
          secretId: conflictingDefault.secretId,
          state: "conflict",
          statusCode: "binding_conflict",
        }),
      ]),
    }));
    expect(await harness.service.getSecureSessionSnapshot("worker-a")).toEqual(
      team[0],
    );
    expect(await harness.service.getSecureSessionSnapshot("worker-idle")).toEqual(
      team[0],
    );

    const ensuredAfterApply = harness.execution.ensured.length;
    const leaseIdsBeforeRetry = team.flatMap(({ leases }) =>
      leases.filter((lease) => lease.grantSource === "project_default")
        .map(({ leaseId }) => leaseId)
    ).sort();
    const retried = await harness.service.applySecureSessionProjectDefaults(
      "manager-a",
      { baseRevision: applied.revision },
    );
    const retriedTeam = await harness.service.listSecureSessionTeamSnapshots(
      "manager-a",
    );
    expect(harness.execution.ensured).toHaveLength(ensuredAfterApply);
    expect(retriedTeam.flatMap(({ leases }) =>
      leases.filter((lease) => lease.grantSource === "project_default")
        .map(({ leaseId }) => leaseId)
    ).sort()).toEqual(leaseIdsBeforeRetry);
    expect(retried.revision).toBe(applied.revision);

    await harness.service.setSecureSecretProjectDefault(validDefault.secretId, {
      profileId: "profile-a",
      enabled: false,
    });
    const afterDisable = await harness.service.listSecureSessionTeamSnapshots(
      "manager-a",
    );
    for (const snapshot of afterDisable) {
      expect(snapshot.leases.some((lease) =>
        lease.secretId === validDefault.secretId
        && lease.grantSource === "project_default"
        && lease.status === "active"
      )).toBe(false);
    }
    expect(afterDisable).toHaveLength(1);
    expect(afterDisable[0]?.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        secretId: manual.secretId,
        grantSource: "manual",
        status: "active",
      }),
    ]));
    await harness.close();
  });

  it("keeps apply-project-default partial source failures fixed-code and non-blocking", async () => {
    const harness = createHarness({ failSourceResolutionAfter: 1 });
    await harness.service.startSecureSession("manager-a");
    const available = await harness.service.createLocalSecureSecret({
      displayAlias: "apply-available",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "APPLY_AVAILABLE" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    const unavailable = await harness.service.createLocalSecureSecret({
      displayAlias: "apply-unavailable",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "APPLY_UNAVAILABLE" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(available.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await harness.service.setSecureSecretProjectDefault(unavailable.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    const before = await harness.service.getSecureSessionSnapshot("manager-a");

    const applied = await harness.service.applySecureSessionProjectDefaults(
      "manager-a",
      { baseRevision: before.revision },
    );

    expect(applied.leases).toEqual([
      expect.objectContaining({
        secretId: available.secretId,
        grantSource: "project_default",
        status: "active",
      }),
    ]);
    expect(applied.projectDefaults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        secretId: available.secretId,
        state: "active",
        statusCode: "ok",
      }),
      expect.objectContaining({
        secretId: unavailable.secretId,
        state: "unavailable",
        statusCode: "source_unavailable",
      }),
    ]));
    await harness.close();
  });

  it("rejects stale apply-project-default revisions before any principal mutation", async () => {
    const harness = createHarness();
    harness.descriptors.set(
      "worker-a",
      workerDescriptor(
        "worker-a",
        "manager-a",
        "profile-a",
        "/workspace-a",
        "assignment-1",
      ),
    );
    await harness.service.startSecureSession("manager-a");
    const projectDefault = await harness.service.createLocalSecureSecret({
      displayAlias: "stale-apply-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "STALE_APPLY_DEFAULT" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(projectDefault.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    const manager = await harness.service.getSecureSessionSnapshot("manager-a");
    const statesBefore = harness.store.listPrincipalSnapshotsForManager("manager-a");
    const ensuredBefore = [...harness.execution.ensured];
    const destroyedBefore = [...harness.execution.destroyed];
    const emittedBefore = harness.snapshots.length;

    await expect(harness.service.applySecureSessionProjectDefaults(
      "manager-a",
      { baseRevision: manager.revision + 1 },
    )).rejects.toThrow("SECURE_STALE_REVISION");

    expect(harness.store.listPrincipalSnapshotsForManager("manager-a"))
      .toEqual(statesBefore);
    expect(harness.execution.ensured).toEqual(ensuredBefore);
    expect(harness.execution.destroyed).toEqual(destroyedBefore);
    expect(harness.snapshots).toHaveLength(emittedBefore);
    await harness.close();
  });

  it("never reports a project default active after startup recycle fails", async () => {
    const harness = createHarness({ recycleDisposition: "deferred" });
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "failed-start-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "FAILED_START_DEFAULT" }],
    });
    await harness.service.setSecureSecretProjectDefault(secret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });

    await expect(harness.service.startSecureSession("manager-a"))
      .rejects.toMatchObject({ code: "SECURE_OPERATION_FAILED" });
    const failed = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(failed.environmentStatus).toBe("stopped");
    expect(failed.leases).toEqual([
      expect.objectContaining({ status: "revoked" }),
    ]);
    expect(failed.projectDefaults).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        state: "configured",
        statusCode: "ok",
      }),
    ]);
    await harness.close();
  });

  it("never reports a project default active after fail-closed execution", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "fail-closed-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "FAIL_CLOSED_DEFAULT" }],
    });
    await harness.service.setSecureSecretProjectDefault(secret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await harness.service.startSecureSession("manager-a");
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const execution = binding.executeBash({
      secretAliases: [],
      command: "wait-for-release",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await harness.execution.waitForBlockedExecution("manager-a");
    harness.execution.rejectBlockedExecution("manager-a");
    await expect(execution).rejects.toMatchObject({
      code: "SECURE_OPERATION_FAILED",
    });

    const failed = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(failed.environmentStatus).toBe("failed");
    expect(failed.leases).toEqual([
      expect.objectContaining({ status: "revoked" }),
    ]);
    expect(failed.projectDefaults).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        state: "configured",
        statusCode: "ok",
      }),
    ]);
    await harness.close();
  });

  it("downgrades project-default status when secret rotation revokes its lease", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "rotated-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ROTATED_DEFAULT" }],
    });
    await harness.service.setSecureSecretProjectDefault(secret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await harness.service.startSecureSession("manager-a");

    await harness.service.updateSecureSecret(secret.secretId, {
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
    });
    const rotated = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(rotated.leases).toEqual([
      expect.objectContaining({ status: "revoked" }),
    ]);
    expect(rotated.projectDefaults).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        state: "configured",
        statusCode: "ok",
      }),
    ]);
    await harness.close();
  });

  it("rejects conflicting project defaults before starting a session", async () => {
    const harness = createHarness();
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "default-alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SHARED_DEFAULT" }],
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "default-beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "askpass", targetName: "SHARED_DEFAULT" }],
    });
    await harness.service.setSecureSecretProjectDefault(alpha.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await expect(harness.service.setSecureSecretProjectDefault(beta.secretId, {
      profileId: "profile-a",
      enabled: true,
    })).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    expect(await harness.service.listSecureSecretProjectDefaults("profile-a"))
      .toHaveLength(1);
    await harness.close();
  });

  it("serializes default resolution against a project override creation", async () => {
    const harness = createHarness({ blockSourceResolution: true });
    const globalSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "serialized",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SERIALIZED_TOKEN" }],
    });
    await harness.service.setSecureSecretProjectDefault(globalSecret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });

    const starting = harness.service.startSecureSession("manager-a");
    await harness.waitForBlockedSourceResolution();
    let overrideSettled = false;
    const creatingOverride = harness.service.createLocalSecureSecret({
      displayAlias: "serialized",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "PROJECT_SERIALIZED_TOKEN" }],
      scope: { kind: "profile", profileId: "profile-a" },
    }).finally(() => {
      overrideSettled = true;
    });
    await Promise.resolve();
    expect(overrideSettled).toBe(false);

    harness.releaseBlockedSourceResolution();
    await expect(starting).resolves.toEqual(expect.objectContaining({
      leases: [expect.objectContaining({
        secretId: globalSecret.secretId,
        grantSource: "project_default",
      })],
    }));
    await expect(creatingOverride).rejects.toMatchObject({
      code: "SECURE_REQUEST_INVALID",
    });
    await harness.close();
  });

  it("serializes default disable behind an in-progress secure start", async () => {
    const harness = createHarness({ blockSourceResolution: true });
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "disable-race",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "DISABLE_RACE" }],
    });
    await harness.service.setSecureSecretProjectDefault(secret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    const starting = harness.service.startSecureSession("manager-a");
    await harness.waitForBlockedSourceResolution();
    let disableSettled = false;
    const disabling = harness.service.setSecureSecretProjectDefault(secret.secretId, {
      profileId: "profile-a",
      enabled: false,
    }).finally(() => {
      disableSettled = true;
    });
    await Promise.resolve();
    expect(disableSettled).toBe(false);

    harness.releaseBlockedSourceResolution();
    await expect(starting).resolves.toEqual(expect.objectContaining({
      leases: [expect.objectContaining({ status: "active" })],
    }));
    await expect(disabling).resolves.toBeNull();
    expect(await harness.service.listSecureSecretProjectDefaults("profile-a"))
      .toEqual([]);
    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.leases).toEqual([
      expect.objectContaining({ status: "revoked" }),
    ]);
    expect(after.environmentStatus).toBe("stopped");
    await harness.close();
  });

  it("keeps catalog and project-default configuration Dockerless until secure start", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "dockerless",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "DOCKERLESS_TOKEN" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(secret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    await harness.service.listSecureSecrets();
    await harness.service.listSecureSecretProjectDefaults();

    expect(harness.execution.ensured).toEqual([]);
    expect(harness.execution.destroyed).toEqual([]);
    expect(harness.sourceResolutions.size).toBe(0);
    await harness.close();
  });

  it("rebuilds with a remaining manual lease when a project default is disabled", async () => {
    const harness = createHarness();
    const automatic = await harness.service.createLocalSecureSecret({
      displayAlias: "automatic",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "AUTOMATIC_TOKEN" }],
    });
    const manual = await harness.service.createLocalSecureSecret({
      displayAlias: "manual",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "MANUAL_TOKEN" }],
    });
    await harness.service.setSecureSecretProjectDefault(automatic.secretId, {
      profileId: "profile-a",
      enabled: true,
    });
    const started = await harness.service.startSecureSession("manager-a");
    const withManual = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: manual.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "MANUAL_TOKEN" }],
      leaseKind: "task",
    });

    await harness.service.setSecureSecretProjectDefault(automatic.secretId, {
      profileId: "profile-a",
      enabled: false,
    });
    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.environmentStatus).toBe("ready");
    expect(after.leases.find(({ secretId }) => secretId === automatic.secretId))
      .toEqual(expect.objectContaining({ status: "revoked" }));
    expect(after.leases.find(({ secretId }) => secretId === manual.secretId))
      .toEqual(expect.objectContaining({
        status: "active",
        grantSource: "manual",
      }));
    expect(after.revision).toBeGreaterThan(withManual.revision);
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    );
    await expect(binding?.executeBash({
      secretAliases: [],
      command: "safe-beta",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).resolves.toEqual({ exitCode: 0 });
    await harness.close();
  });

  it("rebuilds remaining authority when an active secret is updated", async () => {
    const harness = createHarness();
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "updated-alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "UPDATED_ALPHA" }],
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "remaining-beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "REMAINING_BETA" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const withAlpha = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: alpha.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "UPDATED_ALPHA" }],
      leaseKind: "task",
    });
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: withAlpha.revision,
      secretId: beta.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "REMAINING_BETA" }],
      leaseKind: "task",
    });

    await harness.service.updateSecureSecret(alpha.secretId, {
      displayName: "Rotated metadata",
    });
    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.environmentStatus).toBe("ready");
    expect(after.leases.find(({ secretId }) => secretId === alpha.secretId))
      .toEqual(expect.objectContaining({ status: "revoked" }));
    expect(after.leases.find(({ secretId }) => secretId === beta.secretId))
      .toEqual(expect.objectContaining({ status: "active" }));
    await expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )?.executeBash({
      secretAliases: [],
      command: "safe-beta",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).resolves.toEqual({ exitCode: 0 });
    await harness.close();
  });

  it("fulfills missing requests as session-only or saved project defaults", async () => {
    const ephemeral = createHarness();
    await ephemeral.service.requestSecureSecretAccess("manager-a", "ephemeral-tool", {
      displayAlias: "ephemeral",
      exposures: [{ deliveryKind: "environment", targetName: "EPHEMERAL_TOKEN" }],
      leaseKind: "one_use",
      purposeSummary: "Use an ephemeral credential",
    });
    const ephemeralPending = await ephemeral.service.getSecureSessionSnapshot("manager-a");
    const ephemeralResult = await ephemeral.service.fulfillSecureAccessRequest(
      "manager-a",
      ephemeralPending.pendingRequests[0]!.requestId,
      {
        baseRevision: ephemeralPending.revision,
        displayAlias: "ephemeral",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        exposures: [{ deliveryKind: "environment", targetName: "EPHEMERAL_TOKEN" }],
        retention: "session",
        leaseKind: "one_use",
      },
    );
    expect(ephemeralResult.leases[0]).toEqual(expect.objectContaining({
      grantSource: "access_request",
    }));
    expect((await ephemeral.service.listSecureSecrets())
      .some(({ displayAlias }) => displayAlias === "ephemeral")).toBe(false);
    await ephemeral.close();

    const saved = createHarness();
    await saved.service.requestSecureSecretAccess("manager-a", "saved-tool", {
      displayAlias: "saved",
      exposures: [{ deliveryKind: "environment", targetName: "SAVED_TOKEN" }],
      leaseKind: "task",
      purposeSummary: "Save a reusable project credential",
    });
    const savedPending = await saved.service.getSecureSessionSnapshot("manager-a");
    const savedResult = await saved.service.fulfillSecureAccessRequest(
      "manager-a",
      savedPending.pendingRequests[0]!.requestId,
      {
        baseRevision: savedPending.revision,
        displayAlias: "saved",
        encryptedMaterial: Buffer.from(BETA).toString("base64"),
        exposures: [{ deliveryKind: "environment", targetName: "SAVED_TOKEN" }],
        retention: "saved",
        scope: { kind: "profile", profileId: "profile-a" },
        makeProjectDefault: true,
        leaseKind: "task",
      },
    );
    const savedSecret = (await saved.service.listSecureSecrets())
      .find(({ displayAlias }) => displayAlias === "saved");
    expect(savedSecret).toEqual(expect.objectContaining({
      scope: { kind: "profile", profileId: "profile-a" },
      retention: "saved",
    }));
    expect(await saved.service.listSecureSecretProjectDefaults("profile-a"))
      .toEqual([expect.objectContaining({ secretId: savedSecret!.secretId })]);
    expect(savedResult.leases[0]).toEqual(expect.objectContaining({
      secretId: savedSecret!.secretId,
      grantSource: "access_request",
    }));
    await saved.close();
  });

  it("keeps fulfillment pending when guard preflight fails", async () => {
    const harness = createHarness({ guardFailures: 1 });
    await harness.service.requestSecureSecretAccess("manager-a", "guard-tool", {
      displayAlias: "guarded",
      exposures: [{ deliveryKind: "environment", targetName: "GUARDED_TOKEN" }],
      leaseKind: "task",
      purposeSummary: "Exercise guard preflight",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    const requestId = pending.pendingRequests[0]!.requestId;

    await expect(harness.service.fulfillSecureAccessRequest(
      "manager-a",
      requestId,
      {
        baseRevision: pending.revision,
        displayAlias: "guarded",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        exposures: [{ deliveryKind: "environment", targetName: "GUARDED_TOKEN" }],
        retention: "saved",
        scope: { kind: "profile", profileId: "profile-a" },
        makeProjectDefault: true,
        leaseKind: "task",
      },
    )).rejects.toMatchObject({ code: "SECURE_OPERATION_FAILED" });

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.pendingRequests).toEqual([
      expect.objectContaining({ requestId }),
    ]);
    expect(after.leases).toEqual([]);
    expect((await harness.service.listSecureSecrets())
      .some(({ displayAlias }) => displayAlias === "guarded")).toBe(false);
    expect(await harness.service.listSecureSecretProjectDefaults("profile-a"))
      .toEqual([]);
    await harness.close();
  });

  it("rolls back saved fulfillment atomically on an alias conflict", async () => {
    const harness = createHarness();
    await harness.service.requestSecureSecretAccess("manager-a", "alias-tool", {
      displayAlias: "late-alias",
      exposures: [{ deliveryKind: "environment", targetName: "LATE_ALIAS_TOKEN" }],
      leaseKind: "task",
      purposeSummary: "Exercise transactional alias conflict",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    await harness.service.createLocalSecureSecret({
      displayAlias: "late-alias",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "LATE_ALIAS_TOKEN" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });

    await expect(harness.service.fulfillSecureAccessRequest(
      "manager-a",
      pending.pendingRequests[0]!.requestId,
      {
        baseRevision: pending.revision,
        displayAlias: "late-alias",
        encryptedMaterial: Buffer.from(BETA).toString("base64"),
        exposures: [{ deliveryKind: "environment", targetName: "LATE_ALIAS_TOKEN" }],
        retention: "saved",
        scope: { kind: "profile", profileId: "profile-a" },
        makeProjectDefault: true,
        leaseKind: "task",
      },
    )).rejects.toMatchObject({ code: "SECURE_SECRET_ALIAS_CONFLICT" });

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.pendingRequests).toEqual([
      expect.objectContaining({ requestId: pending.pendingRequests[0]!.requestId }),
    ]);
    expect(after.leases).toEqual([]);
    expect((await harness.service.listSecureSecrets()).filter(
      ({ displayAlias }) => displayAlias === "late-alias",
    )).toHaveLength(1);
    expect(await harness.service.listSecureSecretProjectDefaults("profile-a"))
      .toEqual([]);
    await harness.close();
  });

  it("rejects private auto-default fulfillment at the shared limit without artifacts", async () => {
    const harness = createHarness();
    for (let index = 0; index < SECURE_SECRET_MAX_PROJECT_DEFAULTS; index += 1) {
      const secret = await harness.service.createLocalSecureSecret({
        displayAlias: `private-limit-${index}`,
        encryptedMaterial: Buffer.from(`${ALPHA}-${index}`).toString("base64"),
        bindings: [{
          deliveryKind: "environment",
          targetName: `PRIVATE_LIMIT_${index}`,
        }],
      });
      await harness.service.setSecureSecretProjectDefault(secret.secretId, {
        profileId: "profile-a",
        enabled: true,
      });
    }
    await harness.service.requestSecureSecretAccess("manager-a", "limit-tool", {
      displayAlias: "private-limit-overflow",
      exposures: [{ deliveryKind: "environment", targetName: "PRIVATE_LIMIT_OVERFLOW" }],
      leaseKind: "task",
      purposeSummary: "Exercise the private default limit",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    const requestId = pending.pendingRequests[0]!.requestId;

    await expect(harness.service.fulfillSecureAccessRequest(
      "manager-a",
      requestId,
      {
        baseRevision: pending.revision,
        displayAlias: "private-limit-overflow",
        encryptedMaterial: Buffer.from(BETA).toString("base64"),
        exposures: [{
          deliveryKind: "environment",
          targetName: "PRIVATE_LIMIT_OVERFLOW",
        }],
        retention: "saved",
        scope: { kind: "profile", profileId: "profile-a" },
        makeProjectDefault: true,
        leaseKind: "task",
      },
    )).rejects.toMatchObject({
      code: "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
    });

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.pendingRequests).toEqual([
      expect.objectContaining({ requestId }),
    ]);
    expect(after.leases).toEqual([]);
    expect((await harness.service.listSecureSecrets())
      .some(({ displayAlias }) => displayAlias === "private-limit-overflow"))
      .toBe(false);
    expect(await harness.service.listSecureSecretProjectDefaults("profile-a"))
      .toHaveLength(SECURE_SECRET_MAX_PROJECT_DEFAULTS);
    expect(harness.execution.ensured).toEqual([]);
    await harness.close();
  });

  it("rejects private fulfillment that would shadow a configured instance default", async () => {
    const harness = createHarness();
    await harness.service.requestSecureSecretAccess("manager-a", "shadow-tool", {
      displayAlias: "late-shadow",
      exposures: [{ deliveryKind: "environment", targetName: "LATE_SHADOW" }],
      leaseKind: "task",
      purposeSummary: "Exercise the project alias invariant",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    const requestId = pending.pendingRequests[0]!.requestId;
    const globalSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "late-shadow",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "GLOBAL_LATE_SHADOW" }],
    });
    await harness.service.setSecureSecretProjectDefault(globalSecret.secretId, {
      profileId: "profile-a",
      enabled: true,
    });

    await expect(harness.service.fulfillSecureAccessRequest(
      "manager-a",
      requestId,
      {
        baseRevision: pending.revision,
        displayAlias: "late-shadow",
        encryptedMaterial: Buffer.from(BETA).toString("base64"),
        exposures: [{ deliveryKind: "environment", targetName: "LATE_SHADOW" }],
        retention: "saved",
        scope: { kind: "profile", profileId: "profile-a" },
        makeProjectDefault: true,
        leaseKind: "task",
      },
    )).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.pendingRequests).toEqual([
      expect.objectContaining({ requestId }),
    ]);
    expect(after.leases).toEqual([]);
    expect((await harness.service.listSecureSecrets()).filter(
      ({ displayAlias }) => displayAlias === "late-shadow",
    )).toEqual([expect.objectContaining({ secretId: globalSecret.secretId })]);
    expect(await harness.service.listSecureSecretProjectDefaults("profile-a"))
      .toEqual([expect.objectContaining({ secretId: globalSecret.secretId })]);
    expect(harness.execution.ensured).toEqual([]);
    await harness.close();
  });

  it("expires pending requests before status, approval, or fulfillment", async () => {
    let logicalNow = Date.parse(NOW);
    const harness = createHarness({
      now: () => new Date(logicalNow).toISOString(),
    });
    await harness.service.requestSecureSecretAccess("manager-a", "expiring-tool", {
      displayAlias: "expiring",
      exposures: [{ deliveryKind: "stdin" }],
      leaseKind: "task",
      purposeSummary: "Exercise request expiry",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    logicalNow += 30 * 60 * 1000;

    const expired = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(expired.pendingRequests).toEqual([]);
    expect(expired.revision).toBe(pending.revision + 1);
    await expect(harness.service.resolveSecureAccessRequest(
      "manager-a",
      pending.pendingRequests[0]!.requestId,
      {
        baseRevision: pending.revision,
        requestId: pending.pendingRequests[0]!.requestId,
        decision: "approve",
      },
    )).rejects.toMatchObject({ code: "SECURE_STALE_REVISION" });
    await harness.close();
  });

  it("automatically expires pending requests without an active secure environment", async () => {
    vi.useFakeTimers();
    let logicalNow = Date.parse(NOW);
    const harness = createHarness({
      now: () => new Date(logicalNow).toISOString(),
    });
    try {
      await harness.service.requestSecureSecretAccess(
        "manager-a",
        "automatic-expiry-tool",
        {
          displayAlias: "automatic-expiry",
          exposures: [{ deliveryKind: "stdin" }],
          leaseKind: "task",
          purposeSummary: "Exercise autonomous request expiry",
        },
      );
      logicalNow += 5 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await harness.service.requestSecureSecretAccess(
        "manager-a",
        "later-expiry-tool",
        {
          displayAlias: "later-expiry",
          exposures: [{ deliveryKind: "stdin" }],
          leaseKind: "task",
          purposeSummary: "Verify the next request is rescheduled",
        },
      );
      const pending = harness.store.getSnapshot("manager-a");
      expect(pending.requests).toHaveLength(2);
      expect(harness.execution.ensured).toEqual([]);

      logicalNow += 25 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);

      const afterFirstExpiry = harness.store.getSnapshot("manager-a");
      expect(afterFirstExpiry.requests).toEqual([
        expect.objectContaining({ displayAlias: "later-expiry" }),
      ]);
      expect(harness.snapshots.at(-1)).toEqual(expect.objectContaining({
        revision: pending.state.revision + 1,
        pendingRequests: [
          expect.objectContaining({ displayAlias: "later-expiry" }),
        ],
      }));

      logicalNow += 5 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(harness.store.getSnapshot("manager-a").requests).toEqual([]);
      expect(harness.snapshots.at(-1)).toEqual(expect.objectContaining({
        revision: pending.state.revision + 2,
        pendingRequests: [],
      }));
      expect(harness.execution.ensured).toEqual([]);
    } finally {
      await harness.close();
      vi.useRealTimers();
    }
  });

  it("approves a missing-alias request with a newly saved selected secret", async () => {
    const harness = createHarness();
    await harness.service.requestSecureSecretAccess("manager-a", "selected-tool", {
      displayAlias: "selected",
      exposures: [{ deliveryKind: "environment", targetName: "SELECTED_TOKEN" }],
      leaseKind: "task",
      purposeSummary: "Use a separately saved reference",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "selected",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SELECTED_TOKEN" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    const approved = await harness.service.resolveSecureAccessRequest(
      "manager-a",
      pending.pendingRequests[0]!.requestId,
      {
        baseRevision: pending.revision,
        requestId: pending.pendingRequests[0]!.requestId,
        decision: "approve",
        selectedSecretId: secret.secretId,
      },
    );
    expect(approved.pendingRequests).toEqual([]);
    expect(approved.leases).toEqual([
      expect.objectContaining({
        secretId: secret.secretId,
        grantSource: "access_request",
      }),
    ]);
    await harness.close();
  });

  it("reconciles ghost-ready persisted state and rolls back a recycle failure", async () => {
    const ghost = createHarness();
    ghost.store.getOrCreateSessionState("manager-a", {
      profileId: "profile-a",
      executionMode: "secure",
      environmentStatus: "ready",
    });
    const reconciled = await ghost.service.getSecureSessionSnapshot("manager-a");
    expect(reconciled.environmentStatus).toBe("failed");
    expect(ghost.execution.destroyed).toContain("manager-a");
    await ghost.close();

    const failedRecycle = createHarness({ recycleThrows: true });
    await expect(
      failedRecycle.service.startSecureSession("manager-a"),
    ).rejects.toThrow("SECURE_OPERATION_FAILED");
    const failed = await failedRecycle.service.getSecureSessionSnapshot("manager-a");
    expect(failed.environmentStatus).toBe("failed");
    expect(failedRecycle.service.getSecureRuntimeBinding(
      failedRecycle.descriptors.get("manager-a")!,
    )).toBeUndefined();
    await failedRecycle.close();

    const deferredRecycle = createHarness({ recycleDisposition: "deferred" });
    await expect(
      deferredRecycle.service.startSecureSession("manager-a"),
    ).rejects.toThrow("SECURE_OPERATION_FAILED");
    const rolledBack = await deferredRecycle.service.getSecureSessionSnapshot("manager-a");
    expect(rolledBack).toEqual(expect.objectContaining({
      executionMode: "standard",
      environmentStatus: "stopped",
    }));
    expect(deferredRecycle.service.getSecureRuntimeBinding(
      deferredRecycle.descriptors.get("manager-a")!,
    )).toBeUndefined();
    await deferredRecycle.close();
  });

  it("redacts protected output, preserves task leases, and emits only fixed state metadata", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const binding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-a")!)!;
    const output: string[] = [];
    const destroyedBeforeReflection = harness.execution.destroyed.length;
    await expect(binding.executeBash({
      secretAliases: ["alpha"],
      command: "emit-own-canary",
      cwd: "/workspace-a",
      onData: (bytes) => output.push(Buffer.from(bytes).toString("utf8")),
    })).resolves.toEqual({ exitCode: 0 });

    expect(output.join("")).toBe(SECURE_OUTPUT_QUARANTINE);
    expect(harness.execution.destroyed).toHaveLength(destroyedBeforeReflection);
    const safeOutput: string[] = [];
    await expect(binding.executeBash({
      secretAliases: [],
      command: "emit-safe-output",
      cwd: "/workspace-a",
      onData: (bytes) => safeOutput.push(Buffer.from(bytes).toString("utf8")),
    })).resolves.toEqual({ exitCode: 0 });
    expect(safeOutput.join("")).toBe("safe");
    const eventJson = JSON.stringify(harness.snapshots);
    expect(eventJson).not.toContain(ALPHA);
    expect(harness.snapshots.at(-1)).toEqual(expect.objectContaining({
      environmentStatus: "ready",
      outputState: "quarantined",
      outputStateCode: "SECURE_OUTPUT_QUARANTINED",
      leases: [expect.objectContaining({ status: "active" })],
    }));
    await harness.close();
  });

  it("guards host Bash output before accumulation without consuming its lease", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "one_use",
    });
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const executedBefore = harness.execution.executed.length;
    const guard = binding.createOutputGuard();

    const first = guard.write(Buffer.from(`before:${ALPHA.slice(0, 7)}`));
    const second = guard.write(Buffer.from(`${ALPHA.slice(7)}:after`));
    const tail = await guard.close();

    const guardedOutput = Buffer.concat([first, second, tail]).toString("utf8");
    expect(guardedOutput).not.toContain(ALPHA);
    expect(guardedOutput).toContain(SECURE_OUTPUT_QUARANTINE);
    expect(harness.execution.executed).toHaveLength(executedBefore);
    expect(await harness.service.getSecureSessionSnapshot("manager-a")).toEqual(
      expect.objectContaining({
        environmentStatus: "ready",
        outputState: "quarantined",
        outputStateCode: "SECURE_OUTPUT_QUARANTINED",
        leases: [expect.objectContaining({
          status: "active",
          remainingUses: 1,
        })],
      }),
    );
    await harness.close();
  });

  it("passes host Bash output through when the secure session has no grants", async () => {
    const harness = createHarness();
    await harness.service.startSecureSession("manager-a");
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const guard = binding.createOutputGuard();

    expect(guard.write(Buffer.from("ordinary host output"))).toEqual(
      Buffer.from("ordinary host output"),
    );
    expect(await guard.close()).toEqual(Buffer.alloc(0));
    expect(await harness.service.getSecureSessionSnapshot("manager-a")).toEqual(
      expect.objectContaining({ outputState: "clear" }),
    );
    await harness.close();
  });

  it("invalidates an in-flight host output guard when grants change", async () => {
    const harness = createHarness();
    await harness.service.startSecureSession("manager-a");
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const hostGuard = binding.createOutputGuard();
    expect(hostGuard.write(Buffer.from("safe-before-grant"))).toEqual(
      Buffer.from("safe-before-grant"),
    );

    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const beforeGrant = await harness.service.getSecureSessionSnapshot("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: beforeGrant.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "task",
    });

    expect(() => hostGuard.write(Buffer.from("after-grant"))).toThrow(
      "SECURE_OPERATION_FAILED",
    );
    await expect(hostGuard.close()).rejects.toThrow("SECURE_OPERATION_FAILED");
    await harness.close();
  });

  it("does not treat the public redaction marker as proof that a secret matched", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const binding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-a")!)!;
    const output: string[] = [];

    await expect(binding.executeBash({
      secretAliases: [],
      command: "emit-public-marker",
      cwd: "/workspace-a",
      onData: (bytes) => output.push(Buffer.from(bytes).toString("utf8")),
    })).resolves.toEqual({ exitCode: 0 });

    expect(output.join("")).toBe(SECURE_OUTPUT_QUARANTINE);
    expect(await harness.service.getSecureSessionSnapshot("manager-a")).toEqual(
      expect.objectContaining({
        environmentStatus: "ready",
        outputState: "clear",
      }),
    );
    await harness.close();
  });

  it("consumes a one-use lease after redacting the credentialed command output", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "one_use",
    });
    const binding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-a")!)!;

    await expect(binding.executeBash({
      secretAliases: ["alpha"],
      command: "emit-own-canary",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).resolves.toEqual({ exitCode: 0 });

    expect(await harness.service.getSecureSessionSnapshot("manager-a")).toEqual(
      expect.objectContaining({
        environmentStatus: "stopped",
        outputState: "quarantined",
        leases: [expect.objectContaining({
          status: "consumed",
          remainingUses: 0,
        })],
      }),
    );
    await harness.close();
  });

  it("starts one manager-owned sandbox and recycles every eligible current worker into it", async () => {
    const harness = createHarness();
    harness.descriptors.set(
      "worker-a",
      workerDescriptor(
        "worker-a",
        "manager-a",
        "profile-a",
        "/workspace-a",
        "assignment-1",
      ),
    );

    const manager = await harness.service.startSecureSession("manager-a");
    const snapshots = await harness.service.listSecureSessionTeamSnapshots(
      "manager-a",
    );

    expect(manager).toEqual(expect.objectContaining({
      principalKind: "manager",
      ownerManagerAgentId: null,
      workerAssignmentId: null,
      environmentStatus: "ready",
    }));
    expect(snapshots).toEqual([
      expect.objectContaining({
        sessionAgentId: "manager-a",
        principalKind: "manager",
      }),
    ]);
    expect(harness.store.getSessionState("worker-a")).toBeNull();
    expect(harness.execution.ensured).toEqual(["manager-a"]);
    expect(harness.recycles).toEqual(["manager-a", "worker-a"]);
    expect(
      harness.service.getSecureRuntimeBinding(
        harness.descriptors.get("worker-a")!,
      ),
    ).toBeDefined();
    await harness.close();
  });

  it("lets an idle worker inherit manager defaults without creating worker authority", async () => {
    const harness = createHarness();
    const worker = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
    );
    harness.descriptors.set("worker-a", worker);
    const projectDefault = await harness.service.createLocalSecureSecret({
      displayAlias: "project-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "PROJECT_DEFAULT" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(
      projectDefault.secretId,
      { profileId: "profile-a", enabled: true },
    );

    await harness.service.startSecureSession("manager-a");
    expect(harness.recycles).toEqual(["manager-a", "worker-a"]);
    expect(harness.execution.ensured).toEqual(["manager-a"]);
    const managerSnapshot = await harness.service.getSecureSessionSnapshot(
      "manager-a",
    );
    const idleWorkerSnapshot = await harness.service.getSecureSessionSnapshot(
      "worker-a",
    );
    expect(idleWorkerSnapshot).toEqual(managerSnapshot);
    expect(idleWorkerSnapshot).toEqual(expect.objectContaining({
      sessionAgentId: "manager-a",
      principalKind: "manager",
      executionMode: "secure",
      environmentStatus: "ready",
      leases: [
        expect.objectContaining({
          secretId: projectDefault.secretId,
          grantSource: "project_default",
          status: "active",
        }),
      ],
    }));
    expect(managerSnapshot.leases[0]?.leaseId).toBe(
      idleWorkerSnapshot.leases[0]?.leaseId,
    );
    expect(harness.store.getSessionState("worker-a")).toBeNull();
    expect(harness.service.getSecureRuntimeBinding(worker)).toBeUndefined();

    Object.assign(worker, {
      workerParentContext: {
        schemaVersion: 1,
        assignmentId: "assignment-1",
        managerId: "manager-a",
        assignedAt: NOW,
        outputTarget: { kind: "manager" },
      },
    });
    await harness.service.advanceWorkerSecureAssignment(
      "worker-a",
      "assignment-1",
    );
    expect(harness.execution.ensured).toEqual(["manager-a"]);
    expect(
      (await harness.service.getSecureSessionSnapshot("worker-a")).leases
        .filter((lease) => lease.grantSource === "project_default"),
    ).toHaveLength(1);
    expect(harness.service.getSecureRuntimeBinding(worker)).toBeDefined();
    await harness.close();
  });

  it("starts the manager immediately while a streaming worker defers its secure transition", async () => {
    const harness = createHarness({
      recycleDispositionForAgent: (agentId) =>
        agentId === "worker-streaming" ? "deferred" : "recycled",
    });
    const streamingWorker = workerDescriptor(
      "worker-streaming",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-1",
    );
    streamingWorker.status = "streaming";
    harness.descriptors.set(streamingWorker.agentId, streamingWorker);
    const idleWorker = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
    );
    harness.descriptors.set(idleWorker.agentId, idleWorker);

    await expect(harness.service.startSecureSession("manager-a"))
      .resolves.toEqual(expect.objectContaining({
        executionMode: "secure",
        environmentStatus: "ready",
      }));
    expect(harness.store.listSessionStates()).toEqual([
      expect.objectContaining({
        sessionAgentId: "manager-a",
        executionMode: "secure",
        environmentStatus: "ready",
      }),
    ]);
    expect(harness.execution.ensured).toEqual(["manager-a"]);
    expect(harness.recycles).toEqual([
      "manager-a",
      "worker-streaming",
      "worker-a",
    ]);
    await harness.close();
  });

  it("gives a late worker the existing manager default without duplicating it", async () => {
    const harness = createHarness();
    const projectDefault = await harness.service.createLocalSecureSecret({
      displayAlias: "late-project-default",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{
        deliveryKind: "environment",
        targetName: "LATE_PROJECT_DEFAULT",
      }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.setSecureSecretProjectDefault(
      projectDefault.secretId,
      { profileId: "profile-a", enabled: true },
    );
    await harness.service.startSecureSession("manager-a");

    const worker = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
    );
    harness.descriptors.set("worker-a", worker);
    await expect(harness.service.prepareWorkerForSecureTeam("worker-a"))
      .resolves.toBe(true);
    const prepared = await harness.service.getSecureSessionSnapshot("worker-a");
    expect(prepared).toEqual(expect.objectContaining({
      sessionAgentId: "manager-a",
      environmentStatus: "ready",
      workerAssignmentId: null,
      leases: [
        expect.objectContaining({
          secretId: projectDefault.secretId,
          grantSource: "project_default",
          status: "active",
        }),
      ],
    }));

    Object.assign(worker, {
      workerParentContext: {
        schemaVersion: 1,
        assignmentId: "assignment-1",
        managerId: "manager-a",
        assignedAt: NOW,
        outputTarget: { kind: "manager" },
      },
    });
    await harness.service.advanceWorkerSecureAssignment(
      "worker-a",
      "assignment-1",
    );
    const assigned = await harness.service.getSecureSessionSnapshot("worker-a");
    expect(assigned.leases.filter(
      (lease) => lease.grantSource === "project_default",
    )).toHaveLength(1);
    expect(assigned.leases[0]?.leaseId).toBe(prepared.leases[0]?.leaseId);
    expect(harness.store.getSessionState("worker-a")).toBeNull();
    expect(harness.execution.ensured).toEqual(["manager-a"]);
    expect(harness.service.getSecureRuntimeBinding(worker)).toBeDefined();
    await harness.close();
  });

  it("stops the one shared sandbox and invalidates every team binding", async () => {
    const harness = createHarness();
    const worker = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-1",
    );
    harness.descriptors.set("worker-a", worker);
    const started = await harness.service.startSecureSession("manager-a");

    const stopped = await harness.service.stopSecureSession("manager-a", {
      baseRevision: started.revision,
      stopProcesses: true,
    });

    expect(stopped).toEqual(expect.objectContaining({
      principalKind: "manager",
      executionMode: "standard",
      environmentStatus: "stopped",
    }));
    expect(harness.store.getSessionState("worker-a")).toBeNull();
    expect(harness.execution.destroyed).toEqual(["manager-a"]);
    expect(harness.recycles).toEqual([
      "manager-a",
      "worker-a",
      "manager-a",
      "worker-a",
    ]);
    expect(harness.service.getSecureRuntimeBinding(worker)).toBeUndefined();
    await harness.close();
  });

  it("treats a worker-addressed stop as a stop of the manager session", async () => {
    const harness = createHarness();
    const workerA = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-a",
    );
    const workerB = workerDescriptor(
      "worker-b",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-b",
    );
    harness.descriptors.set("worker-a", workerA);
    harness.descriptors.set("worker-b", workerB);
    await harness.service.startSecureSession("manager-a");
    await harness.service.requestSecureSecretAccess("worker-a", "tool-stop", {
      displayAlias: "worker-stop-request",
      exposures: [{ deliveryKind: "environment", targetName: "WORKER_STOP" }],
      leaseKind: "task",
      purposeSummary: "This request is cancelled when the worker is stopped",
    });
    const workerSnapshot = await harness.service.getSecureSessionSnapshot(
      "worker-a",
    );

    const stopped = await harness.service.stopSecureSession("worker-a", {
      baseRevision: workerSnapshot.revision,
      stopProcesses: true,
    });

    expect(stopped).toEqual(expect.objectContaining({
      sessionAgentId: "manager-a",
      principalKind: "manager",
      executionMode: "standard",
      environmentStatus: "stopped",
      pendingRequests: [],
    }));
    expect(harness.service.getSecureRuntimeBinding(workerA)).toBeUndefined();
    expect(harness.service.getSecureRuntimeBinding(workerB)).toBeUndefined();
    expect(harness.service.isTeamSecureMode("manager-a")).toBe(false);
    expect(harness.execution.destroyed).toEqual(["manager-a"]);
    await harness.close();
  });

  it("keeps the shared session ready when one worker execution times out", async () => {
    const harness = createHarness();
    const workerA = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-a",
    );
    const workerB = workerDescriptor(
      "worker-b",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-b",
    );
    harness.descriptors.set("worker-a", workerA);
    harness.descriptors.set("worker-b", workerB);
    await harness.service.startSecureSession("manager-a");

    await expect(
      harness.service.getSecureRuntimeBinding(workerA)!.executeBash({
      secretAliases: [],
        command: "throw-execution-timeout",
        cwd: "/workspace-a",
        onData: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "EXECUTION_TIMEOUT",
      message:
        "Secure execution timed out. Only this command was stopped; the Secure Session remains available.",
    });

    expect(await harness.service.getSecureSessionSnapshot("worker-a")).toEqual(
      expect.objectContaining({
        environmentStatus: "ready",
        lastExecutionIncident: {
          code: "EXECUTION_TIMEOUT",
          agentId: "worker-a",
          occurredAt: expect.any(String),
        },
      }),
    );
    expect(await harness.service.getSecureSessionSnapshot("manager-a")).toEqual(
      expect.objectContaining({ environmentStatus: "ready" }),
    );
    expect(await harness.service.getSecureSessionSnapshot("worker-b")).toEqual(
      expect.objectContaining({ environmentStatus: "ready" }),
    );
    expect(harness.execution.destroyed).not.toContain("manager-a");
    expect(harness.execution.destroyed).not.toContain("worker-a::assignment-a");
    expect(harness.execution.destroyed).not.toContain("worker-b::assignment-b");
    expect(harness.service.getSecureRuntimeBinding(workerA)).toBeDefined();
    await expect(
      harness.service.getSecureRuntimeBinding(workerB)!.executeBash({
      secretAliases: [],
        command: "worker-b-safe-follow-up",
        cwd: "/workspace-a",
        onData: () => undefined,
      }),
    ).resolves.toEqual({ exitCode: 0 });
    await expect(
      harness.service.getSecureRuntimeBinding(
        harness.descriptors.get("manager-a")!,
      )!.executeBash({
      secretAliases: [],
        command: "manager-safe-follow-up",
        cwd: "/workspace-a",
        onData: () => undefined,
      }),
    ).resolves.toEqual({ exitCode: 0 });
    await harness.close();
  });

  it("suppresses arbitrary backend failure details while failing closed", async () => {
    const harness = createHarness();
    await harness.service.startSecureSession("manager-a");
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;

    await expect(binding.executeBash({
      secretAliases: [],
      command: "throw-unsafe-backend-error",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).rejects.toMatchObject({
      code: "SECURE_OPERATION_FAILED",
      message: "SECURE_OPERATION_FAILED",
    });
    expect(
      await harness.service.getSecureSessionSnapshot("manager-a"),
    ).toEqual(expect.objectContaining({ environmentStatus: "failed" }));
    await harness.close();
  });

  it("attributes worker requests while keeping authority and quarantine session-wide", async () => {
    const harness = createHarness();
    const worker = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-1",
    );
    harness.descriptors.set("worker-a", worker);
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "worker-alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "WORKER_ALPHA" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.startSecureSession("manager-a");

    await harness.service.requestSecureSecretAccess("worker-a", "tool-worker", {
      displayAlias: "missing-worker-secret",
      exposures: [{ deliveryKind: "environment", targetName: "WORKER_MISSING" }],
      leaseKind: "task",
      purposeSummary: "Authenticate the worker task",
    });
    const managerBefore = await harness.service.getSecureSessionSnapshot("manager-a");
    const workerBefore = await harness.service.getSecureSessionSnapshot("worker-a");
    expect(managerBefore).toEqual(workerBefore);
    expect(managerBefore.pendingRequests).toEqual([
      expect.objectContaining({
        requestedByAgentId: "worker-a",
        workerAssignmentId: null,
      }),
    ]);

    await harness.service.grantSecureSessionLease("worker-a", {
      baseRevision: workerBefore.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "WORKER_ALPHA" }],
      leaseKind: "task",
    });
    const binding = harness.service.getSecureRuntimeBinding(worker);
    expect(binding).toBeDefined();
    await binding!.executeBash({
      secretAliases: ["worker-alpha"],
      command: "emit-alpha-canary",
      cwd: "/workspace-a",
      onData: () => undefined,
    });

    expect(harness.execution.executed.at(-1)).toBe("manager-a");
    expect(await harness.service.getSecureSessionSnapshot("worker-a")).toEqual(
      expect.objectContaining({
        outputState: "quarantined",
        environmentStatus: "ready",
      }),
    );
    expect(await harness.service.getSecureSessionSnapshot("manager-a")).toEqual(
      expect.objectContaining({ outputState: "quarantined" }),
    );
    await harness.close();
  });

  it("keeps manager leases across worker assignments while invalidating stale bindings", async () => {
    let currentNow = NOW;
    const harness = createHarness({ now: () => currentNow });
    const worker = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-1",
    );
    harness.descriptors.set("worker-a", worker);
    const taskSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "worker-task",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "WORKER_TASK" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    const timedSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "worker-timed",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "WORKER_TIMED" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    const oneUseSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "worker-once",
      encryptedMaterial: Buffer.from(`${ALPHA}-once`).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "WORKER_ONCE" }],
      scope: { kind: "profile", profileId: "profile-a" },
    });
    await harness.service.startSecureSession("manager-a");
    const workerStart = await harness.service.getSecureSessionSnapshot("worker-a");
    await harness.service.grantSecureSessionLeases("worker-a", {
      baseRevision: workerStart.revision,
      grants: [
        {
          secretId: taskSecret.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "WORKER_TASK" }],
          leaseKind: "task",
        },
        {
          secretId: timedSecret.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "WORKER_TIMED" }],
          leaseKind: "timed",
          durationSeconds: 900,
        },
        {
          secretId: oneUseSecret.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "WORKER_ONCE" }],
          leaseKind: "one_use",
        },
      ],
    });
    await harness.service.requestSecureSecretAccess("worker-a", "tool-stale", {
      displayAlias: "stale-request",
      exposures: [{ deliveryKind: "environment", targetName: "STALE_REQUEST" }],
      leaseKind: "task",
      purposeSummary: "Keep this attributed request with the manager session",
    });
    const sandboxLifecycleBeforeAssignment = {
      destroyed: [...harness.execution.destroyed],
      ensured: [...harness.execution.ensured],
    };
    const assignmentOneBinding =
      harness.service.getSecureRuntimeBinding(worker)!;
    (worker as AgentDescriptor & {
      workerParentContext: { assignmentId: string };
    }).workerParentContext.assignmentId = "assignment-2";
    expect(() => assignmentOneBinding.executeBash({
      secretAliases: [],
      command: "safe-stale-worker",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).toThrow("SECURE_OPERATION_FAILED");
    (worker as AgentDescriptor & {
      workerParentContext: { assignmentId: string };
    }).workerParentContext.assignmentId = "assignment-1";

    const unchanged = await harness.service.getSecureSessionSnapshot("worker-a");
    expect(unchanged).toEqual(expect.objectContaining({
      executionMode: "secure",
      environmentStatus: "ready",
      workerAssignmentId: null,
      leases: expect.arrayContaining([
        expect.objectContaining({ leaseKind: "task", status: "active" }),
        expect.objectContaining({ leaseKind: "timed", status: "active" }),
        expect.objectContaining({ leaseKind: "one_use", status: "active" }),
      ]),
    }));
    expect(harness.service.getSecureRuntimeBinding(worker)).toBeDefined();

    (worker as AgentDescriptor & {
      workerParentContext: {
        assignmentId: string;
        completedAt?: string;
      };
    }).workerParentContext.completedAt = currentNow;
    expect(await harness.service.getSecureSessionSnapshot("worker-a")).toEqual(
      expect.objectContaining({
        workerAssignmentId: null,
        environmentStatus: "ready",
      }),
    );
    delete (worker as AgentDescriptor & {
      workerParentContext?: { assignmentId: string };
    }).workerParentContext;
    await expect(harness.service.prepareWorkerForSecureTeam("worker-a"))
      .resolves.toBe(true);
    expect(harness.store.getSessionState("worker-a")).toBeNull();
    Object.assign(worker, {
      workerParentContext: {
        schemaVersion: 1,
        assignmentId: "assignment-2",
        managerId: "manager-a",
        assignedAt: currentNow,
        outputTarget: { kind: "manager" },
      },
    });
    currentNow = "2026-07-23T12:01:00.000Z";
    await harness.service.advanceWorkerSecureAssignment(
      "worker-a",
      "assignment-2",
    );
    const advanced = await harness.service.getSecureSessionSnapshot("worker-a");
    expect(advanced).toEqual(expect.objectContaining({
      environmentStatus: "ready",
      workerAssignmentId: null,
      pendingRequests: [
        expect.objectContaining({ requestedByAgentId: "worker-a" }),
      ],
      leases: expect.arrayContaining([
        expect.objectContaining({ leaseKind: "task", status: "active" }),
        expect.objectContaining({ leaseKind: "timed", status: "active" }),
        expect.objectContaining({ leaseKind: "one_use", status: "active" }),
      ]),
    }));
    expect(harness.execution.destroyed).toEqual(
      sandboxLifecycleBeforeAssignment.destroyed,
    );
    expect(harness.execution.ensured).toEqual(
      sandboxLifecycleBeforeAssignment.ensured,
    );
    expect(harness.service.getSecureRuntimeBinding(worker)).toBeDefined();
    await harness.close();
  });

  it("never ties the shared sandbox lifecycle to worker removal", async () => {
    const harness = createHarness();
    harness.descriptors.set(
      "worker-a",
      workerDescriptor(
        "worker-a",
        "manager-a",
        "profile-a",
        "/workspace-a",
        "assignment-1",
      ),
    );
    await harness.service.startSecureSession("manager-a");
    const workerBinding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("worker-a")!,
    );
    expect(workerBinding).toBeDefined();

    harness.descriptors.delete("worker-a");
    expect(harness.store.getSessionState("worker-a")).toBeNull();
    expect(harness.execution.destroyed).toEqual([]);
    expect(() => workerBinding!.guardValue("safe")).toThrow(
      "SECURE_OPERATION_FAILED",
    );
    expect(await harness.service.getSecureSessionSnapshot("manager-a")).toEqual(
      expect.objectContaining({ environmentStatus: "ready" }),
    );
    await harness.close();
  });

  it("attributes a worker SSH trust proposal to the manager-owned session", async () => {
    const harness = createHarness();
    const worker = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-1",
    );
    harness.descriptors.set(worker.agentId, worker);
    await harness.service.startSecureSession("manager-a");
    const key = sshHostKey("worker-proposal");

    await expect(harness.service.requestSecureSshHostTrust(
      "worker-a",
      "tool-ssh-trust",
      {
        alias: "deployment",
        hostName: "10.140.2.17",
        port: 22,
        username: "ansibleuser",
        hostKeyAlgorithm: "ssh-ed25519",
        hostKeyBase64: key.base64,
        purposeSummary: "Connect the delegated worker to the deployment host",
      },
    )).resolves.toBe("requested");
    await expect(harness.service.requestSecureSshHostTrust(
      "worker-a",
      "tool-ssh-trust-retry",
      {
        alias: "deployment",
        hostName: "10.140.2.17",
        port: 22,
        username: "ansibleuser",
        hostKeyAlgorithm: "ssh-ed25519",
        hostKeyBase64: key.base64,
        purposeSummary: "Retry the same delegated SSH host proposal",
      },
    )).resolves.toBe("requested");

    const manager = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(manager.pendingSshTrustRequests).toEqual([
      expect.objectContaining({
        alias: "deployment",
        requestedByAgentId: "worker-a",
        requestedByDisplayName: "worker-a",
        hostKeyAlgorithm: "ssh-ed25519",
        hostKeyFingerprint: key.fingerprint,
      }),
    ]);
    expect(JSON.stringify(manager)).not.toContain(key.base64);
    expect(await harness.service.getSecureSessionSnapshot("worker-a")).toEqual(
      manager,
    );
    await harness.close();
  });

  it("returns trusted for an exact existing host without creating a request", async () => {
    const harness = createHarness();
    const key = sshHostKey("already-trusted");
    await harness.service.createSecureSshTrustedHost({
      profileId: "profile-a",
      alias: "deployment",
      hostName: "10.140.2.17",
      port: 22,
      username: "ansibleuser",
      hostKey: `ssh-ed25519 ${key.base64}`,
    });

    await expect(harness.service.requestSecureSshHostTrust(
      "manager-a",
      "tool-existing",
      {
        alias: "deployment",
        hostName: "10.140.2.17",
        port: 22,
        username: "ansibleuser",
        hostKeyAlgorithm: "ssh-ed25519",
        hostKeyBase64: key.base64,
        purposeSummary: "Reconnect to the already trusted host",
      },
    )).resolves.toBe("trusted");
    expect(
      await harness.service.getSecureSessionSnapshot("manager-a"),
    ).toEqual(expect.objectContaining({
      pendingSshTrustRequests: [],
      trustedSshHosts: [
        expect.objectContaining({
          alias: "deployment",
          hostKeyFingerprint: key.fingerprint,
        }),
      ],
    }));
    await harness.close();
  });

  it("rolls back approval when an alias already has a different key", async () => {
    const harness = createHarness();
    const original = sshHostKey("original");
    const replacement = sshHostKey("replacement");
    await harness.service.createSecureSshTrustedHost({
      profileId: "profile-a",
      alias: "deployment",
      hostName: "10.140.2.17",
      port: 22,
      username: "ansibleuser",
      hostKey: `ssh-ed25519 ${original.base64}`,
    });
    await harness.service.requestSecureSshHostTrust(
      "manager-a",
      "tool-key-change",
      {
        alias: "deployment",
        hostName: "10.140.2.17",
        port: 22,
        username: "ansibleuser",
        hostKeyAlgorithm: "ssh-ed25519",
        hostKeyBase64: replacement.base64,
        purposeSummary: "Reconnect after the server reported a changed key",
      },
    );
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    const requestId = pending.pendingSshTrustRequests?.[0]?.requestId;
    expect(requestId).toBeDefined();

    await expect(harness.service.resolveSecureSshHostTrustRequest(
      "manager-a",
      {
        baseRevision: pending.revision,
        requestId: requestId!,
        decision: "approve",
      },
    )).rejects.toMatchObject({ code: "SECURE_SSH_HOST_KEY_CONFLICT" });

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.revision).toBe(pending.revision);
    expect(after.pendingSshTrustRequests).toEqual(
      pending.pendingSshTrustRequests,
    );
    expect(after.trustedSshHosts).toEqual([
      expect.objectContaining({
        alias: "deployment",
        hostKeyFingerprint: original.fingerprint,
      }),
    ]);
    expect(JSON.stringify(after)).not.toContain(original.base64);
    expect(JSON.stringify(after)).not.toContain(replacement.base64);
    await harness.close();
  });

  it("does not silently retarget an existing SSH alias with the same key", async () => {
    const harness = createHarness();
    const key = sshHostKey("shared-host-key");
    await harness.service.createSecureSshTrustedHost({
      profileId: "profile-a",
      alias: "deployment",
      hostName: "10.140.2.17",
      port: 22,
      username: "ansibleuser",
      hostKey: `ssh-ed25519 ${key.base64}`,
    });
    await harness.service.requestSecureSshHostTrust(
      "manager-a",
      "tool-retarget",
      {
        alias: "deployment",
        hostName: "10.140.2.99",
        port: 2222,
        username: "other-user",
        hostKeyAlgorithm: "ssh-ed25519",
        hostKeyBase64: key.base64,
        purposeSummary: "Connect the alias to a different endpoint",
      },
    );
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    const requestId = pending.pendingSshTrustRequests?.[0]?.requestId;
    expect(requestId).toBeDefined();

    await expect(harness.service.resolveSecureSshHostTrustRequest(
      "manager-a",
      {
        baseRevision: pending.revision,
        requestId: requestId!,
        decision: "approve",
      },
    )).rejects.toMatchObject({ code: "SECURE_SSH_HOST_KEY_CONFLICT" });
    expect(await harness.service.listSecureSshTrustedHosts()).toEqual([
      expect.objectContaining({
        alias: "deployment",
        hostName: "10.140.2.17",
        port: 22,
        username: "ansibleuser",
      }),
    ]);
    await harness.close();
  });

  it("injects current project SSH trust into the next manager or worker command", async () => {
    const harness = createHarness();
    const worker = workerDescriptor(
      "worker-a",
      "manager-a",
      "profile-a",
      "/workspace-a",
      "assignment-1",
    );
    harness.descriptors.set(worker.agentId, worker);
    const first = sshHostKey("first");
    await harness.service.createSecureSshTrustedHost({
      profileId: "profile-a",
      alias: "deployment",
      hostName: "10.140.2.17",
      port: 22,
      username: "ansibleuser",
      hostKey: `ssh-ed25519 ${first.base64}`,
    });
    await harness.service.startSecureSession("manager-a");

    await harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!.executeBash({
      secretAliases: [],
      command: "manager-ssh",
      cwd: "/workspace-a",
      onData: () => undefined,
    });

    const second = sshHostKey("second");
    await harness.service.createSecureSshTrustedHost({
      profileId: "profile-a",
      alias: "database",
      hostName: "10.140.2.18",
      port: 2222,
      username: "dbadmin",
      hostKey: `ssh-ed25519 ${second.base64}`,
    });
    await harness.service.getSecureRuntimeBinding(worker)!.executeBash({
      secretAliases: [],
      command: "worker-ssh",
      cwd: "/workspace-a",
      onData: () => undefined,
    });

    expect(harness.execution.sshTrustDeliveries).toHaveLength(2);
    expect(harness.execution.sshTrustDeliveries[0]?.config).toContain(
      "Host deployment",
    );
    expect(harness.execution.sshTrustDeliveries[0]?.knownHosts).toContain(
      `deployment ssh-ed25519 ${first.base64}`,
    );
    expect(harness.execution.sshTrustDeliveries[1]?.config).toContain(
      "Host database",
    );
    expect(harness.execution.sshTrustDeliveries[1]?.config).toContain(
      "StrictHostKeyChecking yes",
    );
    expect(harness.execution.sshTrustDeliveries[1]?.knownHosts).toContain(
      `[database]:2222 ssh-ed25519 ${second.base64}`,
    );
    expect(harness.execution.executed.slice(-2)).toEqual([
      "manager-a",
      "manager-a",
    ]);
    await harness.close();
  });
});

async function grant(
  harness: ReturnType<typeof createHarness>,
  managerId: string,
  secretId: string,
  alias: string,
): Promise<void> {
  const snapshot = await harness.service.startSecureSession(managerId);
  await harness.service.grantSecureSessionLease(managerId, {
    baseRevision: snapshot.revision,
    secretId,
    exposures: [{
      deliveryKind: "environment",
      targetName: `${alias.toUpperCase()}_TOKEN`,
    }],
    leaseKind: "task",
  });
}

function createHarness(options: {
  maxProjectDefaults?: number;
  blockProviderStatus?: boolean;
  blockSourceResolution?: boolean;
  blockEnsures?: readonly string[];
  destroyFailures?: readonly string[];
  failSourceResolutionAfter?: number;
  failSourceMaterials?: readonly string[];
  rejectedBitwardenCredentials?: readonly string[];
  probeAvailability?: {
    available: boolean;
    code: "available" | "backend_unavailable" | "image_unavailable" | "unsupported_platform";
  };
  probeThrows?: boolean;
  installAvailability?: {
    available: boolean;
    code: "available" | "backend_unavailable" | "image_unavailable" | "unsupported_platform";
  };
  installThrows?: boolean;
  guardFailures?: number;
  archivedProfiles?: readonly string[];
  systemProfiles?: readonly string[];
  archivedSessions?: readonly string[];
  now?: () => string;
  recoveredSandboxIds?: readonly string[];
  recoveryFailures?: number;
  recycleThrows?: boolean;
  recycleDisposition?: "recycled" | "deferred" | "none";
  recycleDispositionForAgent?: (
    agentId: string,
  ) => "recycled" | "deferred" | "none";
  rotatedLocalCiphertext?: string;
  passwordManagerStatus?: BitwardenPasswordManagerStatus;
  passwordManagerCollections?: readonly BitwardenPasswordManagerCollection[];
  passwordManagerItems?: readonly BitwardenPasswordManagerItemMetadata[];
} = {}) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runSecureSessionMigrations(database);
  const now = options.now ?? (() => NOW);
  const store = new SecureSessionStore(database, undefined, () => new Date(now()));
  const descriptors = new Map<string, AgentDescriptor>([
    ["manager-a", descriptor("manager-a", "profile-a", "/workspace-a")],
    ["manager-b", descriptor("manager-b", "profile-b", "/workspace-b")],
  ]);
  const archivedProfiles = new Set(options.archivedProfiles ?? []);
  const systemProfiles = new Set(options.systemProfiles ?? []);
  const archivedSessions = new Set(options.archivedSessions ?? []);
  const execution = new FakeExecutionBackend(options);
  const sourceResolutions = new Map<string, number>();
  const resolvedMaterials: HostOnlySecret[] = [];
  const bitwardenTests: Array<{ credential: string; endpointOrigin: string | null }> = [];
  const passwordManagerUnlocks: string[] = [];
  const passwordManagerSyncs: string[] = [];
  const passwordManagerCliInstalls: string[] = [];
  const passwordManagerStatusPaths: Array<string | null> = [];
  let sourceResolutionStarted!: () => void;
  let sourceResolutionRelease!: () => void;
  const sourceResolutionStartedPromise = new Promise<void>((resolve) => {
    sourceResolutionStarted = resolve;
  });
  const sourceResolutionReleasePromise = new Promise<void>((resolve) => {
    sourceResolutionRelease = resolve;
  });
  const localSource: SecureSecretSource & {
    testConnection(): Promise<void>;
  } = {
    kind: "local_keychain",
    async testConnection() {},
    async resolve(input) {
      if (options.blockSourceResolution) {
        sourceResolutionStarted();
        await sourceResolutionReleasePromise;
      }
      const bytes = Buffer.from(input.encryptedMaterial ?? []);
      const key = bytes.toString("utf8");
      const resolutionCount = [...sourceResolutions.values()]
        .reduce((total, value) => total + value, 0);
      if (
        options.failSourceResolutionAfter !== undefined
        && resolutionCount >= options.failSourceResolutionAfter
      ) {
        bytes.fill(0);
        throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
      }
      if (options.failSourceMaterials?.includes(key)) {
        bytes.fill(0);
        throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
      }
      sourceResolutions.set(key, (sourceResolutions.get(key) ?? 0) + 1);
      const material = new HostOnlySecret(bytes);
      resolvedMaterials.push(material);
      return {
        material,
        sourceVersion: null,
        resolvedAt: NOW,
        ...(options.rotatedLocalCiphertext
          ? {
              refreshedEncryptedMaterial: Buffer.from(
                options.rotatedLocalCiphertext,
              ),
            }
          : {}),
      };
    },
  };
  const bitwardenSource: SecureSecretSource & {
    testConnection(input: {
      encryptedCredential?: Uint8Array;
      endpointOrigin?: string | null;
    }): Promise<void>;
  } = {
    kind: "bitwarden_secrets_manager",
    async testConnection(input) {
      const credential = Buffer.from(input.encryptedCredential ?? []).toString("utf8");
      bitwardenTests.push({
        credential,
        endpointOrigin: input.endpointOrigin ?? null,
      });
      if (options.rejectedBitwardenCredentials?.includes(credential)) {
        throw new SecureSourceError("SECURE_SOURCE_AUTH_REQUIRED");
      }
    },
    async resolve() {
      const material = new HostOnlySecret(Buffer.from("bitwarden-resolved"));
      resolvedMaterials.push(material);
      return {
        material,
        sourceVersion: null,
        resolvedAt: NOW,
      };
    },
  };
  const bitwardenPasswordManagerSource: BitwardenPasswordManagerSource = {
    kind: "bitwarden_password_manager",
    async status(configuredExecutablePath) {
      passwordManagerStatusPaths.push(configuredExecutablePath);
      if (options.passwordManagerStatus) return options.passwordManagerStatus;
      return {
          state: "locked",
          accountEmail: null,
          serverUrl: null,
          cli: configuredExecutablePath
            ? {
                ...testBitwardenCliSummary(),
                source: "configured",
                executablePath: configuredExecutablePath,
                configuredExecutablePath,
              }
            : testBitwardenCliSummary(),
        };
    },
    async installCli() {
      passwordManagerCliInstalls.push(now());
      return {
        state: "locked",
        accountEmail: null,
        serverUrl: null,
        cli: {
          ...testBitwardenCliSummary(),
          source: "managed",
          executablePath: "/forge/managed/bw",
        },
      };
    },
    async unlock(encryptedMasterPassword) {
      passwordManagerUnlocks.push(Buffer.from(encryptedMasterPassword).toString("utf8"));
      return {
        state: "available",
        accountEmail: options.passwordManagerStatus?.accountEmail ?? null,
        serverUrl: options.passwordManagerStatus?.serverUrl ?? null,
        cli: options.passwordManagerStatus?.cli ?? testBitwardenCliSummary(),
      };
    },
    async lock() {},
    async sync() { passwordManagerSyncs.push(now()); },
    async listCollections() { return [...(options.passwordManagerCollections ?? [])]; },
    async listItems(collectionIds) {
      return (options.passwordManagerItems ?? []).filter((item) =>
        item.collectionIds.some((collectionId) => collectionIds.includes(collectionId))
      );
    },
    async resolve() {
      const material = new HostOnlySecret(Buffer.from("bitwarden-password-manager-resolved"));
      resolvedMaterials.push(material);
      return { material, sourceVersion: null, resolvedAt: NOW };
    },
    dispose() {},
  };
  const snapshots: SecureSessionSnapshotEvent[] = [];
  const recycles: string[] = [];
  let recycleDisposition = options.recycleDisposition;
  let nextId = 0;
  let guardFailures = options.guardFailures ?? 0;
  let providerStatusStarted!: () => void;
  let providerStatusRelease!: () => void;
  const providerStatusStartedPromise = new Promise<void>((resolve) => {
    providerStatusStarted = resolve;
  });
  const providerStatusReleasePromise = new Promise<void>((resolve) => {
    providerStatusRelease = resolve;
  });
  const cipher: SecureVaultCipher & { dispose(): void } = {
    async status() {
      if (options.blockProviderStatus) {
        providerStatusStarted();
        await providerStatusReleasePromise;
      }
      return { available: true };
    },
    async encrypt(bytes) { return Buffer.from(bytes); },
    async decrypt(bytes) {
      return { material: new HostOnlySecret(bytes) };
    },
    dispose() {},
  };
  const service = new SecureSessionsService({
    storeFactory: async () => store,
    cipher,
    localSource,
    bitwardenSource,
    bitwardenPasswordManagerSource,
    probeBitwarden: async () => true,
    execution,
    getDescriptor: (agentId) => descriptors.get(agentId),
    listDescriptors: () => [...descriptors.values()],
    listProfiles: () => [...new Set(
      [...descriptors.values()].flatMap((descriptor) =>
        descriptor.profileId ? [descriptor.profileId] : []
      ),
    )].map((profileId) => ({
      profileId,
      ...(archivedProfiles.has(profileId) ? { archivedAt: NOW } : {}),
      ...(systemProfiles.has(profileId) ? { profileType: "system" as const } : {}),
    })),
    hasProfile: (profileId) => [...descriptors.values()].some(
      (descriptor) => descriptor.profileId === profileId,
    ),
    isProfileArchived: (profileId) => archivedProfiles.has(profileId),
    isSessionArchived: (agentId) => archivedSessions.has(agentId),
    requireBuilderSession: (agentId) => {
      const value = descriptors.get(agentId);
      if (!value) throw new Error("missing");
      return value;
    },
    emitSnapshot: (event) => snapshots.push(event),
    emitCatalogChanged: () => undefined,
    applyModeRuntimeRecycle: async (agentId) => {
      recycles.push(agentId);
      if (options.recycleThrows) throw new Error("recycle failed");
      return options.recycleDispositionForAgent?.(agentId)
        ?? recycleDisposition
        ?? "recycled";
    },
    createValueGuard: (values) => {
      if (guardFailures > 0) {
        guardFailures -= 1;
        throw new Error("guard preflight failed");
      }
      return new SecureValueGuard(values);
    },
    now,
    createId: () => `id-${++nextId}`,
    getMaxProjectDefaults: () => options.maxProjectDefaults ?? SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  });
  return {
    service,
    store,
    descriptors,
    archivedProfiles,
    archivedSessions,
    execution,
    sourceResolutions,
    resolvedMaterials,
    bitwardenTests,
    passwordManagerUnlocks,
    passwordManagerSyncs,
    passwordManagerCliInstalls,
    passwordManagerStatusPaths,
    snapshots,
    recycles,
    setRecycleDisposition(value: "recycled" | "deferred" | "none") {
      recycleDisposition = value;
    },
    async waitForBlockedProviderStatus() {
      await providerStatusStartedPromise;
    },
    releaseBlockedProviderStatus() {
      providerStatusRelease();
    },
    async waitForBlockedSourceResolution() {
      await sourceResolutionStartedPromise;
    },
    releaseBlockedSourceResolution() {
      sourceResolutionRelease();
    },
    async close() {
      await service.closeSecureSessions();
    },
  };
}

class FakeExecutionBackend implements SecureExecutionBackend {
  readonly kind = "fake";
  readonly destroyed: string[] = [];
  readonly ensured: string[] = [];
  readonly executed: string[] = [];
  readonly recoveryCalls: SecureExecutionTask[][] = [];
  readonly sshTrustDeliveries: Array<{
    config: string;
    knownHosts: string;
  }> = [];
  readonly sshAgentDeliveryValues: string[][] = [];
  readonly environmentDeliveryNames: string[][] = [];
  readonly destroyUnconfirmed = new Set<string>();
  private readonly blockedExecutions = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly blockedExecutionWaiters = new Map<
    string,
    Set<() => void>
  >();
  private readonly blockedEnsures = new Map<string, () => void>();
  private readonly blockedEnsureWaiters = new Map<string, Set<() => void>>();
  private recoveryFailures: number;
  lastDeliveryValue: Uint8Array | undefined;

  constructor(private readonly options: {
    destroyFailures?: readonly string[];
    recoveredSandboxIds?: readonly string[];
    recoveryFailures?: number;
    blockEnsures?: readonly string[];
    probeAvailability?: {
      available: boolean;
      code: "available" | "backend_unavailable" | "image_unavailable" | "unsupported_platform";
    };
    probeThrows?: boolean;
    installAvailability?: {
      available: boolean;
      code: "available" | "backend_unavailable" | "image_unavailable" | "unsupported_platform";
    };
    installThrows?: boolean;
  } = {}) {
    this.recoveryFailures = options.recoveryFailures ?? 0;
  }

  async probe() {
    if (this.options.probeThrows) throw new Error("RAW-PROBE-FAILURE");
    return this.options.probeAvailability
      ?? { available: true, code: "available" as const };
  }

  async installRunner() {
    if (this.options.installThrows) throw new Error("RAW-INSTALL-FAILURE");
    return this.options.installAvailability
      ?? { available: true, code: "available" as const };
  }

  async ensureTask(task: SecureExecutionTask) {
    this.ensured.push(task.taskId);
    if (this.options.blockEnsures?.includes(task.taskId)) {
      await new Promise<void>((resolve) => {
        this.blockedEnsures.set(task.taskId, resolve);
        const waiters = this.blockedEnsureWaiters.get(task.taskId);
        this.blockedEnsureWaiters.delete(task.taskId);
        for (const waiter of waiters ?? []) waiter();
      });
    }
    return { backend: this.kind, sandboxId: task.taskId };
  }

  async waitForBlockedEnsure(taskId: string): Promise<void> {
    if (this.blockedEnsures.has(taskId)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.blockedEnsureWaiters.get(taskId) ?? new Set();
      waiters.add(resolve);
      this.blockedEnsureWaiters.set(taskId, waiters);
    });
  }

  releaseBlockedEnsure(taskId: string): void {
    const release = this.blockedEnsures.get(taskId);
    this.blockedEnsures.delete(taskId);
    release?.();
  }

  async execute(request: SecureExecutionRequest) {
    this.executed.push(request.task.taskId);
    this.lastDeliveryValue = request.delivery?.environment?.[0]?.value;
    this.environmentDeliveryNames.push(
      (request.delivery?.environment ?? []).map(({ name }) => name),
    );
    this.sshAgentDeliveryValues.push(
      (request.delivery?.sshAgent ?? []).map(({ value }) =>
        Buffer.from(value).toString("utf8")
      ),
    );
    if (request.delivery?.sshTrust) {
      this.sshTrustDeliveries.push({
        config: Buffer.from(request.delivery.sshTrust.config).toString("utf8"),
        knownHosts: Buffer.from(
          request.delivery.sshTrust.knownHosts,
        ).toString("utf8"),
      });
    }
    const command = request.command.args.at(-1);
    if (command === "throw-execution-timeout") {
      throw new SecureExecutionError("EXECUTION_TIMEOUT");
    }
    if (command === "throw-unsafe-backend-error") {
      throw new Error(`unsafe-backend-detail:${ALPHA}`);
    }
    if (command === "wait-for-destroy" || command === "wait-for-release") {
      await new Promise<void>((resolve, reject) => {
        this.blockedExecutions.set(request.task.taskId, { resolve, reject });
        const waiters = this.blockedExecutionWaiters.get(request.task.taskId);
        this.blockedExecutionWaiters.delete(request.task.taskId);
        for (const resolve of waiters ?? []) resolve();
      });
    }
    const raw = Buffer.from(
      command === "emit-alpha-canary" || command === "emit-own-canary"
        ? ALPHA
        : command === "emit-public-marker"
          ? SECURE_OUTPUT_QUARANTINE
        : "safe",
    );
    const stdout = await request.guardOutput({
      stream: "stdout",
      bytes: raw,
      final: false,
    });
    await request.onOutput?.({ stream: "stdout", bytes: stdout });
    const tail = await request.guardOutput({
      stream: "stdout",
      bytes: Buffer.alloc(0),
      final: true,
    });
    await request.onOutput?.({ stream: "stdout", bytes: tail });
    return {
      exitCode: 0,
      signal: null,
      stdout,
      stderr: Buffer.alloc(0),
    };
  }

  hasBlockedExecution(taskId: string): boolean {
    return this.blockedExecutions.has(taskId);
  }

  async waitForBlockedExecution(taskId: string): Promise<void> {
    if (this.hasBlockedExecution(taskId)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.blockedExecutionWaiters.get(taskId) ?? new Set();
      waiters.add(resolve);
      this.blockedExecutionWaiters.set(taskId, waiters);
    });
  }

  rejectBlockedExecution(taskId: string): void {
    const blocked = this.blockedExecutions.get(taskId);
    this.blockedExecutions.delete(taskId);
    blocked?.reject(new Error("destroyed"));
  }

  releaseBlockedExecution(taskId: string): void {
    const blocked = this.blockedExecutions.get(taskId);
    this.blockedExecutions.delete(taskId);
    blocked?.resolve();
  }

  async destroyTask(task: SecureExecutionTask) {
    this.destroyed.push(task.taskId);
    if (this.options.destroyFailures?.includes(task.taskId)) {
      throw new Error("destroy failed");
    }
    if (this.destroyUnconfirmed.has(task.taskId)) {
      return false;
    }
    return true;
  }

  async recoverOrphans(liveTasks: readonly SecureExecutionTask[]) {
    this.recoveryCalls.push([...liveTasks]);
    if (this.recoveryFailures > 0) {
      this.recoveryFailures -= 1;
      throw new Error("recovery failed");
    }
    return { destroyedSandboxIds: [...(this.options.recoveredSandboxIds ?? [])] };
  }
}

function descriptor(agentId: string, profileId: string, cwd: string): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: "manager",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd,
    model: { provider: "openai", modelId: "test" },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
    sessionSurface: "builder",
  } as AgentDescriptor;
}

function workerDescriptor(
  agentId: string,
  managerId: string,
  profileId: string,
  cwd: string,
  assignmentId?: string,
): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: "worker",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd,
    model: { provider: "openai", modelId: "test" },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
    sessionSurface: "builder",
    ...(assignmentId
      ? {
          workerParentContext: {
            schemaVersion: 1,
            assignmentId,
            managerId,
            assignedAt: NOW,
            outputTarget: { kind: "manager" },
          },
        }
      : {}),
  } as AgentDescriptor;
}

function sshHostKey(marker: string): {
  base64: string;
  fingerprint: string;
} {
  const algorithm = Buffer.from("ssh-ed25519", "utf8");
  const payload = Buffer.from(marker, "utf8");
  const blob = Buffer.alloc(4 + algorithm.byteLength + payload.byteLength);
  blob.writeUInt32BE(algorithm.byteLength, 0);
  algorithm.copy(blob, 4);
  payload.copy(blob, 4 + algorithm.byteLength);
  return {
    base64: blob.toString("base64"),
    fingerprint:
      `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")}`,
  };
}
