import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runSecureSessionMigrations } from "../secure-sessions/storage/secure-session-migrations.js";
import {
  SecureSessionSshAliasConflictError,
  SecureSessionStore,
} from "../secure-sessions/storage/secure-session-store.js";

const NOW = "2026-07-29T12:00:00.000Z";
const LATER = "2026-07-29T13:00:00.000Z";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SecureSessionStore SSH trusted hosts", () => {
  it("migrates v8 and preserves project-isolated host profiles across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "forge-ssh-trust-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "secure-sessions.sqlite");

    const firstDatabase = new Database(databasePath);
    firstDatabase.pragma("foreign_keys = ON");
    runSecureSessionMigrations(firstDatabase);
    const firstStore = new SecureSessionStore(
      firstDatabase,
      undefined,
      () => new Date(NOW),
    );
    firstStore.putSshTrustedHost(hostInput({
      trustedHostId: "host-a",
      profileId: "profile-a",
      alias: "deployment",
      hostName: "10.10.0.11",
    }));
    firstStore.putSshTrustedHost(hostInput({
      trustedHostId: "host-b",
      profileId: "profile-b",
      alias: "deployment",
      hostName: "10.10.0.12",
    }));
    expect(
      firstDatabase.prepare(
        "SELECT name FROM secure_session_schema_migrations WHERE version = 8",
      ).get(),
    ).toEqual({ name: "project_ssh_trusted_hosts" });
    firstDatabase.close();

    const reopenedDatabase = new Database(databasePath);
    reopenedDatabase.pragma("foreign_keys = ON");
    runSecureSessionMigrations(reopenedDatabase);
    const reopenedStore = new SecureSessionStore(
      reopenedDatabase,
      undefined,
      () => new Date(LATER),
    );

    expect(reopenedStore.listSshTrustedHosts("profile-a")).toEqual([
      expect.objectContaining({
        trustedHostId: "host-a",
        profileId: "profile-a",
        alias: "deployment",
        hostName: "10.10.0.11",
      }),
    ]);
    expect(reopenedStore.listSshTrustedHosts("profile-b")).toEqual([
      expect.objectContaining({
        trustedHostId: "host-b",
        profileId: "profile-b",
        alias: "deployment",
        hostName: "10.10.0.12",
      }),
    ]);

    reopenedStore.putSshTrustedHost(hostInput({
      trustedHostId: "host-a",
      profileId: "profile-a",
      alias: "deployment",
      hostName: "10.10.0.21",
      username: "release",
    }));
    expect(reopenedStore.getSshTrustedHost("host-a")).toEqual(
      expect.objectContaining({
        hostName: "10.10.0.21",
        username: "release",
        createdAt: NOW,
        updatedAt: LATER,
      }),
    );
    expect(() => reopenedStore.putSshTrustedHost(hostInput({
      trustedHostId: "host-c",
      profileId: "profile-a",
      alias: "deployment",
    }))).toThrow(SecureSessionSshAliasConflictError);
    reopenedDatabase.close();
  });

  it("deletes only the removed project's trusted hosts", () => {
    const { database, store } = createMemoryStore();
    store.putSshTrustedHost(hostInput({
      trustedHostId: "host-a",
      profileId: "profile-a",
      alias: "alpha",
    }));
    store.putSshTrustedHost(hostInput({
      trustedHostId: "host-b",
      profileId: "profile-b",
      alias: "beta",
    }));

    expect(store.deleteProjectSecretState("profile-a")).toEqual({
      projectDefaultsDeleted: 0,
      secretsDeleted: 0,
      secretsUpdated: 0,
      trustedSshHostsDeleted: 1,
    });
    expect(store.listSshTrustedHosts("profile-a")).toEqual([]);
    expect(store.listSshTrustedHosts("profile-b")).toEqual([
      expect.objectContaining({ trustedHostId: "host-b" }),
    ]);
    database.close();
  });

  it("keeps request creation idempotent and expires only due pending requests", () => {
    let now = NOW;
    const { database, store } = createMemoryStore(() => now);
    store.initializePrincipalState("manager-a", {
      profileId: "profile-a",
      principalKind: "manager",
      ownerManagerAgentId: null,
      workerAssignmentId: null,
      executionMode: "secure",
      environmentStatus: "ready",
    });
    const request = requestInput();

    const created = store.createSshTrustRequest(request);
    const idempotent = store.createSshTrustRequest(request);
    expect(idempotent.state.revision).toBe(created.state.revision);
    expect(idempotent.sshTrustRequests).toEqual([
      expect.objectContaining({
        requestId: "request-a",
        requestedByAgentId: "worker-a",
        state: "pending",
      }),
    ]);

    now = LATER;
    const expired = store.expireSshTrustRequests(now, "manager-a");
    expect(expired).toHaveLength(1);
    expect(expired[0]?.snapshot.sshTrustRequests).toEqual([]);
    expect(store.getSshTrustRequest("request-a")).toEqual(
      expect.objectContaining({
        state: "cancelled",
        resolvedAt: LATER,
      }),
    );
    expect(store.expireSshTrustRequests(now, "manager-a")).toEqual([]);
    database.close();
  });
});

function createMemoryStore(now: () => string = () => NOW): {
  database: Database.Database;
  store: SecureSessionStore;
} {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runSecureSessionMigrations(database);
  return {
    database,
    store: new SecureSessionStore(
      database,
      undefined,
      () => new Date(now()),
    ),
  };
}

function hostInput(overrides: Partial<{
  trustedHostId: string;
  profileId: string;
  alias: string;
  hostName: string;
  port: number;
  username: string;
}> = {}) {
  return {
    trustedHostId: overrides.trustedHostId ?? "host-a",
    profileId: overrides.profileId ?? "profile-a",
    alias: overrides.alias ?? "deployment",
    hostName: overrides.hostName ?? "10.10.0.10",
    port: overrides.port ?? 22,
    username: overrides.username ?? "deploy",
    hostKeyAlgorithm: "ssh-ed25519",
    hostKeyBase64: "AAAAE2V4YW1wbGUtaG9zdC1rZXk=",
    hostKeyFingerprint: "SHA256:example",
  };
}

function requestInput() {
  return {
    requestId: "request-a",
    sessionAgentId: "manager-a",
    profileId: "profile-a",
    alias: "deployment",
    hostName: "10.10.0.10",
    port: 22,
    username: "deploy",
    hostKeyAlgorithm: "ssh-ed25519",
    hostKeyBase64: "AAAAE2V4YW1wbGUtaG9zdC1rZXk=",
    hostKeyFingerprint: "SHA256:example",
    purposeSummary: "Deploy the current project",
    requestedByAgentId: "worker-a",
    requestedByDisplayName: "Worker A",
    expiresAt: "2026-07-29T12:30:00.000Z",
  };
}
