import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { CollaborationChannel } from "@forge/protocol";
import { getSessionContextDir } from "../swarm/data-paths.js";
import {
  inferSwarmModelPresetFromDescriptor,
  resolveModelDescriptorFromPreset,
} from "../swarm/model-presets.js";
import { isCollabSession, slugifySessionName } from "../swarm/swarm-manager-utils.js";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  ManagerProfile,
  SwarmReasoningLevel,
} from "../swarm/types.js";
import type { CollaborationDbHelpers } from "./collab-db-helpers.js";
import {
  createCollaborationChannelSessionAgentId,
  ensureCollaborationChannelWorkingDir,
  getCollaborationChannelWorkingDir,
} from "./channel-cwd.js";
import {
  COLLABORATION_CHANNEL_ARCHETYPE_ID,
  COLLABORATION_PROFILE_ID,
} from "./constants.js";

export interface CollaborationChannelServiceSwarmManager {
  listProfiles?(): ManagerProfile[];
  getAgent(agentId: string): AgentDescriptor | undefined;
  createSessionFromBaseDescriptor?: (
    profileId: string,
    base: {
      model: AgentModelDescriptor;
      cwd: string;
      archetypeId?: AgentDescriptor["archetypeId"];
      sessionSystemPrompt?: string;
    },
    options?: {
      label?: string;
      name?: string;
      sessionAgentId?: string;
      sessionPurpose?: AgentDescriptor["sessionPurpose"];
    },
    overrides?: {
      sessionSurface?: AgentDescriptor["sessionSurface"];
      collab?: AgentDescriptor["collab"];
    },
  ) => Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }>;
  stopSession?: (agentId: string) => Promise<{ terminatedWorkerIds: string[] }>;
  deleteSession?: (agentId: string) => Promise<{ terminatedWorkerIds: string[] }>;
  updateManagerModel?: (
    managerId: string,
    modelPreset: string,
    reasoningLevel?: SwarmReasoningLevel,
  ) => Promise<void>;
}

export interface CreateCollaborationChannelParams {
  workspaceId: string;
  categoryId?: string | null;
  name: string;
  description?: string | null;
  aiEnabled?: boolean;
  position?: number;
  createdByUserId?: string | null;
}

export interface UpdateCollaborationChannelParams {
  categoryId?: string | null;
  name?: string;
  description?: string | null;
  aiEnabled?: boolean;
  modelId?: string;
  position?: number;
}

export interface ListCollaborationChannelsParams {
  workspaceId: string;
  archived?: "unarchived" | "archived" | "all";
}

export interface ReorderCollaborationChannelsParams {
  workspaceId: string;
  channelIds: string[];
}

export class CollaborationChannelServiceError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "invalid_category"
      | "invalid_reorder"
      | "orphaned_workspace"
      | "orphaned_channel"
      | "duplicate_slug"
      | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CollaborationChannelServiceError";
  }
}

export class CollaborationChannelService {
  constructor(
    private readonly dbHelpers: Pick<
      CollaborationDbHelpers,
      | "getWorkspace"
      | "listCategories"
      | "getCategory"
      | "listChannels"
      | "getChannel"
      | "createChannel"
      | "updateChannel"
      | "archiveChannel"
      | "database"
    >,
    private readonly swarmManager: CollaborationChannelServiceSwarmManager | undefined,
    private readonly dataDir: string,
  ) {}

  async createChannel(params: CreateCollaborationChannelParams): Promise<CollaborationChannel> {
    const manager = this.requireRuntimeManager();
    const normalizedWorkspaceId = normalizeRequiredString(params.workspaceId, "workspaceId");
    const workspace = this.requireWorkspace(normalizedWorkspaceId);
    const categoryId = this.normalizeOptionalCategoryId(params.categoryId, normalizedWorkspaceId);
    const category = categoryId ? this.dbHelpers.getCategory(categoryId) : null;
    const name = normalizeRequiredString(params.name, "name");
    const description = normalizeOptionalString(params.description);
    const aiEnabled = params.aiEnabled ?? true;
    const existingChannels = this.dbHelpers.listChannels(normalizedWorkspaceId, { includeArchived: true });
    const slug = buildUniqueSlug(name, existingChannels.map((channel) => channel.slug));
    const position = normalizeOptionalPosition(params.position) ?? nextChannelPosition(existingChannels, categoryId ?? null);
    const channelId = randomUUID();
    const now = new Date().toISOString();
    const sessionAgentId = createCollaborationChannelSessionAgentId();
    const sessionCwd = getCollaborationChannelWorkingDir(this.dataDir, sessionAgentId);
    const defaultModel = resolveChannelModel(category, workspace, normalizedWorkspaceId);
    const defaultModelPreset = inferSwarmModelPresetFromDescriptor(defaultModel);

    let createdSessionAgentId: string | undefined;

    try {
      const createdSession = await manager.createSessionFromBaseDescriptor!(
        COLLABORATION_PROFILE_ID,
        {
          model: defaultModel,
          cwd: sessionCwd,
          archetypeId: COLLABORATION_CHANNEL_ARCHETYPE_ID,
        },
        {
          name,
          label: name,
          sessionAgentId,
        },
        {
          sessionSurface: "collab",
          collab: {
            workspaceId: normalizedWorkspaceId,
            channelId,
          },
        },
      );
      createdSessionAgentId = createdSession.sessionAgent.agentId;

      await ensureCollaborationChannelWorkingDir(this.dataDir, createdSessionAgentId);
      await mkdir(
        getSessionContextDir(this.dataDir, COLLABORATION_PROFILE_ID, createdSessionAgentId),
        { recursive: true },
      );

      const record = this.dbHelpers.createChannel({
        channelId,
        workspaceId: normalizedWorkspaceId,
        categoryId: categoryId ?? null,
        backingSessionAgentId: createdSession.sessionAgent.agentId,
        name,
        slug,
        description,
        aiEnabled,
        modelId: defaultModelPreset ?? null,
        position,
        createdByUserId: normalizeOptionalString(params.createdByUserId) ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return this.toChannelDto(record);
    } catch (error) {
      if (createdSessionAgentId) {
        await this.attemptSessionCleanup(manager, createdSessionAgentId);
      }
      throw mapChannelPersistenceError(error, normalizedWorkspaceId);
    }
  }

  listChannels(params: ListCollaborationChannelsParams): CollaborationChannel[] {
    const normalizedWorkspaceId = normalizeRequiredString(params.workspaceId, "workspaceId");
    this.requireWorkspace(normalizedWorkspaceId);
    const archivedFilter = params.archived ?? "unarchived";
    const categoryOrder = this.buildCategoryOrderMap(normalizedWorkspaceId);

    return this.dbHelpers
      .listChannels(normalizedWorkspaceId, {
        includeArchived: archivedFilter === "all" || archivedFilter === "archived",
      })
      .filter((channel) => {
        if (archivedFilter === "archived") {
          return channel.archived;
        }
        if (archivedFilter === "unarchived") {
          return !channel.archived;
        }
        return true;
      })
      .sort((left, right) => compareChannels(left, right, categoryOrder))
      .map((record) => this.toChannelDto(record));
  }

  getChannel(channelId: string): CollaborationChannel {
    const normalizedChannelId = normalizeRequiredString(channelId, "channelId");
    const record = this.dbHelpers.getChannel(normalizedChannelId);
    if (!record) {
      throw new CollaborationChannelServiceError(
        "not_found",
        `Unknown collaboration channel: ${normalizedChannelId}`,
      );
    }

    return this.toChannelDto(record);
  }

  updateChannel(channelId: string, params: UpdateCollaborationChannelParams): CollaborationChannel {
    const normalizedChannelId = normalizeRequiredString(channelId, "channelId");
    const existing = this.requireChannel(normalizedChannelId);
    const update: UpdateCollaborationChannelParams = {};

    if (params.categoryId !== undefined) {
      update.categoryId = this.normalizeOptionalCategoryId(params.categoryId, existing.workspaceId);
    }

    if (params.name !== undefined) {
      update.name = normalizeRequiredString(params.name, "name");
    }

    if (params.description !== undefined) {
      update.description = normalizeOptionalString(params.description);
    }

    if (params.aiEnabled !== undefined) {
      if (typeof params.aiEnabled !== "boolean") {
        throw new Error("aiEnabled must be a boolean when provided");
      }
      update.aiEnabled = params.aiEnabled;
    }

    if (params.modelId !== undefined) {
      update.modelId = normalizeRequiredString(params.modelId, "modelId");
    }

    if (params.position !== undefined) {
      update.position = normalizeOptionalPosition(params.position);
    }

    const nextSlug =
      update.name !== undefined
        ? buildUniqueSlug(
            update.name,
            this.dbHelpers
              .listChannels(existing.workspaceId, { includeArchived: true })
              .filter((channel) => channel.channelId !== normalizedChannelId)
              .map((channel) => channel.slug),
          )
        : undefined;

    if (
      update.categoryId === undefined &&
      update.name === undefined &&
      update.description === undefined &&
      update.aiEnabled === undefined &&
      update.modelId === undefined &&
      update.position === undefined &&
      nextSlug === undefined
    ) {
      return this.toChannelDto(existing);
    }

    try {
      const updated = this.dbHelpers.updateChannel(normalizedChannelId, {
        ...(update.categoryId !== undefined ? { categoryId: update.categoryId } : {}),
        ...(update.name !== undefined ? { name: update.name } : {}),
        ...(nextSlug !== undefined ? { slug: nextSlug } : {}),
        ...(update.description !== undefined ? { description: update.description } : {}),
        ...(update.aiEnabled !== undefined ? { aiEnabled: update.aiEnabled } : {}),
        ...(update.modelId !== undefined ? { modelId: update.modelId } : {}),
        ...(update.position !== undefined ? { position: update.position } : {}),
        updatedAt: new Date().toISOString(),
      });
      if (!updated) {
        throw new CollaborationChannelServiceError(
          "not_found",
          `Unknown collaboration channel: ${normalizedChannelId}`,
        );
      }
      return this.toChannelDto(updated);
    } catch (error) {
      throw mapChannelPersistenceError(error, existing.workspaceId);
    }
  }

  reorderChannels(params: ReorderCollaborationChannelsParams): CollaborationChannel[] {
    const normalizedWorkspaceId = normalizeRequiredString(params.workspaceId, "workspaceId");
    this.requireWorkspace(normalizedWorkspaceId);

    const existingChannels = this.dbHelpers.listChannels(normalizedWorkspaceId, { includeArchived: false });
    const normalizedChannelIds = params.channelIds.map((channelId) =>
      normalizeRequiredString(channelId, "channelIds[]"),
    );
    const uniqueChannelIds = new Set(normalizedChannelIds);
    const existingChannelIds = new Set(existingChannels.map((channel) => channel.channelId));

    if (
      normalizedChannelIds.length !== existingChannels.length ||
      uniqueChannelIds.size !== existingChannels.length
    ) {
      throw new CollaborationChannelServiceError(
        "invalid_reorder",
        `Channel reorder for workspace ${normalizedWorkspaceId} must include each unarchived channel exactly once`,
      );
    }

    for (const channelId of normalizedChannelIds) {
      if (!existingChannelIds.has(channelId)) {
        throw new CollaborationChannelServiceError(
          "invalid_reorder",
          `Channel ${channelId} does not belong to workspace ${normalizedWorkspaceId}`,
        );
      }
    }

    const now = new Date().toISOString();
    this.dbHelpers.database.transaction(() => {
      normalizedChannelIds.forEach((channelId, index) => {
        this.dbHelpers.updateChannel(channelId, {
          position: index,
          updatedAt: now,
        });
      });
    })();

    return this.listChannels({
      workspaceId: normalizedWorkspaceId,
      archived: "unarchived",
    });
  }

  async archiveChannel(
    channelId: string,
    archivedByUserId: string | null | undefined,
  ): Promise<CollaborationChannel> {
    const manager = this.requireRuntimeManager();
    const existing = this.requireChannel(normalizeRequiredString(channelId, "channelId"));

    await manager.stopSession!(existing.backingSessionAgentId);

    const archived = this.dbHelpers.archiveChannel(existing.channelId, {
      archivedAt: new Date().toISOString(),
      archivedByUserId: normalizeOptionalString(archivedByUserId) ?? null,
      updatedAt: new Date().toISOString(),
    });

    if (!archived) {
      throw new CollaborationChannelServiceError(
        "not_found",
        `Unknown collaboration channel: ${existing.channelId}`,
      );
    }

    return this.toChannelDto(archived);
  }

  private toChannelDto(record: {
    channelId: string;
    workspaceId: string;
    categoryId: string | null;
    backingSessionAgentId: string;
    name: string;
    slug: string;
    description: string | null;
    aiEnabled: boolean;
    modelId: string | null;
    position: number;
    archived: boolean;
    archivedAt: string | null;
    archivedByUserId: string | null;
    createdByUserId: string | null;
    lastMessageSeq: number;
    lastMessageId: string | null;
    lastMessageAt: string | null;
    createdAt: string;
    updatedAt: string;
  }): CollaborationChannel {
    this.assertBackingSession(record);

    return {
      channelId: record.channelId,
      workspaceId: record.workspaceId,
      ...(record.categoryId ? { categoryId: record.categoryId } : {}),
      sessionAgentId: record.backingSessionAgentId,
      name: record.name,
      slug: record.slug,
      ...(record.description ? { description: record.description } : {}),
      aiEnabled: record.aiEnabled,
      ...(record.modelId ? { modelId: record.modelId } : {}),
      position: record.position,
      archived: record.archived,
      ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
      ...(record.archivedByUserId ? { archivedByUserId: record.archivedByUserId } : {}),
      ...(record.createdByUserId ? { createdByUserId: record.createdByUserId } : {}),
      lastMessageSeq: record.lastMessageSeq,
      ...(record.lastMessageId ? { lastMessageId: record.lastMessageId } : {}),
      ...(record.lastMessageAt ? { lastMessageAt: record.lastMessageAt } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private buildCategoryOrderMap(workspaceId: string): Map<string, number> {
    return new Map(
      this.dbHelpers
        .listCategories(workspaceId)
        .map((category, index) => [category.categoryId, index] as const),
    );
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.dbHelpers.getWorkspace(workspaceId);
    if (workspace) {
      return workspace;
    }

    throw new CollaborationChannelServiceError(
      "not_found",
      `Unknown collaboration workspace: ${workspaceId}`,
    );
  }

  private requireChannel(channelId: string) {
    const channel = this.dbHelpers.getChannel(channelId);
    if (channel) {
      return channel;
    }

    throw new CollaborationChannelServiceError(
      "not_found",
      `Unknown collaboration channel: ${channelId}`,
    );
  }

  private normalizeOptionalCategoryId(
    value: string | null | undefined,
    workspaceId: string,
  ): string | null | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return null;
    }

    const categoryId = normalizeRequiredString(value, "categoryId");
    const category = this.dbHelpers.getCategory(categoryId);
    if (!category || category.workspaceId !== workspaceId) {
      throw new CollaborationChannelServiceError(
        "invalid_category",
        `Category ${categoryId} does not belong to workspace ${workspaceId}`,
      );
    }

    return categoryId;
  }

  private assertBackingSession(record: {
    channelId: string;
    workspaceId: string;
    backingSessionAgentId: string;
  }): void {
    if (!this.swarmManager) {
      throw new CollaborationChannelServiceError(
        "unavailable",
        "Collaboration channel service requires a swarm manager dependency",
      );
    }

    const descriptor = this.swarmManager.getAgent(record.backingSessionAgentId);
    if (!descriptor || descriptor.role !== "manager" || !descriptor.profileId) {
      throw new CollaborationChannelServiceError(
        "orphaned_channel",
        `Collaboration channel ${record.channelId} references missing backing session ${record.backingSessionAgentId}`,
      );
    }

    if (!isCollabSession(descriptor)) {
      throw new CollaborationChannelServiceError(
        "orphaned_channel",
        `Collaboration channel ${record.channelId} is backed by non-collaboration session ${record.backingSessionAgentId}`,
      );
    }

    if (descriptor.profileId !== COLLABORATION_PROFILE_ID) {
      throw new CollaborationChannelServiceError(
        "orphaned_channel",
        `Collaboration channel ${record.channelId} is backed by session ${record.backingSessionAgentId} outside ${COLLABORATION_PROFILE_ID}`,
      );
    }

    if (
      descriptor.collab?.workspaceId !== record.workspaceId ||
      descriptor.collab?.channelId !== record.channelId
    ) {
      throw new CollaborationChannelServiceError(
        "orphaned_channel",
        `Collaboration channel ${record.channelId} is linked to mismatched backing session ${record.backingSessionAgentId}`,
      );
    }
  }

  private requireRuntimeManager(): Required<
    Pick<CollaborationChannelServiceSwarmManager, "createSessionFromBaseDescriptor" | "stopSession">
  > &
    CollaborationChannelServiceSwarmManager {
    if (this.swarmManager?.createSessionFromBaseDescriptor && this.swarmManager.stopSession) {
      return this.swarmManager as Required<
        Pick<CollaborationChannelServiceSwarmManager, "createSessionFromBaseDescriptor" | "stopSession">
      > & CollaborationChannelServiceSwarmManager;
    }

    throw new CollaborationChannelServiceError(
      "unavailable",
      "Collaboration channel service requires a swarm manager with collaboration session lifecycle support",
    );
  }

  private async attemptSessionCleanup(
    manager: CollaborationChannelServiceSwarmManager,
    sessionAgentId: string,
  ): Promise<void> {
    try {
      await manager.deleteSession?.(sessionAgentId);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function resolveChannelModel(
  category: {
    defaultModelProvider: string | null;
    defaultModelId: string | null;
    defaultModelThinkingLevel: string | null;
  } | null,
  workspace: {
    defaultModelProvider: string | null;
    defaultModelId: string | null;
    defaultModelThinkingLevel: string | null;
  },
  workspaceId: string,
): AgentModelDescriptor {
  if (category?.defaultModelProvider && category.defaultModelId && category.defaultModelThinkingLevel) {
    return {
      provider: category.defaultModelProvider,
      modelId: category.defaultModelId,
      thinkingLevel: category.defaultModelThinkingLevel,
    };
  }

  if (category?.defaultModelId) {
    return resolveModelDescriptorFromPreset(category.defaultModelId);
  }

  if (workspace.defaultModelProvider && workspace.defaultModelId && workspace.defaultModelThinkingLevel) {
    return {
      provider: workspace.defaultModelProvider,
      modelId: workspace.defaultModelId,
      thinkingLevel: workspace.defaultModelThinkingLevel,
    };
  }

  throw new CollaborationChannelServiceError(
    "orphaned_workspace",
    `Collaboration workspace ${workspaceId} is missing default model configuration`,
  );
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Missing collaboration channel ${fieldName}`);
  }

  return normalized;
}

function normalizeOptionalString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
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

function buildUniqueSlug(name: string, existingSlugs: string[]): string {
  const baseSlug = slugifySessionName(name) || "channel";
  const existing = new Set(existingSlugs.map((slug) => slug.trim().toLowerCase()));

  let candidate = baseSlug;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function nextChannelPosition(
  channels: Array<{ categoryId: string | null; position: number }>,
  categoryId: string | null,
): number {
  const highestPosition = channels
    .filter((channel) => (channel.categoryId ?? null) === categoryId)
    .reduce((max, channel) => Math.max(max, channel.position), -1);
  return highestPosition + 1;
}

function compareChannels(
  left: { archived: boolean; categoryId: string | null; position: number; name: string; channelId: string },
  right: { archived: boolean; categoryId: string | null; position: number; name: string; channelId: string },
  categoryOrder: Map<string, number>,
): number {
  if (left.archived !== right.archived) {
    return left.archived ? 1 : -1;
  }

  const leftCategoryRank = left.categoryId ? categoryOrder.get(left.categoryId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  const rightCategoryRank = right.categoryId ? categoryOrder.get(right.categoryId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  if (leftCategoryRank !== rightCategoryRank) {
    return leftCategoryRank - rightCategoryRank;
  }

  if (left.position !== right.position) {
    return left.position - right.position;
  }

  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) {
    return byName;
  }

  return left.channelId.localeCompare(right.channelId);
}

function mapChannelPersistenceError(error: unknown, workspaceId: string): Error {
  if (error instanceof CollaborationChannelServiceError) {
    return error;
  }

  if (isUniqueConstraintError(error)) {
    return new CollaborationChannelServiceError(
      "duplicate_slug",
      `A collaboration channel with that slug already exists in workspace ${workspaceId}`,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("unique constraint");
}
