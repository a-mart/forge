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
});
