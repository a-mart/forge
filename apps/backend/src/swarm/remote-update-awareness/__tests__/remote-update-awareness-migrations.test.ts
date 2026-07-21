import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { REMOTE_UPDATE_AWARENESS_MIGRATIONS, runRemoteUpdateAwarenessMigrations } from "../remote-update-awareness-migrations.js";

describe("remote update awareness migrations", () => {
  it("runs transactionally, reruns idempotently, and never overwrites the seeded choice", () => {
    const database = new Database(":memory:");
    runRemoteUpdateAwarenessMigrations(database);
    database.prepare("UPDATE remote_update_settings SET global_enabled = 1 WHERE id = 1").run();
    runRemoteUpdateAwarenessMigrations(database);

    expect(database.prepare("SELECT global_enabled FROM remote_update_settings WHERE id = 1").get()).toEqual({ global_enabled: 1 });
    expect(database.prepare("SELECT version, name FROM remote_update_awareness_schema_migrations").all()).toEqual(
      REMOTE_UPDATE_AWARENESS_MIGRATIONS.map(({ version, name }) => ({ version, name }))
    );
    database.close();
  });

  it("rejects a migration ledger mismatch", () => {
    const database = new Database(":memory:");
    runRemoteUpdateAwarenessMigrations(database);
    database.prepare("UPDATE remote_update_awareness_schema_migrations SET name = 'tampered' WHERE version = 1").run();
    expect(() => runRemoteUpdateAwarenessMigrations(database)).toThrow(/ledger mismatch/);
    database.close();
  });
});
