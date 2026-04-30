import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCollaborationAuthMigrations } from "../collaboration/auth/migration-runner.js";
import { CollaborationChannelService, type CollaborationChannelServiceSwarmManager } from "../collaboration/channel-service.js";
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
  const service = new CollaborationChannelService(dbHelpers, manager, handle.config.paths.dataDir, {
    availableGlobalSpecialistHandles: () => availableHandles,
  });

  return { config: handle.config, dbHelpers, service, workspace, availableHandles };
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
});
