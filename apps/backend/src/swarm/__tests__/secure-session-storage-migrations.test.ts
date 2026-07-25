import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  SECURE_SESSION_MIGRATIONS,
  runSecureSessionMigrations
} from "../secure-sessions/storage/secure-session-migrations.js";

describe("secure session migrations", () => {
  it("applies transactionally, reruns idempotently, and passes integrity checks", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runSecureSessionMigrations(database);
    runSecureSessionMigrations(database);

    expect(database.prepare(
      "SELECT version, name FROM secure_session_schema_migrations ORDER BY version"
    ).all()).toEqual(
      SECURE_SESSION_MIGRATIONS.map(({ version, name }) => ({ version, name }))
    );
    expect(database.pragma("quick_check", { simple: true })).toBe("ok");
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.prepare(
      "SELECT revision FROM secure_session_catalog_state WHERE id = 1"
    ).get()).toEqual({ revision: 0 });
    database.close();
  });

  it("rejects migration ledger tampering and unknown migrations", () => {
    const database = new Database(":memory:");
    runSecureSessionMigrations(database);
    database.prepare(`
      UPDATE secure_session_schema_migrations SET name = 'tampered' WHERE version = 1
    `).run();
    expect(() => runSecureSessionMigrations(database)).toThrow(/ledger mismatch/);

    database.prepare(`
      UPDATE secure_session_schema_migrations SET name = ? WHERE version = 1
    `).run(SECURE_SESSION_MIGRATIONS[0]?.name);
    database.prepare(`
      INSERT INTO secure_session_schema_migrations (version, name, applied_at)
      VALUES (999, 'unknown', ?)
    `).run(new Date().toISOString());
    expect(() => runSecureSessionMigrations(database)).toThrow(/ledger mismatch/);
    database.close();
  });

  it("uses only fixed fields and constrains encrypted persistence to bounded blobs", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runSecureSessionMigrations(database);

    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'secure_session_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const forbiddenColumns: string[] = [];
    for (const { name } of tables) {
      const columns = database.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
      for (const column of columns) {
        if (["value", "raw_value", "command", "output", "metadata", "error", "hash"].includes(column.name)) {
          forbiddenColumns.push(`${name}.${column.name}`);
        }
        expect(column.name.endsWith("_json")).toBe(false);
      }
    }
    expect(forbiddenColumns).toEqual([]);

    database.prepare(`
      INSERT INTO secure_session_provider (
        provider_id, kind, display_name, enabled, status, last_verified_at,
        last_status_code, created_at, updated_at
      ) VALUES ('local', 'local_keychain', 'Local', 1, 'available', NULL, 'ok', 't', 't')
    `).run();
    expect(() => database.prepare(`
      INSERT INTO secure_session_secret (
        secret_id, provider_id, display_alias, display_name, scope_kind, profile_id,
        retention, source_locator, encrypted_material, created_at, updated_at
      ) VALUES ('s', 'local', 'alias', NULL, 'instance', NULL, 'saved', 'locator', 'plaintext', 't', 't')
    `).run()).toThrow();
    database.close();
  });

  it("backfills lease grant provenance and preserves the audit ledger from v1", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE secure_session_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
    SECURE_SESSION_MIGRATIONS[0]!.up(database);
    database.prepare(`
      INSERT INTO secure_session_schema_migrations (version, name, applied_at)
      VALUES (1, ?, 't')
    `).run(SECURE_SESSION_MIGRATIONS[0]!.name);
    database.exec(`
      INSERT INTO secure_session_provider (
        provider_id, kind, display_name, enabled, status, last_status_code,
        created_at, updated_at
      ) VALUES ('local', 'local_keychain', 'Local', 1, 'available', 'ok', 't', 't');
      INSERT INTO secure_session_secret (
        secret_id, provider_id, display_alias, scope_kind, profile_id, retention,
        source_locator, encrypted_material, created_at, updated_at
      ) VALUES (
        'secret', 'local', 'deploy', 'instance', NULL, 'saved', 'local',
        x'01', 't', 't'
      );
      INSERT INTO secure_session_binding (
        binding_id, secret_id, delivery_kind, target_name, created_at, updated_at
      ) VALUES ('binding', 'secret', 'environment', 'TOKEN', 't', 't');
      INSERT INTO secure_session_state (
        session_agent_id, revision, profile_id, execution_mode,
        environment_status, created_at, updated_at
      ) VALUES ('session', 2, 'profile', 'secure', 'ready', 't', 't');
      INSERT INTO secure_session_request (
        request_id, session_agent_id, secret_id, display_alias,
        requested_lease_kind, purpose_summary, requested_by_agent_id,
        requested_by_display_name, state, requested_at, resolved_at
      ) VALUES (
        'request', 'session', 'secret', 'deploy', 'task', 'Deploy',
        'agent', 'Agent', 'approved', 't', 't'
      );
      INSERT INTO secure_session_lease (
        lease_id, session_agent_id, secret_id, request_id, lease_kind, state,
        issued_revision, updated_revision, remaining_uses, created_at, updated_at
      ) VALUES
        ('manual', 'session', 'secret', NULL, 'task', 'active', 1, 1, NULL, 't', 't'),
        ('requested', 'session', 'secret', 'request', 'task', 'active', 2, 2, NULL, 't', 't');
      INSERT INTO secure_session_audit (
        event_type, session_agent_id, secret_id, lease_id, outcome, occurred_at
      ) VALUES ('lease_created', 'session', 'secret', 'manual', 'created', 't');
    `);

    runSecureSessionMigrations(database);

    expect(database.prepare(`
      SELECT lease_id, grant_source
      FROM secure_session_lease
      ORDER BY lease_id
    `).all()).toEqual([
      { lease_id: "manual", grant_source: "manual" },
      { lease_id: "requested", grant_source: "access_request" }
    ]);
    expect(database.prepare(`
      SELECT event_type, profile_id, secret_id
      FROM secure_session_audit
    `).all()).toEqual([{
      event_type: "lease_created",
      profile_id: null,
      secret_id: "secret"
    }]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("migrates manager state, cancels unsafe delegated requests, and enforces principal ownership", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE secure_session_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
    SECURE_SESSION_MIGRATIONS[0]!.up(database);
    SECURE_SESSION_MIGRATIONS[1]!.up(database);
    database.prepare(`
      INSERT INTO secure_session_schema_migrations (version, name, applied_at)
      VALUES (1, ?, 't'), (2, ?, 't')
    `).run(
      SECURE_SESSION_MIGRATIONS[0]!.name,
      SECURE_SESSION_MIGRATIONS[1]!.name
    );
    database.exec(`
      INSERT INTO secure_session_state (
        session_agent_id, revision, profile_id, execution_mode,
        environment_status, created_at, updated_at
      ) VALUES ('manager', 0, 'profile', 'secure', 'ready', 't', 't');
      INSERT INTO secure_session_revision (
        session_agent_id, revision, event_type, affected_count, occurred_at
      ) VALUES ('manager', 0, 'initialized', 0, 't');
      INSERT INTO secure_session_request (
        request_id, session_agent_id, display_alias, requested_lease_kind,
        purpose_summary, requested_by_agent_id, requested_by_display_name,
        state, requested_at
      ) VALUES
        (
          'legacy-worker-request', 'manager', 'deploy', 'task', 'Deploy',
          'worker', 'Worker', 'pending', 't'
        ),
        (
          'manager-request', 'manager', 'deploy', 'task', 'Deploy',
          'manager', 'Manager', 'pending', 't'
        );
    `);

    runSecureSessionMigrations(database);

    expect(database.prepare(`
      SELECT principal_kind, owner_manager_agent_id, worker_assignment_id,
        revision
      FROM secure_session_state
      WHERE session_agent_id = 'manager'
    `).get()).toEqual({
      principal_kind: "manager",
      owner_manager_agent_id: null,
      worker_assignment_id: null,
      revision: 1
    });
    expect(database.prepare(`
      SELECT request_id, state, worker_assignment_id, resolved_at IS NOT NULL AS resolved
      FROM secure_session_request
      ORDER BY request_id
    `).all()).toEqual([
      {
        request_id: "legacy-worker-request",
        state: "cancelled",
        worker_assignment_id: null,
        resolved: 1
      },
      {
        request_id: "manager-request",
        state: "pending",
        worker_assignment_id: null,
        resolved: 0
      }
    ]);
    expect(database.prepare(`
      SELECT event_type, request_id, outcome
      FROM secure_session_audit
      WHERE request_id = 'legacy-worker-request'
    `).get()).toEqual({
      event_type: "request_resolved",
      request_id: "legacy-worker-request",
      outcome: "cancelled"
    });

    database.exec(`
      INSERT INTO secure_session_state (
        session_agent_id, revision, profile_id, principal_kind,
        owner_manager_agent_id, worker_assignment_id, execution_mode,
        environment_status, created_at, updated_at
      ) VALUES (
        'worker', 0, 'profile', 'worker', 'manager', NULL,
        'secure', 'ready', 't', 't'
      );
    `);
    expect(() => database.exec(`
      INSERT INTO secure_session_state (
        session_agent_id, revision, profile_id, principal_kind,
        owner_manager_agent_id, execution_mode, environment_status,
        created_at, updated_at
      ) VALUES (
        'wrong-profile-worker', 0, 'other-profile', 'worker', 'manager',
        'secure', 'ready', 't', 't'
      );
    `)).toThrow(/same-profile manager/);
    expect(() => database.prepare(`
      UPDATE secure_session_state
      SET profile_id = 'other-profile'
      WHERE session_agent_id = 'worker'
    `).run()).toThrow(/identity is immutable/);

    database.prepare(`
      UPDATE secure_session_state
      SET worker_assignment_id = 'assignment-1'
      WHERE session_agent_id = 'worker'
    `).run();
    expect(() => database.exec(`
      INSERT INTO secure_session_request (
        request_id, session_agent_id, display_alias, requested_lease_kind,
        purpose_summary, requested_by_agent_id, requested_by_display_name,
        state, requested_at, worker_assignment_id
      ) VALUES (
        'missing-assignment', 'worker', 'deploy', 'task', 'Deploy',
        'worker', 'Worker', 'pending', 't', NULL
      );
    `)).toThrow(/principal assignment/);
    database.exec(`
      INSERT INTO secure_session_request (
        request_id, session_agent_id, display_alias, requested_lease_kind,
        purpose_summary, requested_by_agent_id, requested_by_display_name,
        state, requested_at, worker_assignment_id
      ) VALUES (
        'worker-request', 'worker', 'deploy', 'task', 'Deploy',
        'worker', 'Worker', 'pending', 't', 'assignment-1'
      );
    `);
    expect(() => database.exec(`
      INSERT INTO secure_session_request (
        request_id, session_agent_id, display_alias, requested_lease_kind,
        purpose_summary, requested_by_agent_id, requested_by_display_name,
        state, requested_at, worker_assignment_id
      ) VALUES (
        'spoofed-request', 'worker', 'deploy', 'task', 'Deploy',
        'manager', 'Manager', 'pending', 't', 'assignment-1'
      );
    `)).toThrow(/principal assignment/);

    database.prepare(`
      DELETE FROM secure_session_state WHERE session_agent_id = 'manager'
    `).run();
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM secure_session_state
    `).get()).toEqual({ count: 0 });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });
});
