import type Database from "better-sqlite3";
import { isCollaborationServerRuntimeTarget } from "../../runtime-target.js";
import type { SwarmConfig } from "../../swarm/types.js";
import { getOrCreateCollaborationAuthDb } from "./collaboration-db.js";
import { COLLABORATION_AUTH_MIGRATIONS } from "./migrations.js";

const MIGRATIONS_TABLE_NAME = "_forge_collaboration_migrations";

interface AppliedMigrationRow {
  name: string;
}

export async function runCollaborationAuthMigrations(config: SwarmConfig): Promise<void> {
  if (!isCollaborationServerRuntimeTarget(config.runtimeTarget)) {
    return;
  }

  const database = await getOrCreateCollaborationAuthDb(config);
  ensureMigrationsTable(database);

  const appliedMigrationNames = loadAppliedMigrationNames(database);
  for (const migration of COLLABORATION_AUTH_MIGRATIONS) {
    if (appliedMigrationNames.has(migration.name)) {
      continue;
    }

    applyMigration(database, migration.name, migration.sql);
    appliedMigrationNames.add(migration.name);
  }
}

function ensureMigrationsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE_NAME} (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function loadAppliedMigrationNames(database: Database.Database): Set<string> {
  const rows = database
    .prepare<[], AppliedMigrationRow>(`SELECT name FROM ${MIGRATIONS_TABLE_NAME} ORDER BY name ASC`)
    .all();
  return new Set(rows.map((row) => row.name));
}

function applyMigration(database: Database.Database, migrationFile: string, migrationSql: string): void {
  const apply = database.transaction(() => {
    database.exec(migrationSql);
    database
      .prepare(`INSERT INTO ${MIGRATIONS_TABLE_NAME} (name, applied_at) VALUES (?, ?)`)
      .run(migrationFile, new Date().toISOString());
  });

  apply();
}
