import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCollaborationAuthMigrations } from "../collaboration/auth/migration-runner.js";
import { createCollaborationDbHelpers } from "../collaboration/collab-db-helpers.js";
import { CollaborationCategoryService } from "../collaboration/category-service.js";
import { COLLABORATION_PROFILE_ID } from "../collaboration/constants.js";
import { resolveModelDescriptorFromPreset } from "../swarm/model-presets.js";
import { createTempConfig } from "../test-support/temp-config.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function createCategoryHarness() {
  const handle = await createTempConfig({
    runtimeTarget: "collaboration-server",
    tempRootDir: await mkdtemp(join(tmpdir(), "forge-collaboration-category-service-")),
  });
  tempRoots.push(handle.tempRootDir);
  await runCollaborationAuthMigrations(handle.config);
  const dbHelpers = await createCollaborationDbHelpers(handle.config);
  const service = new CollaborationCategoryService(dbHelpers);
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

  return { config: handle.config, dbHelpers, service, workspace };
}

describe("collaboration category service", () => {
  it("persists reasoning defaults and preserves them across same-model updates", async () => {
    const { service, workspace } = await createCategoryHarness();

    const created = service.createCategory({
      workspaceId: workspace.workspaceId,
      name: "Planning",
      defaultModelId: "pi-opus",
      defaultReasoningLevel: "low",
    });

    expect(created.defaultModelId).toBe("pi-opus");
    expect(created.defaultReasoningLevel).toBe("low");
    expect(created.channelCreationDefaults?.model.thinkingLevel).toBe("low");

    const reasoningOnlyUpdated = service.updateCategory(created.categoryId, {
      defaultReasoningLevel: "high",
    });
    expect(reasoningOnlyUpdated.defaultModelId).toBe("pi-opus");
    expect(reasoningOnlyUpdated.defaultReasoningLevel).toBe("high");
    expect(reasoningOnlyUpdated.channelCreationDefaults?.model.thinkingLevel).toBe("high");

    const sameModelUpdated = service.updateCategory(created.categoryId, {
      defaultModelId: "pi-opus",
    });
    expect(sameModelUpdated.defaultReasoningLevel).toBe("high");
    expect(sameModelUpdated.channelCreationDefaults?.model.thinkingLevel).toBe("high");
  });

  it("falls back to catalog defaults when resetting or changing the category model", async () => {
    const { service, workspace } = await createCategoryHarness();

    const created = service.createCategory({
      workspaceId: workspace.workspaceId,
      name: "Execution",
      defaultModelId: "pi-opus",
      defaultReasoningLevel: "low",
    });

    const opusDefaultReasoning = resolveModelDescriptorFromPreset("pi-opus").thinkingLevel;
    const resetReasoning = service.updateCategory(created.categoryId, {
      defaultReasoningLevel: null,
    });
    expect(resetReasoning.defaultModelId).toBe("pi-opus");
    expect(resetReasoning.defaultReasoningLevel).toBe(opusDefaultReasoning);

    const codexDefaultReasoning = resolveModelDescriptorFromPreset("pi-codex").thinkingLevel;
    const changedModel = service.updateCategory(created.categoryId, {
      defaultModelId: "pi-codex",
    });
    expect(changedModel.defaultModelId).toBe("pi-codex");
    expect(changedModel.defaultReasoningLevel).toBe(codexDefaultReasoning);
    expect(changedModel.channelCreationDefaults?.model.thinkingLevel).toBe(codexDefaultReasoning);
  });
});
