import { mkdir } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { isCollaborationServerRuntimeTarget } from "../../runtime-target.js";
import type { SwarmConfig } from "../../swarm/types.js";
import { getOrCreateCollaborationAuthDb } from "./collaboration-db.js";
import { COLLABORATION_AUTH_MIGRATIONS, type CollaborationAuthMigration } from "./migrations.js";

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

    await applyMigration(database, migration, config);
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

async function applyMigration(
  database: Database.Database,
  migration: CollaborationAuthMigration,
  config: SwarmConfig,
): Promise<void> {
  if (migration.backupBeforeApply) {
    await backupDatabase(database, config, migration.name);
  }

  const apply = database.transaction(() => {
    if (migration.apply) {
      migration.apply(database);
    } else if (migration.sql) {
      database.exec(migration.sql);
    } else {
      throw new Error(`Invalid collaboration auth migration: ${migration.name}`);
    }

    database
      .prepare(`INSERT INTO ${MIGRATIONS_TABLE_NAME} (name, applied_at) VALUES (?, ?)`)
      .run(migration.name, new Date().toISOString());
  });

  apply();
}

async function backupDatabase(
  database: Database.Database,
  config: SwarmConfig,
  migrationName: string,
): Promise<void> {
  const dbPath = config.paths.collaborationAuthDbPath;
  if (!dbPath) {
    throw new Error("Missing collaboration auth DB path in config");
  }

  const backupDir = path.join(path.dirname(dbPath), "backups");
  await mkdir(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const safeMigrationName = migrationName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const backupPath = path.join(backupDir, `${timestamp}-${safeMigrationName}.db`);
  await database.backup(backupPath);
}
