import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeCollaborationAuthDb, getOrCreateCollaborationAuthDb } from "../collaboration/auth/collaboration-db.js";
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
] as const;

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
