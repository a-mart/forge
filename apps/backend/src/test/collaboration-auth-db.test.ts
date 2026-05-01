import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeCollaborationAuthDb, getOrCreateCollaborationAuthDb } from "../collaboration/auth/collaboration-db.js";
import { COLLABORATION_AUTH_MIGRATIONS } from "../collaboration/auth/migrations.js";
import { runCollaborationAuthMigrations } from "../collaboration/auth/migration-runner.js";
import { createTempConfig } from "../test-support/temp-config.js";
import type { SwarmConfig } from "../swarm/types.js";

const EXPECTED_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "collaboration_user",
  "collaboration_invite",
  "collab_workspace",
  "collab_category",
  "collab_channel",
  "collab_channel_user_state",
  "collaboration_audit_log",
  "_forge_collaboration_migrations",
] as const;

const EXPECTED_MIGRATIONS = [
  "0001-better-auth-base.sql",
  "0002-collaboration-user.sql",
  "0003-collaboration-invite.sql",
  "0004-collaboration-workspace.sql",
  "0005-collaboration-audit-log.sql",
  "0006-collab-category-defaults-upgrade.sql",
  "0007-collab-channel-reasoning.sql",
  "0008-collab-specialist-selections.sql",
] as const;

const EXPECTED_MIGRATION_0008_DEFAULT_SPECIALIST_HANDLES = [
  "collab-planner",
  "collab-reviewer",
  "collab-doc-writer",
  "collab-scout",
  "collab-researcher",
] as const;

const LEGACY_0004_COLLABORATION_WORKSPACE_SQL = `CREATE TABLE IF NOT EXISTS collab_workspace (
  workspace_id TEXT PRIMARY KEY,
  backing_profile_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  ai_display_name TEXT,
  created_by_user_id TEXT,
  default_model_provider TEXT NOT NULL,
  default_model_id TEXT NOT NULL,
  default_model_thinking_level TEXT NOT NULL,
  default_cwd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS collab_category (
  category_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  default_model_id TEXT,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES collab_workspace(workspace_id) ON DELETE CASCADE,
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS collab_category_workspace_position_idx ON collab_category(workspace_id, position, category_id);

CREATE TABLE IF NOT EXISTS collab_channel (
  channel_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  category_id TEXT,
  backing_session_agent_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  ai_enabled INTEGER NOT NULL DEFAULT 1 CHECK (ai_enabled IN (0, 1)),
  model_id TEXT,
  position INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  archived_by_user_id TEXT,
  created_by_user_id TEXT,
  last_message_seq INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES collab_workspace(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES collab_category(category_id) ON DELETE SET NULL,
  FOREIGN KEY (archived_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS collab_channel_workspace_listing_idx ON collab_channel(workspace_id, archived, category_id, position, channel_id);
CREATE INDEX IF NOT EXISTS collab_channel_backing_session_idx ON collab_channel(backing_session_agent_id);

CREATE TABLE IF NOT EXISTS collab_channel_user_state (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_read_message_id TEXT,
  last_read_message_seq INTEGER NOT NULL DEFAULT 0,
  last_read_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES collab_channel(channel_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS collab_channel_user_state_user_idx ON collab_channel_user_state(user_id, channel_id);
`;

const tempRoots: string[] = [];
const activeConfigs: SwarmConfig[] = [];

afterEach(async () => {
  for (const config of activeConfigs.splice(0)) {
    closeCollaborationAuthDb(config);
  }

  await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function createFreshTestConfig(runtimeTarget: "builder" | "collaboration-server" = "collaboration-server") {
  const handle = await createTempConfig({
    runtimeTarget,
    tempRootDir: await mkdtemp(join(tmpdir(), "forge-collaboration-auth-db-")),
  });
  tempRoots.push(handle.tempRootDir);
  activeConfigs.push(handle.config);
  return handle.config;
}

async function openMigratedDatabase(config: SwarmConfig) {
  await runCollaborationAuthMigrations(config);
  return getOrCreateCollaborationAuthDb(config);
}

function requireMigrationSql(name: string): string {
  const migration = COLLABORATION_AUTH_MIGRATIONS.find((entry) => entry.name === name);
  if (!migration?.sql) {
    throw new Error(`Missing SQL migration fixture: ${name}`);
  }

  return migration.sql;
}

function listTableColumns(database: Awaited<ReturnType<typeof getOrCreateCollaborationAuthDb>>, tableName: string): string[] {
  return database
    .prepare<[], { name: string }>(`PRAGMA table_info("${tableName.replaceAll('"', '""')}")`)
    .all()
    .map((row) => row.name);
}

describe("collaboration auth DB", () => {
  it("initializes a fresh DB file from migrations", async () => {
    const config = await createFreshTestConfig();
    const dbPath = config.paths.collaborationAuthDbPath;

    expect(dbPath).toBeDefined();
    expect(existsSync(dbPath!)).toBe(false);

    await runCollaborationAuthMigrations(config);

    expect(existsSync(dbPath!)).toBe(true);
  });

  it("runs migrations idempotently across repeated invocations", async () => {
    const config = await createFreshTestConfig();

    await runCollaborationAuthMigrations(config);
    closeCollaborationAuthDb(config);

    await expect(runCollaborationAuthMigrations(config)).resolves.toBeUndefined();
  });

  it("enables WAL journal mode and foreign keys", async () => {
    const config = await createFreshTestConfig();
    const database = await getOrCreateCollaborationAuthDb(config);

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("creates all expected tables and tracks applied migrations", async () => {
    const config = await createFreshTestConfig();
    const database = await openMigratedDatabase(config);

    const tableNames = database
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`,
      )
      .all()
      .map((row) => row.name);

    expect(tableNames).toEqual([...EXPECTED_TABLES].sort((left, right) => left.localeCompare(right)));

    const appliedMigrations = database
      .prepare<[], { name: string }>("SELECT name FROM _forge_collaboration_migrations ORDER BY name ASC")
      .all()
      .map((row) => row.name);

    expect(appliedMigrations).toEqual([...EXPECTED_MIGRATIONS]);
  });

  it("upgrades legacy 0004 databases by adding missing category default columns", async () => {
    const config = await createFreshTestConfig();
    const database = await getOrCreateCollaborationAuthDb(config);

    database.exec(requireMigrationSql("0001-better-auth-base.sql"));
    database.exec(requireMigrationSql("0002-collaboration-user.sql"));
    database.exec(requireMigrationSql("0003-collaboration-invite.sql"));
    database.exec(LEGACY_0004_COLLABORATION_WORKSPACE_SQL);
    database.exec(`
      CREATE TABLE IF NOT EXISTS _forge_collaboration_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const insertAppliedMigration = database.prepare(
      `INSERT INTO _forge_collaboration_migrations (name, applied_at) VALUES (?, ?)`,
    );
    for (const migrationName of EXPECTED_MIGRATIONS.slice(0, 4)) {
      insertAppliedMigration.run(migrationName, "2026-04-28T00:00:00.000Z");
    }

    database.prepare(
      `INSERT INTO collab_workspace (
         workspace_id,
         backing_profile_id,
         display_name,
         description,
         ai_display_name,
         created_by_user_id,
         default_model_provider,
         default_model_id,
         default_model_thinking_level,
         default_cwd,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "workspace-legacy",
      "_collaboration",
      "Legacy Workspace",
      null,
      null,
      null,
      "openai-codex",
      "gpt-5.3-codex",
      "xhigh",
      "/repo",
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );

    database.prepare(
      `INSERT INTO collab_category (
         category_id,
         workspace_id,
         name,
         default_model_id,
         position,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "category-legacy",
      "workspace-legacy",
      "Legacy Category",
      "claude-opus-4-6",
      0,
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );

    expect(listTableColumns(database, "collab_category")).not.toContain("default_model_provider");
    expect(listTableColumns(database, "collab_category")).not.toContain("default_model_thinking_level");
    expect(listTableColumns(database, "collab_category")).not.toContain("default_cwd");
    expect(listTableColumns(database, "collab_channel")).not.toContain("model_thinking_level");

    await runCollaborationAuthMigrations(config);

    expect(listTableColumns(database, "collab_category")).toContain("default_model_provider");
    expect(listTableColumns(database, "collab_category")).toContain("default_model_thinking_level");
    expect(listTableColumns(database, "collab_category")).toContain("default_cwd");
    expect(listTableColumns(database, "collab_channel")).toContain("model_thinking_level");

    const upgradedCategory = database.prepare<[], {
      default_model_id: string | null;
      default_model_provider: string | null;
      default_model_thinking_level: string | null;
      default_cwd: string | null;
    }>(
      `SELECT default_model_id, default_model_provider, default_model_thinking_level, default_cwd
       FROM collab_category
       WHERE category_id = 'category-legacy'`,
    ).get();

    expect(upgradedCategory).toEqual({
      default_model_id: "claude-opus-4-6",
      default_model_provider: null,
      default_model_thinking_level: null,
      default_cwd: null,
    });

    database.prepare(
      `INSERT INTO collab_category (
         category_id,
         workspace_id,
         name,
         default_model_provider,
         default_model_id,
         default_model_thinking_level,
         default_cwd,
         position,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "category-upgraded",
      "workspace-legacy",
      "Upgraded Category",
      "anthropic",
      "claude-opus-4-6",
      "high",
      "/repo/reviews",
      1,
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );

    const insertedCategory = database.prepare<[], {
      default_model_provider: string | null;
      default_model_id: string | null;
      default_model_thinking_level: string | null;
      default_cwd: string | null;
    }>(
      `SELECT default_model_provider, default_model_id, default_model_thinking_level, default_cwd
       FROM collab_category
       WHERE category_id = 'category-upgraded'`,
    ).get();

    expect(insertedCategory).toEqual({
      default_model_provider: "anthropic",
      default_model_id: "claude-opus-4-6",
      default_model_thinking_level: "high",
      default_cwd: "/repo/reviews",
    });

    const appliedMigrations = database
      .prepare<[], { name: string }>("SELECT name FROM _forge_collaboration_migrations ORDER BY name ASC")
      .all()
      .map((row) => row.name);

    expect(appliedMigrations).toEqual([...EXPECTED_MIGRATIONS]);
  });

  it("backs up and backfills collaboration specialist selection columns", async () => {
    const config = await createFreshTestConfig();
    const database = await getOrCreateCollaborationAuthDb(config);

    database.exec(requireMigrationSql("0001-better-auth-base.sql"));
    database.exec(requireMigrationSql("0002-collaboration-user.sql"));
    database.exec(requireMigrationSql("0003-collaboration-invite.sql"));
    database.exec(LEGACY_0004_COLLABORATION_WORKSPACE_SQL);
    database.exec(requireMigrationSql("0005-collaboration-audit-log.sql"));
    database.exec(`
      ALTER TABLE collab_category ADD COLUMN default_model_provider TEXT;
      ALTER TABLE collab_category ADD COLUMN default_model_thinking_level TEXT;
      ALTER TABLE collab_category ADD COLUMN default_cwd TEXT;
      ALTER TABLE collab_channel ADD COLUMN model_thinking_level TEXT;
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS _forge_collaboration_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const insertAppliedMigration = database.prepare(
      `INSERT INTO _forge_collaboration_migrations (name, applied_at) VALUES (?, ?)`,
    );
    for (const migrationName of EXPECTED_MIGRATIONS.slice(0, 7)) {
      insertAppliedMigration.run(migrationName, "2026-04-28T00:00:00.000Z");
    }

    expect(listTableColumns(database, "collab_category")).not.toContain("default_specialist_handles_json");
    expect(listTableColumns(database, "collab_channel")).not.toContain("active_specialist_handles_json");

    database.prepare(
      `INSERT INTO collab_workspace (
         workspace_id,
         backing_profile_id,
         display_name,
         description,
         ai_display_name,
         created_by_user_id,
         default_model_provider,
         default_model_id,
         default_model_thinking_level,
         default_cwd,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "workspace-1",
      "_collaboration",
      "Workspace",
      null,
      null,
      null,
      "openai-codex",
      "gpt-5.3-codex",
      "xhigh",
      "/repo",
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );
    database.prepare(
      `INSERT INTO collab_category (
         category_id,
         workspace_id,
         name,
         default_model_provider,
         default_model_id,
         default_model_thinking_level,
         default_cwd,
         position,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "category-1",
      "workspace-1",
      "General",
      null,
      null,
      null,
      null,
      0,
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );
    database.prepare(
      `INSERT INTO collab_channel (
         channel_id,
         workspace_id,
         category_id,
         backing_session_agent_id,
         name,
         slug,
         description,
         ai_enabled,
         model_id,
         position,
         archived,
         archived_at,
         archived_by_user_id,
         created_by_user_id,
         last_message_seq,
         last_message_id,
         last_message_at,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "channel-1",
      "workspace-1",
      "category-1",
      "session-1",
      "General",
      "general",
      null,
      1,
      null,
      0,
      0,
      null,
      null,
      null,
      0,
      null,
      null,
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );

    await runCollaborationAuthMigrations(config);

    expect(listTableColumns(database, "collab_category")).toContain("default_specialist_handles_json");
    expect(listTableColumns(database, "collab_channel")).toContain("active_specialist_handles_json");

    const defaultHandlesJson = JSON.stringify([...EXPECTED_MIGRATION_0008_DEFAULT_SPECIALIST_HANDLES]);
    expect(
      database.prepare<[], { value: string }>(
        `SELECT default_specialist_handles_json AS value FROM collab_category WHERE category_id = 'category-1'`,
      ).get()?.value,
    ).toBe(defaultHandlesJson);
    expect(
      database.prepare<[], { value: string }>(
        `SELECT active_specialist_handles_json AS value FROM collab_channel WHERE channel_id = 'channel-1'`,
      ).get()?.value,
    ).toBe(defaultHandlesJson);

    const backups = await readdir(join(dirname(config.paths.collaborationAuthDbPath!), "backups"));
    expect(backups.some((name) => name.endsWith("0008-collab-specialist-selections.sql.db"))).toBe(true);

    closeCollaborationAuthDb(config);
    await expect(runCollaborationAuthMigrations(config)).resolves.toBeUndefined();
  });

  it("preserves explicit empty and missing specialist selections when a backfill reruns", async () => {
    const config = await createFreshTestConfig();
    const database = await openMigratedDatabase(config);

    database.prepare(
      `INSERT INTO collab_workspace (
         workspace_id,
         backing_profile_id,
         display_name,
         description,
         ai_display_name,
         created_by_user_id,
         default_model_provider,
         default_model_id,
         default_model_thinking_level,
         default_cwd,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "workspace-preserve-selections",
      "_collaboration",
      "Workspace",
      null,
      null,
      null,
      "openai-codex",
      "gpt-5.3-codex",
      "xhigh",
      "/repo",
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );

    const explicitEmptyJson = JSON.stringify([]);
    const missingHandleJson = JSON.stringify(["missing-selected-specialist"]);
    database.prepare(
      `INSERT INTO collab_category (
         category_id,
         workspace_id,
         name,
         default_specialist_handles_json,
         position,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "category-empty",
      "workspace-preserve-selections",
      "Explicit Empty",
      explicitEmptyJson,
      0,
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );
    database.prepare(
      `INSERT INTO collab_channel (
         channel_id,
         workspace_id,
         category_id,
         backing_session_agent_id,
         name,
         slug,
         description,
         ai_enabled,
         model_id,
         active_specialist_handles_json,
         position,
         archived,
         archived_at,
         archived_by_user_id,
         created_by_user_id,
         last_message_seq,
         last_message_id,
         last_message_at,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "channel-missing",
      "workspace-preserve-selections",
      "category-empty",
      "session-missing",
      "Missing Handle",
      "missing-handle",
      null,
      1,
      null,
      missingHandleJson,
      0,
      0,
      null,
      null,
      null,
      0,
      null,
      null,
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );
    database.prepare("DELETE FROM _forge_collaboration_migrations WHERE name = ?").run("0008-collab-specialist-selections.sql");

    await runCollaborationAuthMigrations(config);

    expect(
      database.prepare<[], { value: string }>(
        `SELECT default_specialist_handles_json AS value FROM collab_category WHERE category_id = 'category-empty'`,
      ).get()?.value,
    ).toBe(explicitEmptyJson);
    expect(
      database.prepare<[], { value: string }>(
        `SELECT active_specialist_handles_json AS value FROM collab_channel WHERE channel_id = 'channel-missing'`,
      ).get()?.value,
    ).toBe(missingHandleJson);
  });

  it("rejects invalid specialist selection JSON without recording the migration or leaving partial backfills", async () => {
    const config = await createFreshTestConfig();
    const database = await getOrCreateCollaborationAuthDb(config);

    await runCollaborationAuthMigrations(config);
    database.prepare(
      `INSERT INTO collab_workspace (
         workspace_id,
         backing_profile_id,
         display_name,
         description,
         ai_display_name,
         created_by_user_id,
         default_model_provider,
         default_model_id,
         default_model_thinking_level,
         default_cwd,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "workspace-invalid-json",
      "_collaboration",
      "Workspace",
      null,
      null,
      null,
      "openai-codex",
      "gpt-5.3-codex",
      "xhigh",
      "/repo",
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );
    database.prepare(
      `INSERT INTO collab_category (
         category_id,
         workspace_id,
         name,
         default_specialist_handles_json,
         position,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "category-null-before-failure",
      "workspace-invalid-json",
      "Null Before Failure",
      null,
      0,
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );
    database.prepare(
      `INSERT INTO collab_category (
         category_id,
         workspace_id,
         name,
         default_specialist_handles_json,
         position,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "category-invalid-json",
      "workspace-invalid-json",
      "Invalid JSON",
      "not-json",
      1,
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );
    database.prepare(
      `INSERT INTO collab_channel (
         channel_id,
         workspace_id,
         category_id,
         backing_session_agent_id,
         name,
         slug,
         description,
         ai_enabled,
         model_id,
         active_specialist_handles_json,
         position,
         archived,
         archived_at,
         archived_by_user_id,
         created_by_user_id,
         last_message_seq,
         last_message_id,
         last_message_at,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "channel-null-before-failure",
      "workspace-invalid-json",
      "category-invalid-json",
      "session-null-before-failure",
      "Null Before Failure",
      "null-before-failure",
      null,
      1,
      null,
      null,
      0,
      0,
      null,
      null,
      null,
      0,
      null,
      null,
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );
    database.prepare("DELETE FROM _forge_collaboration_migrations WHERE name = ?").run("0008-collab-specialist-selections.sql");

    await expect(runCollaborationAuthMigrations(config)).rejects.toThrow("Invalid collaboration specialist handle JSON");

    const applied = database
      .prepare<[string], { name: string }>("SELECT name FROM _forge_collaboration_migrations WHERE name = ?")
      .get("0008-collab-specialist-selections.sql");
    expect(applied).toBeUndefined();
    expect(
      database.prepare<[], { value: string | null }>(
        `SELECT default_specialist_handles_json AS value FROM collab_category WHERE category_id = 'category-null-before-failure'`,
      ).get()?.value,
    ).toBeNull();
    expect(
      database.prepare<[], { value: string | null }>(
        `SELECT active_specialist_handles_json AS value FROM collab_channel WHERE channel_id = 'channel-null-before-failure'`,
      ).get()?.value,
    ).toBeNull();

    const backups = await readdir(join(dirname(config.paths.collaborationAuthDbPath!), "backups"));
    expect(backups.some((name) => name.endsWith("0008-collab-specialist-selections.sql.db"))).toBe(true);
  });

  it("supports inserting and querying collaboration workspace and category defaults metadata", async () => {
    const config = await createFreshTestConfig();
    const database = await openMigratedDatabase(config);

    database.prepare(
      `INSERT INTO collab_workspace (
         workspace_id,
         backing_profile_id,
         display_name,
         description,
         ai_display_name,
         created_by_user_id,
         default_model_provider,
         default_model_id,
         default_model_thinking_level,
         default_cwd,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "workspace-1",
      "_collaboration",
      "Workspace",
      null,
      null,
      null,
      "openai-codex",
      "gpt-5.3-codex",
      "xhigh",
      "/repo",
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );

    database.prepare(
      `INSERT INTO collab_category (
         category_id,
         workspace_id,
         name,
         default_model_provider,
         default_model_id,
         default_model_thinking_level,
         default_cwd,
         position,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "category-1",
      "workspace-1",
      "Spec Review",
      "anthropic",
      "claude-opus-4-6",
      "high",
      "/repo/reviews",
      0,
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    );

    const workspaceRow = database.prepare<[], {
      default_cwd: string;
      default_model_provider: string;
      default_model_id: string;
      default_model_thinking_level: string;
    }>(
      `SELECT default_cwd, default_model_provider, default_model_id, default_model_thinking_level FROM collab_workspace WHERE workspace_id = 'workspace-1'`,
    ).get();

    const categoryRow = database.prepare<[], {
      default_cwd: string | null;
      default_model_provider: string | null;
      default_model_id: string | null;
      default_model_thinking_level: string | null;
    }>(
      `SELECT default_cwd, default_model_provider, default_model_id, default_model_thinking_level FROM collab_category WHERE category_id = 'category-1'`,
    ).get();

    expect(workspaceRow).toEqual({
      default_cwd: "/repo",
      default_model_provider: "openai-codex",
      default_model_id: "gpt-5.3-codex",
      default_model_thinking_level: "xhigh",
    });
    expect(categoryRow).toEqual({
      default_cwd: "/repo/reviews",
      default_model_provider: "anthropic",
      default_model_id: "claude-opus-4-6",
      default_model_thinking_level: "high",
    });
  });

  it("stays inert in builder runtime", async () => {
    const config = await createFreshTestConfig("builder");

    await expect(runCollaborationAuthMigrations(config)).resolves.toBeUndefined();
    await expect(getOrCreateCollaborationAuthDb(config)).rejects.toThrow(
      "Collaboration auth DB requested while collaboration server runtime is disabled",
    );
  });
});
