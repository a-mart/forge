import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCollaborationAuthMigrations } from "../collaboration/auth/migration-runner.js";
import { CollaborationChannelService, type CollaborationChannelServiceSwarmManager, attachEffectiveChannelModelSettings } from "../collaboration/channel-service.js";
import { createCollaborationDbHelpers } from "../collaboration/collab-db-helpers.js";
import { COLLABORATION_PROFILE_ID } from "../collaboration/constants.js";
import { DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES } from "../collaboration/specialist-selection.js";
import type { AgentDescriptor } from "../swarm/types.js";
import { createTempConfig } from "../test-support/temp-config.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function createChannelHarness() {
  const handle = await createTempConfig({
    runtimeTarget: "collaboration-server",
    tempRootDir: await mkdtemp(join(tmpdir(), "forge-collaboration-channel-service-")),
  });
  tempRoots.push(handle.tempRootDir);
  await runCollaborationAuthMigrations(handle.config);
  const dbHelpers = await createCollaborationDbHelpers(handle.config);
  const now = new Date().toISOString();
  const workspace = dbHelpers.createWorkspace({
    workspaceId: "workspace-1",
    backingProfileId: COLLABORATION_PROFILE_ID,
    displayName: "Workspace",
    defaultModelProvider: handle.config.defaultModel.provider,
    defaultModelId: handle.config.defaultModel.modelId,
    defaultModelThinkingLevel: handle.config.defaultModel.thinkingLevel,
    defaultCwd: handle.config.defaultCwd,
    createdAt: now,
    updatedAt: now,
  });

  const descriptors = new Map<string, AgentDescriptor>();
  const manager: CollaborationChannelServiceSwarmManager = {
    getAgent: (agentId) => descriptors.get(agentId),
    createSessionFromBaseDescriptor: vi.fn(async (_profileId, base, options, overrides) => {
      const agentId = options?.sessionAgentId ?? "session-1";
      const descriptor = {
        agentId,
        role: "manager",
        profileId: COLLABORATION_PROFILE_ID,
        name: options?.name ?? "Channel",
        label: options?.label ?? "Channel",
        status: "idle",
        model: base.model,
        cwd: base.cwd,
        archetypeId: base.archetypeId,
        sessionSurface: overrides?.sessionSurface,
        collab: overrides?.collab,
      } as AgentDescriptor;
      descriptors.set(agentId, descriptor);
      return {
        profile: { id: COLLABORATION_PROFILE_ID, name: "Collaboration" } as never,
        sessionAgent: descriptor,
      };
    }),
    stopCollaborationSession: vi.fn(async () => ({ terminatedWorkerIds: [] })),
    deleteCollaborationSession: vi.fn(async () => ({ terminatedWorkerIds: [] })),
  };

  const availableHandles = new Set<string>([...DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES, "custom-collab"]);
  const availableSkillHandles = new Set<string>(["memory", "browser", "search"]);
  const service = new CollaborationChannelService(dbHelpers, manager, handle.config.paths.dataDir, {
    availableGlobalSpecialistHandles: () => availableHandles,
    availableGlobalSkillHandles: () => availableSkillHandles,
  });

  return { config: handle.config, dbHelpers, service, workspace, availableHandles, availableSkillHandles, manager, descriptors };
}

describe("collaboration channel service", () => {
  it("copies category default selected specialist handles to new channels", async () => {
    const { dbHelpers, service, workspace } = await createChannelHarness();
    const now = new Date().toISOString();
    const category = dbHelpers.createCategory({
      categoryId: "category-1",
      workspaceId: workspace.workspaceId,
      name: "Planning",
      defaultModelProvider: null,
      defaultModelId: null,
      defaultModelThinkingLevel: null,
      defaultCwd: null,
      defaultSpecialistHandlesJson: JSON.stringify(["custom-collab", "missing-specialist"]),
      position: 0,
      createdAt: now,
      updatedAt: now,
    });

    const channel = await service.createChannel({
      workspaceId: workspace.workspaceId,
      categoryId: category.categoryId,
      name: "Roadmap",
    });

    expect(channel.activeSelectedSpecialistHandles).toEqual(["custom-collab", "missing-specialist"]);
    expect(channel.missingSelectedSpecialistHandles).toEqual(["missing-specialist"]);
  });

  it("copies category skill defaults as raw saved state and supports explicit channel overrides", async () => {
    const { dbHelpers, service, workspace } = await createChannelHarness();
    const now = new Date().toISOString();
    const allCategory = dbHelpers.createCategory({
      categoryId: "category-skills-all",
      workspaceId: workspace.workspaceId,
      name: "All Skills",
      defaultModelProvider: null,
      defaultModelId: null,
      defaultModelThinkingLevel: null,
      defaultCwd: null,
      defaultSpecialistHandlesJson: JSON.stringify(DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES),
      defaultSkillHandlesJson: null,
      position: 0,
      createdAt: now,
      updatedAt: now,
    });
    const customCategory = dbHelpers.createCategory({
      categoryId: "category-skills-custom",
      workspaceId: workspace.workspaceId,
      name: "Custom Skills",
      defaultModelProvider: null,
      defaultModelId: null,
      defaultModelThinkingLevel: null,
      defaultCwd: null,
      defaultSpecialistHandlesJson: JSON.stringify(DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES),
      defaultSkillHandlesJson: JSON.stringify(["search", "missing-skill"]),
      position: 1,
      createdAt: now,
      updatedAt: now,
    });

    const allChannel = await service.createChannel({
      workspaceId: workspace.workspaceId,
      categoryId: allCategory.categoryId,
      name: "All channel",
    });
    expect(allChannel.activeSkillSelection?.mode).toBe("all");
    expect(dbHelpers.getChannel(allChannel.channelId)?.activeSkillHandlesJson).toBeNull();

    const customChannel = await service.createChannel({
      workspaceId: workspace.workspaceId,
      categoryId: customCategory.categoryId,
      name: "Custom channel",
    });
    expect(customChannel.activeSkillSelection).toEqual({
      mode: "custom",
      savedSelectedSkillHandles: ["search", "missing-skill"],
      resolvedSkillHandles: ["search"],
      alwaysOnSkillHandles: ["memory"],
      missingSkillHandles: ["missing-skill"],
    });
    expect(dbHelpers.getChannel(customChannel.channelId)?.activeSkillHandlesJson).toBe(JSON.stringify(["search", "missing-skill"]));

    const explicitEmpty = await service.createChannel({
      workspaceId: workspace.workspaceId,
      categoryId: customCategory.categoryId,
      name: "Explicit empty",
      activeSkillSelection: { mode: "custom", savedSelectedSkillHandles: ["memory"] },
    });
    expect(explicitEmpty.activeSkillSelection?.mode).toBe("custom");
    expect(explicitEmpty.activeSkillSelection?.savedSelectedSkillHandles).toEqual([]);
    expect(dbHelpers.getChannel(explicitEmpty.channelId)?.activeSkillHandlesJson).toBe("[]");

    const resetCopy = service.updateChannel(explicitEmpty.channelId, {
      activeSkillSelection: customChannel.activeSkillSelection?.mode === "custom"
        ? { mode: "custom", savedSelectedSkillHandles: customChannel.activeSkillSelection.savedSelectedSkillHandles }
        : { mode: "all" },
    });
    expect(resetCopy.activeSkillSelection?.savedSelectedSkillHandles).toEqual(["search", "missing-skill"]);
  });

  it("preserves explicit empty and missing active selected specialist handles", async () => {
    const { service, workspace } = await createChannelHarness();

    const channel = await service.createChannel({
      workspaceId: workspace.workspaceId,
      name: "Empty globals",
      activeSelectedSpecialistHandles: [],
    });
    expect(channel.activeSelectedSpecialistHandles).toEqual([]);
    expect(channel.missingSelectedSpecialistHandles).toBeUndefined();

    const updated = service.updateChannel(channel.channelId, {
      activeSelectedSpecialistHandles: ["custom-collab", "stale-collab"],
    });
    expect(updated.activeSelectedSpecialistHandles).toEqual(["custom-collab", "stale-collab"]);
    expect(updated.missingSelectedSpecialistHandles).toEqual(["stale-collab"]);
  });

  it("prefers backing descriptor model fields over stale channel DB values", async () => {
    const { dbHelpers, service, workspace, manager } = await createChannelHarness();

    const channel = await service.createChannel({
      workspaceId: workspace.workspaceId,
      name: "Model precedence",
    });

    const descriptor = manager.getAgent(channel.sessionAgentId);
    expect(descriptor).toBeTruthy();
    descriptor!.model = {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh",
    };

    dbHelpers.updateChannel(channel.channelId, {
      modelId: "pi-opus",
      modelThinkingLevel: "low",
      updatedAt: new Date().toISOString(),
    });

    const effective = attachEffectiveChannelModelSettings(manager, service.getChannel(channel.channelId));
    expect(effective.modelId).toBe("pi-5.4");
    expect(effective.reasoningLevel).toBe("xhigh");
  });

  it("persists channel model database fields with retry before surfacing failure", async () => {
    const { dbHelpers, service, workspace } = await createChannelHarness();
    const channel = await service.createChannel({
      workspaceId: workspace.workspaceId,
      name: "Model persist",
    });

    const updateChannel = vi.spyOn(dbHelpers, "updateChannel");
    updateChannel.mockImplementationOnce(() => {
      throw new Error("transient db failure");
    });

    const persisted = service.persistChannelModelDatabaseFields(channel.channelId, {
      modelId: "pi-codex",
      reasoningLevel: "xhigh",
    });

    expect(dbHelpers.getChannel(channel.channelId)?.modelId).toBe("pi-codex");
    expect(dbHelpers.getChannel(channel.channelId)?.modelThinkingLevel).toBe("xhigh");
    expect(persisted.modelId).toBe("pi-5.5");
    expect(updateChannel).toHaveBeenCalledTimes(2);
    updateChannel.mockRestore();
  });
});
