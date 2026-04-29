import { randomUUID } from "node:crypto";
import type { CollaborationCategory } from "@forge/protocol";
import { inferSwarmModelPresetFromDescriptor, resolveModelDescriptorFromPreset } from "../swarm/model-presets.js";
import type { AgentModelDescriptor, SwarmReasoningLevel } from "../swarm/types.js";
import type { CollaborationDbHelpers } from "./collab-db-helpers.js";

export interface CreateCollaborationCategoryParams {
  workspaceId: string;
  name: string;
  channelCreationDefaults?: {
    model: AgentModelDescriptor;
    cwd?: string;
  } | null;
  defaultModelId?: string | null;
  defaultReasoningLevel?: SwarmReasoningLevel | null;
  position?: number;
}

export interface UpdateCollaborationCategoryParams {
  name?: string;
  channelCreationDefaults?: {
    model: AgentModelDescriptor;
    cwd?: string;
  } | null;
  defaultModelId?: string | null;
  defaultReasoningLevel?: SwarmReasoningLevel | null;
}

export interface ReorderCollaborationCategoriesParams {
  workspaceId: string;
  categoryIds: string[];
}

export class CollaborationCategoryServiceError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "duplicate_name"
      | "invalid_category"
      | "invalid_reorder",
    message: string,
  ) {
    super(message);
    this.name = "CollaborationCategoryServiceError";
  }
}

export class CollaborationCategoryService {
  constructor(
    private readonly dbHelpers: Pick<
      CollaborationDbHelpers,
      | "database"
      | "getWorkspace"
      | "listCategories"
      | "getCategory"
      | "createCategory"
      | "updateCategory"
      | "deleteCategory"
    >,
  ) {}

  listCategories(workspaceId: string): CollaborationCategory[] {
    const normalizedWorkspaceId = normalizeRequiredString(workspaceId, "workspaceId");
    this.requireWorkspace(normalizedWorkspaceId);
    return this.dbHelpers.listCategories(normalizedWorkspaceId).map(toCategoryDto);
  }

  createCategory(params: CreateCollaborationCategoryParams): CollaborationCategory {
    const normalizedWorkspaceId = normalizeRequiredString(params.workspaceId, "workspaceId");
    this.requireWorkspace(normalizedWorkspaceId);
    const categories = this.dbHelpers.listCategories(normalizedWorkspaceId);
    const now = new Date().toISOString();
    const defaults = resolveCreateCategoryDefaults(params);

    try {
      return toCategoryDto(
        this.dbHelpers.createCategory({
          categoryId: randomUUID(),
          workspaceId: normalizedWorkspaceId,
          name: normalizeRequiredString(params.name, "name"),
          defaultModelProvider: defaults?.model.provider ?? null,
          defaultModelId: defaults?.model.modelId ?? null,
          defaultModelThinkingLevel: defaults?.model.thinkingLevel ?? null,
          defaultCwd: defaults?.cwd ?? null,
          position: normalizeOptionalPosition(params.position) ?? nextCategoryPosition(categories),
          createdAt: now,
          updatedAt: now,
        }),
      );
    } catch (error) {
      throw mapCategoryPersistenceError(error, normalizedWorkspaceId);
    }
  }

  updateCategory(categoryId: string, params: UpdateCollaborationCategoryParams): CollaborationCategory {
    const normalizedCategoryId = normalizeRequiredString(categoryId, "categoryId");
    const existing = this.requireCategory(normalizedCategoryId);
    const update: {
      name?: string;
      defaultModelProvider?: string | null;
      defaultModelId?: string | null;
      defaultModelThinkingLevel?: string | null;
      defaultCwd?: string | null;
    } = {};

    if (params.name !== undefined) {
      update.name = normalizeRequiredString(params.name, "name");
    }

    if (hasCategoryDefaultsUpdate(params)) {
      const defaults = resolveUpdatedCategoryDefaults(existing, params);
      update.defaultModelProvider = defaults?.model.provider ?? null;
      update.defaultModelId = defaults?.model.modelId ?? null;
      update.defaultModelThinkingLevel = defaults?.model.thinkingLevel ?? null;
      update.defaultCwd = defaults?.cwd ?? null;
    }

    if (
      update.name === undefined &&
      update.defaultModelProvider === undefined &&
      update.defaultModelId === undefined &&
      update.defaultModelThinkingLevel === undefined &&
      update.defaultCwd === undefined
    ) {
      return toCategoryDto(existing);
    }

    try {
      const updated = this.dbHelpers.updateCategory(normalizedCategoryId, {
        ...update,
        updatedAt: new Date().toISOString(),
      });
      if (!updated) {
        throw new CollaborationCategoryServiceError(
          "not_found",
          `Unknown collaboration category: ${normalizedCategoryId}`,
        );
      }
      return toCategoryDto(updated);
    } catch (error) {
      throw mapCategoryPersistenceError(error, existing.workspaceId);
    }
  }

  deleteCategory(categoryId: string): void {
    const normalizedCategoryId = normalizeRequiredString(categoryId, "categoryId");
    this.requireCategory(normalizedCategoryId);

    if (!this.dbHelpers.deleteCategory(normalizedCategoryId)) {
      throw new CollaborationCategoryServiceError(
        "not_found",
        `Unknown collaboration category: ${normalizedCategoryId}`,
      );
    }
  }

  reorderCategories(params: ReorderCollaborationCategoriesParams): CollaborationCategory[] {
    const normalizedWorkspaceId = normalizeRequiredString(params.workspaceId, "workspaceId");
    this.requireWorkspace(normalizedWorkspaceId);

    const existingCategories = this.dbHelpers.listCategories(normalizedWorkspaceId);
    const normalizedCategoryIds = params.categoryIds.map((categoryId) =>
      normalizeRequiredString(categoryId, "categoryIds[]"),
    );

    const uniqueCategoryIds = new Set(normalizedCategoryIds);
    const existingCategoryIds = new Set(existingCategories.map((category) => category.categoryId));

    if (
      normalizedCategoryIds.length !== existingCategories.length ||
      uniqueCategoryIds.size !== existingCategories.length
    ) {
      throw new CollaborationCategoryServiceError(
        "invalid_reorder",
        `Category reorder for workspace ${normalizedWorkspaceId} must include each category exactly once`,
      );
    }

    for (const categoryId of normalizedCategoryIds) {
      if (!existingCategoryIds.has(categoryId)) {
        throw new CollaborationCategoryServiceError(
          "invalid_category",
          `Category ${categoryId} does not belong to workspace ${normalizedWorkspaceId}`,
        );
      }
    }

    const now = new Date().toISOString();
    this.dbHelpers.database.transaction(() => {
      normalizedCategoryIds.forEach((categoryId, index) => {
        this.dbHelpers.updateCategory(categoryId, {
          position: index,
          updatedAt: now,
        });
      });
    })();

    return this.dbHelpers.listCategories(normalizedWorkspaceId).map(toCategoryDto);
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.dbHelpers.getWorkspace(workspaceId);
    if (workspace) {
      return workspace;
    }

    throw new CollaborationCategoryServiceError(
      "not_found",
      `Unknown collaboration workspace: ${workspaceId}`,
    );
  }

  private requireCategory(categoryId: string) {
    const category = this.dbHelpers.getCategory(categoryId);
    if (category) {
      return category;
    }

    throw new CollaborationCategoryServiceError(
      "not_found",
      `Unknown collaboration category: ${categoryId}`,
    );
  }
}

function toCategoryDto(record: {
  categoryId: string;
  workspaceId: string;
  name: string;
  defaultModelProvider: string | null;
  defaultModelId: string | null;
  defaultModelThinkingLevel: string | null;
  defaultCwd: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}): CollaborationCategory {
  const model = toCategoryModelDescriptor(record);
  const defaultModelId = model ? inferSwarmModelPresetFromDescriptor(model) : undefined;

  return {
    categoryId: record.categoryId,
    workspaceId: record.workspaceId,
    name: record.name,
    ...(model
      ? {
          channelCreationDefaults: {
            model,
            ...(record.defaultCwd ? { cwd: record.defaultCwd } : {}),
          },
        }
      : {}),
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(model ? { defaultReasoningLevel: normalizeReasoningLevel(model.thinkingLevel) } : {}),
    position: record.position,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toCategoryModelDescriptor(record: {
  defaultModelProvider: string | null;
  defaultModelId: string | null;
  defaultModelThinkingLevel: string | null;
}): AgentModelDescriptor | null {
  if (record.defaultModelProvider && record.defaultModelId && record.defaultModelThinkingLevel) {
    return {
      provider: record.defaultModelProvider,
      modelId: record.defaultModelId,
      thinkingLevel: record.defaultModelThinkingLevel,
    };
  }

  return null;
}

function hasCategoryDefaultsUpdate(
  params: Pick<CreateCollaborationCategoryParams | UpdateCollaborationCategoryParams, "channelCreationDefaults" | "defaultModelId" | "defaultReasoningLevel">,
): boolean {
  return (
    params.channelCreationDefaults !== undefined ||
    params.defaultModelId !== undefined ||
    params.defaultReasoningLevel !== undefined
  );
}

function resolveCreateCategoryDefaults(
  params: Pick<CreateCollaborationCategoryParams, "channelCreationDefaults" | "defaultModelId" | "defaultReasoningLevel">,
): { model: AgentModelDescriptor; cwd?: string } | null {
  return resolveCategoryDefaultsInput(params);
}

function resolveUpdatedCategoryDefaults(
  existing: {
    defaultModelProvider: string | null;
    defaultModelId: string | null;
    defaultModelThinkingLevel: string | null;
    defaultCwd: string | null;
  },
  params: Pick<UpdateCollaborationCategoryParams, "channelCreationDefaults" | "defaultModelId" | "defaultReasoningLevel">,
): { model: AgentModelDescriptor; cwd?: string } | null {
  if (params.channelCreationDefaults !== undefined) {
    return resolveCategoryDefaultsInput(params);
  }

  if (params.defaultModelId === null) {
    return null;
  }

  const currentModel = toCategoryModelDescriptor(existing);
  const currentModelPreset = currentModel ? inferSwarmModelPresetFromDescriptor(currentModel) : undefined;
  const requestedModelDescriptor =
    params.defaultModelId !== undefined ? resolveModelDescriptorFromPreset(params.defaultModelId) : undefined;
  const descriptor = requestedModelDescriptor ?? currentModel;
  if (!descriptor) {
    if (params.defaultReasoningLevel !== undefined) {
      throw new Error("defaultReasoningLevel requires a category default model");
    }
    return null;
  }

  const preservedReasoningLevel =
    params.defaultModelId === undefined || params.defaultModelId === currentModelPreset
      ? normalizeReasoningLevel(existing.defaultModelThinkingLevel)
      : undefined;
  const defaultReasoningLevel = normalizeReasoningLevel(
    requestedModelDescriptor?.thinkingLevel ??
      (currentModelPreset ? resolveModelDescriptorFromPreset(currentModelPreset).thinkingLevel : descriptor.thinkingLevel),
  ) ?? descriptor.thinkingLevel;
  const reasoningLevel =
    params.defaultReasoningLevel === undefined
      ? preservedReasoningLevel ?? defaultReasoningLevel
      : params.defaultReasoningLevel === null
        ? defaultReasoningLevel
        : params.defaultReasoningLevel;
  const cwd = normalizeOptionalString(existing.defaultCwd ?? undefined);

  return {
    model: {
      ...descriptor,
      thinkingLevel: reasoningLevel,
    },
    ...(cwd ? { cwd } : {}),
  };
}

function resolveCategoryDefaultsInput(
  params: Pick<CreateCollaborationCategoryParams | UpdateCollaborationCategoryParams, "channelCreationDefaults" | "defaultModelId" | "defaultReasoningLevel">,
): { model: AgentModelDescriptor; cwd?: string } | null {
  if (params.channelCreationDefaults !== undefined) {
    if (params.channelCreationDefaults === null) {
      return null;
    }

    const defaults = params.channelCreationDefaults;
    const model = defaults?.model;
    if (!model || !isNonEmptyString(model.provider) || !isNonEmptyString(model.modelId) || !isNonEmptyString(model.thinkingLevel)) {
      throw new Error("channelCreationDefaults.model must include provider, modelId, and thinkingLevel");
    }

    const cwd = normalizeOptionalString(defaults.cwd);
    return {
      model: {
        provider: model.provider.trim(),
        modelId: model.modelId.trim(),
        thinkingLevel: model.thinkingLevel.trim(),
      },
      ...(cwd ? { cwd } : {}),
    };
  }

  if (params.defaultModelId === undefined || params.defaultModelId === null) {
    return null;
  }

  const descriptor = resolveModelDescriptorFromPreset(params.defaultModelId);
  return {
    model: {
      ...descriptor,
      thinkingLevel: params.defaultReasoningLevel ?? descriptor.thinkingLevel,
    },
  };
}

function nextCategoryPosition(categories: Array<{ position: number }>): number {
  const highestPosition = categories.reduce((max, category) => Math.max(max, category.position), -1);
  return highestPosition + 1;
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Missing collaboration category ${fieldName}`);
  }

  return normalized;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeOptionalPosition(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error("position must be a non-negative integer when provided");
  }

  return value;
}

function mapCategoryPersistenceError(error: unknown, workspaceId: string): Error {
  if (error instanceof CollaborationCategoryServiceError) {
    return error;
  }

  if (isUniqueConstraintError(error)) {
    return new CollaborationCategoryServiceError(
      "duplicate_name",
      `A collaboration category with that name already exists in workspace ${workspaceId}`,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("unique constraint");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeReasoningLevel(value: string | null | undefined): SwarmReasoningLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "none":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return normalized;
    case "x-high":
      return "xhigh";
    default:
      return undefined;
  }
}
