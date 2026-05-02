import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCollaborationAuthMigrations } from "../collaboration/auth/migration-runner.js";
import { createCollaborationDbHelpers } from "../collaboration/collab-db-helpers.js";
import { CollaborationCategoryService } from "../collaboration/category-service.js";
import { DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES } from "../collaboration/specialist-selection.js";
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
  const availableHandles = new Set<string>([...DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES, "custom-collab"]);
  const availableSkillHandles = new Set<string>(["memory", "browser", "search"]);
  const service = new CollaborationCategoryService(dbHelpers, {
    availableGlobalSpecialistHandles: () => availableHandles,
    availableGlobalSkillHandles: () => availableSkillHandles,
  });
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

  return { config: handle.config, dbHelpers, service, workspace, availableHandles, availableSkillHandles };
}

describe("collaboration category service", () => {
  it("persists default selected specialist handles including explicit empty arrays", async () => {
    const { service, workspace } = await createCategoryHarness();

    const defaulted = service.createCategory({
      workspaceId: workspace.workspaceId,
      name: "Defaulted",
    });
    expect(defaulted.defaultSelectedSpecialistHandles).toEqual([...DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES]);
    expect(defaulted.missingDefaultSpecialistHandles).toBeUndefined();

    const empty = service.createCategory({
      workspaceId: workspace.workspaceId,
      name: "Empty",
      defaultSelectedSpecialistHandles: [],
    });
    expect(empty.defaultSelectedSpecialistHandles).toEqual([]);

    const updated = service.updateCategory(defaulted.categoryId, {
      defaultSelectedSpecialistHandles: ["custom-collab", "custom-collab", "Missing Specialist"],
    });
    expect(updated.defaultSelectedSpecialistHandles).toEqual(["custom-collab", "missing-specialist"]);
    expect(updated.missingDefaultSpecialistHandles).toEqual(["missing-specialist"]);
  });

  it("persists skill selection state with null all, custom empty, and preserved missing handles", async () => {
    const { dbHelpers, service, workspace } = await createCategoryHarness();

    const defaulted = service.createCategory({
      workspaceId: workspace.workspaceId,
      name: "Default skills",
    });
    expect(defaulted.defaultSkillSelection).toEqual({
      mode: "all",
      savedSelectedSkillHandles: [],
      resolvedSkillHandles: ["browser", "search"],
      alwaysOnSkillHandles: ["memory"],
    });
    expect(dbHelpers.getCategory(defaulted.categoryId)?.defaultSkillHandlesJson).toBeNull();

    const empty = service.updateCategory(defaulted.categoryId, {
      defaultSkillSelection: { mode: "custom", savedSelectedSkillHandles: [] },
    });
    expect(empty.defaultSkillSelection).toEqual({
      mode: "custom",
      savedSelectedSkillHandles: [],
      resolvedSkillHandles: [],
      alwaysOnSkillHandles: ["memory"],
    });
    expect(dbHelpers.getCategory(defaulted.categoryId)?.defaultSkillHandlesJson).toBe("[]");

    const custom = service.updateCategory(defaulted.categoryId, {
      defaultSkillSelection: { mode: "custom", savedSelectedSkillHandles: ["memory", "Search", "missing-skill", "search"] },
    });
    expect(custom.defaultSkillSelection).toEqual({
      mode: "custom",
      savedSelectedSkillHandles: ["search", "missing-skill"],
      resolvedSkillHandles: ["search"],
      alwaysOnSkillHandles: ["memory"],
      missingSkillHandles: ["missing-skill"],
    });
    expect(dbHelpers.getCategory(defaulted.categoryId)?.defaultSkillHandlesJson).toBe(JSON.stringify(["search", "missing-skill"]));

    const allAgain = service.updateCategory(defaulted.categoryId, {
      defaultSkillSelection: { mode: "all" },
    });
    expect(allAgain.defaultSkillSelection?.mode).toBe("all");
    expect(dbHelpers.getCategory(defaulted.categoryId)?.defaultSkillHandlesJson).toBeNull();
  });

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
