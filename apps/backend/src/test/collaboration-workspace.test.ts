import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCollaborationAuthMigrations } from "../collaboration/auth/migration-runner.js";
import { createCollaborationDbHelpers } from "../collaboration/collab-db-helpers.js";
import { COLLABORATION_CHANNEL_ARCHETYPE_ID, COLLABORATION_PROFILE_ID } from "../collaboration/constants.js";
import {
  CollaborationWorkspaceService,
  hasInitializedWorkspaceDefaults,
  requireInitializedWorkspaceDefaults,
  workspaceDefaultsFromConfig,
} from "../collaboration/workspace-service.js";
import { createTempConfig } from "../test-support/temp-config.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function createWorkspaceHarness() {
  const handle = await createTempConfig({
    runtimeTarget: "collaboration-server",
    tempRootDir: await mkdtemp(join(tmpdir(), "forge-collaboration-workspace-")),
  });
  tempRoots.push(handle.tempRootDir);
  await runCollaborationAuthMigrations(handle.config);
  const dbHelpers = await createCollaborationDbHelpers(handle.config);
  const service = new CollaborationWorkspaceService(dbHelpers, {
    listProfiles: () => [
      {
        profileId: COLLABORATION_PROFILE_ID,
        displayName: "Collaboration",
        defaultSessionAgentId: COLLABORATION_PROFILE_ID,
      },
    ],
  }, handle.config);

  return { config: handle.config, dbHelpers, service };
}

describe("collaboration workspace service", () => {
  it("creates a default workspace using model and cwd defaults from config", async () => {
    const { config, service } = await createWorkspaceHarness();

    const workspace = await service.ensureDefaultWorkspace();
    expect(workspace).not.toBeNull();
    expect(workspace?.backingProfileId).toBe(COLLABORATION_PROFILE_ID);
    expect(workspace?.baseAi?.model).toEqual(config.defaultModel);
    expect(workspace?.baseAi?.cwd).toBe(config.defaultCwd);
    expect(workspace?.baseAi?.archetypeId).toBe(COLLABORATION_CHANNEL_ARCHETYPE_ID);
    expect(workspace?.baseAi?.contextMode).toBe("prompt_and_memory");
  });

  it("repairs blank stored defaults from config on read", async () => {
    const { config, dbHelpers, service } = await createWorkspaceHarness();
    const now = new Date().toISOString();
    const created = dbHelpers.createWorkspace({
      workspaceId: "workspace-1",
      backingProfileId: COLLABORATION_PROFILE_ID,
      displayName: "Workspace",
      description: null,
      aiDisplayName: null,
      createdByUserId: null,
      defaultModelProvider: config.defaultModel.provider,
      defaultModelId: config.defaultModel.modelId,
      defaultModelThinkingLevel: config.defaultModel.thinkingLevel,
      defaultCwd: config.defaultCwd,
      createdAt: now,
      updatedAt: now,
    });

    dbHelpers.database.prepare(
      `UPDATE collab_workspace
       SET default_model_provider = '',
           default_model_id = '',
           default_model_thinking_level = '',
           default_cwd = ''
       WHERE workspace_id = ?`,
    ).run(created.workspaceId);

    const workspace = await service.ensureDefaultWorkspace();
    expect(workspace?.baseAi?.cwd).toBe(config.defaultCwd);
    expect(workspace?.baseAi?.model.modelId).toBe(config.defaultModel.modelId);
  });

  it("exports initialized default helpers", () => {
    const defaults = workspaceDefaultsFromConfig({
      defaultModel: {
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkingLevel: "xhigh",
      },
      defaultCwd: "/repo",
    } as never);

    expect(hasInitializedWorkspaceDefaults(defaults)).toBe(true);
    expect(requireInitializedWorkspaceDefaults(defaults)).toEqual({
      defaultModelProvider: "openai-codex",
      defaultModelId: "gpt-5.3-codex",
      defaultModelThinkingLevel: "xhigh",
      defaultCwd: "/repo",
    });
  });
});
