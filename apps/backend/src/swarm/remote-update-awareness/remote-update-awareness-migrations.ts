import type Database from "better-sqlite3";

export interface RemoteUpdateAwarenessMigration {
  version: number;
  name: string;
  up: (database: Database.Database) => void;
}

export const REMOTE_UPDATE_AWARENESS_MIGRATIONS: readonly RemoteUpdateAwarenessMigration[] = [
  {
    version: 1,
    name: "initial_remote_update_awareness_schema",
    up(database) {
      database.exec(`
        CREATE TABLE remote_update_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          global_enabled INTEGER NOT NULL DEFAULT 0 CHECK (global_enabled IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE remote_update_monitor (
          monitor_key TEXT PRIMARY KEY,
          common_dir TEXT NOT NULL,
          remote_name TEXT NOT NULL,
          target_ref TEXT NOT NULL,
          remote_fingerprint TEXT NOT NULL,
          latest_state TEXT,
          latest_tip_oid TEXT,
          generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
          last_observed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE remote_update_project (
          project_id TEXT PRIMARY KEY,
          override TEXT NOT NULL DEFAULT 'inherit' CHECK (override IN ('inherit', 'on', 'off')),
          monitor_key TEXT REFERENCES remote_update_monitor(monitor_key),
          remote_fingerprint TEXT,
          last_completed_observed_at TEXT,
          next_due_at TEXT,
          failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
          backoff_until TEXT,
          generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
          last_tip_oid TEXT,
          last_state TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX remote_update_project_monitor_idx
          ON remote_update_project(monitor_key);

        CREATE TABLE remote_update_dismissal (
          project_id TEXT PRIMARY KEY REFERENCES remote_update_project(project_id) ON DELETE CASCADE,
          monitor_key TEXT NOT NULL REFERENCES remote_update_monitor(monitor_key) ON DELETE CASCADE,
          ref TEXT NOT NULL,
          tip_oid TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          dismissed_at TEXT NOT NULL
        );
      `);

      const now = new Date().toISOString();
      database.prepare(`
        INSERT OR IGNORE INTO remote_update_settings (id, global_enabled, created_at, updated_at)
        VALUES (1, 0, ?, ?)
      `).run(now, now);
    }
  },
  {
    version: 2,
    name: "project_attention_generation",
    up(database) {
      database.exec(`
        ALTER TABLE remote_update_project
          ADD COLUMN attention_generation INTEGER CHECK (attention_generation IS NULL OR attention_generation >= 0);
        UPDATE remote_update_project
          SET attention_generation = generation
          WHERE generation > 0 AND last_state IN ('remote_ahead', 'diverged', 'rewound', 'unknown');
      `);
    }
  }
];

export function runRemoteUpdateAwarenessMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS remote_update_awareness_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedRows = database.prepare(
    "SELECT version, name FROM remote_update_awareness_schema_migrations ORDER BY version"
  ).all() as Array<{ version: number; name: string }>;
  const known = new Map(REMOTE_UPDATE_AWARENESS_MIGRATIONS.map((migration) => [migration.version, migration.name]));
  for (const row of appliedRows) {
    if (known.get(row.version) !== row.name) {
      throw new Error("Remote update awareness schema migration ledger mismatch");
    }
  }

  const applied = new Set(appliedRows.map((row) => row.version));
  for (const migration of REMOTE_UPDATE_AWARENESS_MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }

    database.transaction(() => {
      migration.up(database);
      database.prepare(`
        INSERT INTO remote_update_awareness_schema_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}
