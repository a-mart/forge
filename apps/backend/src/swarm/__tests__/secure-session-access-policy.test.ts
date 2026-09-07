import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECURE_SESSION_MIGRATIONS, runSecureSessionMigrations } from "../secure-sessions/storage/secure-session-migrations.js";
import { SecureSessionStore } from "../secure-sessions/storage/secure-session-store.js";

describe("durable secure access policy", () => {
  it("preserves historical data and pauses only previously used stopped tasks on upgrade", () => {
    const database = new Database(":memory:");
    try {
      database.exec("CREATE TABLE secure_session_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
      for (const migration of SECURE_SESSION_MIGRATIONS.filter((entry) => entry.version < 12)) {
        database.pragma(`foreign_keys = ${migration.requiresForeignKeysOff ? "OFF" : "ON"}`);
        migration.up(database);
        database.prepare("INSERT INTO secure_session_schema_migrations VALUES (?, ?, 't')").run(migration.version, migration.name);
      }
      database.pragma("foreign_keys = ON");
      const store = new SecureSessionStore(database);
      store.upsertProvider({ providerId: "local", kind: "local_keychain", displayName: "Local" });
      store.createSecretWithBindings({ secret: { secretId: "secret", providerId: "local", displayAlias: "alias",
        scopeKind: "instance", retention: "saved", sourceLocator: "local:secret", encryptedMaterial: Buffer.from("fixture") },
        bindings: [{ bindingId: "binding", deliveryKind: "environment", targetName: "TOKEN" }] });
      for (const id of ["used", "active", "untouched", "revoked"]) {
        store.initializePrincipalState(id, { principalKind: "manager", profileId: "project" });
        if (id !== "untouched") {
          store.createLease({ leaseId: `lease-${id}`, sessionAgentId: id, secretId: "secret",
            bindingIds: ["binding"], leaseKind: "task", baseRevision: 0 });
        }
      }
      store.updateSessionRuntimeState({ sessionAgentId: "active", executionMode: "secure", environmentStatus: "ready" });
      store.putProjectDefault({ profileId: "project", secretId: "secret" });
      database.prepare("UPDATE secure_session_lease SET grant_source = 'project_default', state = 'revoked', revocation_reason = 'user' WHERE session_agent_id = 'revoked'").run();
      const historicalAudit = store.listAudit();
      runSecureSessionMigrations(database);
      expect(store.getAccessPolicy("used").paused).toBe(true);
      expect(store.getAccessPolicy("active").paused).toBe(false);
      expect(store.getAccessPolicy("untouched").paused).toBe(false);
      expect(store.listAudit()).toEqual(historicalAudit);
      expect(store.getAccessPolicy("revoked").blockedSecretIds).toEqual(["secret"]);
      expect(store.getSnapshot("used").leases).toHaveLength(1);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("quick_check", { simple: true })).toBe("ok");
    } finally { database.close(); }
  });

  it("retains denials across database reopen and forks without copying temporary grants", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-access-policy-"));
    const path = join(directory, "test.db");
    let database = new Database(path);
    try {
      database.pragma("foreign_keys = ON");
      runSecureSessionMigrations(database);
      let store = new SecureSessionStore(database);
      store.initializePrincipalState("task", { principalKind: "manager", profileId: "project" });
      store.setAccessBlocked("task", { kind: "task" }, true, 0);
      store.setAccessBlocked("task", { kind: "agent", agentId: "worker" }, true, 1);
      store.setAccessBlocked("task", { kind: "secret", secretId: "secret" }, true, 2);
      database.close();
      database = new Database(path);
      database.pragma("foreign_keys = ON");
      runSecureSessionMigrations(database);
      store = new SecureSessionStore(database);
      expect(store.getAccessPolicy("task")).toEqual({ paused: true, blockedAgentIds: ["worker"], blockedSecretIds: ["secret"] });
      const fork = store.createForkSessionState("task", "fork");
      expect(fork.leases).toEqual([]);
      expect(store.getAccessPolicy("fork")).toEqual({ paused: true, blockedAgentIds: [], blockedSecretIds: ["secret"] });
      store.setAccessBlocked("task", { kind: "task" }, false, 3);
      expect(store.getAccessPolicy("fork").paused).toBe(true);
      expect(() => store.setAccessBlocked("task", { kind: "agent", agentId: "worker" }, false, 3)).toThrow();
      expect(store.getAccessPolicy("task").blockedAgentIds).toEqual(["worker"]);
      database.prepare("DELETE FROM secure_session_state WHERE session_agent_id = ?").run("task");
      expect(store.getAccessPolicy("task")).toEqual({ paused: false, blockedAgentIds: [], blockedSecretIds: [] });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      if (database.open) database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
