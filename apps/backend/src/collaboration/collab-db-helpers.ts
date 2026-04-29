import type Database from "better-sqlite3";
import type { SwarmConfig } from "../swarm/types.js";
import { getOrCreateCollaborationAuthDb } from "./auth/collaboration-db.js";

interface CollaborationWorkspaceRow {
  workspace_id: string;
  backing_profile_id: string;
  display_name: string;
  description: string | null;
  ai_display_name: string | null;
  created_by_user_id: string | null;
  default_model_provider: string;
  default_model_id: string;
  default_model_thinking_level: string;
  default_cwd: string;
  created_at: string;
  updated_at: string;
}

interface CollaborationCategoryRow {
  category_id: string;
  workspace_id: string;
  name: string;
  default_model_provider: string | null;
  default_model_id: string | null;
  default_model_thinking_level: string | null;
  default_cwd: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

interface CollaborationChannelRow {
  channel_id: string;
  workspace_id: string;
  category_id: string | null;
  backing_session_agent_id: string;
  name: string;
  slug: string;
  description: string | null;
  ai_enabled: number;
  model_id: string | null;
  model_thinking_level: string | null;
  position: number;
  archived: number;
  archived_at: string | null;
  archived_by_user_id: string | null;
  created_by_user_id: string | null;
  last_message_seq: number;
  last_message_id: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CollaborationChannelUserStateRow {
  channel_id: string;
  user_id: string;
  last_read_message_id: string | null;
  last_read_message_seq: number;
  last_read_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CollaborationWorkspaceDefaultsRecord {
  defaultModelProvider: string | null;
  defaultModelId: string | null;
  defaultModelThinkingLevel: string | null;
  defaultCwd: string | null;
}

export interface CollaborationWorkspaceRecord extends CollaborationWorkspaceDefaultsRecord {
  workspaceId: string;
  backingProfileId: string;
  displayName: string;
  description: string | null;
  aiDisplayName: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationCategoryRecord extends CollaborationWorkspaceDefaultsRecord {
  categoryId: string;
  workspaceId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationChannelRecord {
  channelId: string;
  workspaceId: string;
  categoryId: string | null;
  backingSessionAgentId: string;
  name: string;
  slug: string;
  description: string | null;
  aiEnabled: boolean;
  modelId: string | null;
  modelThinkingLevel: string | null;
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
}

export interface CollaborationChannelUserStateRecord {
  channelId: string;
  userId: string;
  lastReadMessageId: string | null;
  lastReadMessageSeq: number;
  lastReadAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCollaborationWorkspaceInput extends CollaborationWorkspaceDefaultsRecord {
  workspaceId: string;
  backingProfileId: string;
  displayName: string;
  description?: string | null;
  aiDisplayName?: string | null;
  createdByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateCollaborationWorkspaceDefaultsInput extends CollaborationWorkspaceDefaultsRecord {
  updatedAt: string;
}

export interface CreateCollaborationCategoryInput extends CollaborationWorkspaceDefaultsRecord {
  categoryId: string;
  workspaceId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateCollaborationCategoryInput extends Partial<CollaborationWorkspaceDefaultsRecord> {
  name?: string;
  position?: number;
  updatedAt: string;
}

export interface CreateCollaborationChannelInput {
  channelId: string;
  workspaceId: string;
  categoryId: string | null;
  backingSessionAgentId: string;
  name: string;
  slug: string;
  description?: string | null;
  aiEnabled: boolean;
  modelId?: string | null;
  modelThinkingLevel?: string | null;
  position: number;
  archived?: boolean;
  archivedAt?: string | null;
  archivedByUserId?: string | null;
  createdByUserId?: string | null;
  lastMessageSeq?: number;
  lastMessageId?: string | null;
  lastMessageAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateCollaborationChannelInput {
  categoryId?: string | null;
  name?: string;
  slug?: string;
  description?: string | null;
  aiEnabled?: boolean;
  modelId?: string | null;
  modelThinkingLevel?: string | null;
  position?: number;
  archived?: boolean;
  archivedAt?: string | null;
  archivedByUserId?: string | null;
  lastMessageSeq?: number;
  lastMessageId?: string | null;
  lastMessageAt?: string | null;
  updatedAt: string;
}

export interface ArchiveCollaborationChannelInput {
  archivedAt: string;
  archivedByUserId: string | null;
  updatedAt: string;
}

export interface AdvanceCollaborationChannelActivityInput {
  lastMessageId?: string | null;
  lastMessageAt: string;
  updatedAt: string;
}

export interface UpsertCollaborationChannelReadStateInput {
  channelId: string;
  userId: string;
  lastReadMessageId?: string | null;
  lastReadMessageSeq: number;
  lastReadAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CollaborationDbHelpers {
  constructor(readonly database: Database.Database) {}

  runInTransaction<T>(callback: () => T): T {
    return this.database.transaction(callback)();
  }

  listWorkspaces(): CollaborationWorkspaceRecord[] {
    return this.database
      .prepare<[], CollaborationWorkspaceRow>(`${workspaceSelectSql} ORDER BY created_at ASC, workspace_id ASC`)
      .all()
      .map(mapWorkspaceRow);
  }

  getWorkspace(workspaceId: string): CollaborationWorkspaceRecord | null {
    const row = this.database
      .prepare<[string], CollaborationWorkspaceRow>(`${workspaceSelectSql} WHERE workspace_id = ?`)
      .get(workspaceId);
    return row ? mapWorkspaceRow(row) : null;
  }

  getWorkspaceByBackingProfileId(backingProfileId: string): CollaborationWorkspaceRecord | null {
    const row = this.database
      .prepare<[string], CollaborationWorkspaceRow>(`${workspaceSelectSql} WHERE backing_profile_id = ?`)
      .get(backingProfileId);
    return row ? mapWorkspaceRow(row) : null;
  }

  createWorkspace(input: CreateCollaborationWorkspaceInput): CollaborationWorkspaceRecord {
    this.database.prepare(
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
      input.workspaceId,
      input.backingProfileId,
      input.displayName,
      input.description ?? null,
      input.aiDisplayName ?? null,
      input.createdByUserId ?? null,
      requiredDefault(input.defaultModelProvider, "defaultModelProvider"),
      requiredDefault(input.defaultModelId, "defaultModelId"),
      requiredDefault(input.defaultModelThinkingLevel, "defaultModelThinkingLevel"),
      requiredDefault(input.defaultCwd, "defaultCwd"),
      input.createdAt,
      input.updatedAt,
    );

    return requireWorkspace(this.getWorkspace(input.workspaceId), input.workspaceId);
  }

  updateWorkspaceDefaults(
    workspaceId: string,
    input: UpdateCollaborationWorkspaceDefaultsInput,
  ): CollaborationWorkspaceRecord | null {
    this.database.prepare(
      `UPDATE collab_workspace
       SET default_model_provider = ?,
           default_model_id = ?,
           default_model_thinking_level = ?,
           default_cwd = ?,
           updated_at = ?
       WHERE workspace_id = ?`,
    ).run(
      requiredDefault(input.defaultModelProvider, "defaultModelProvider"),
      requiredDefault(input.defaultModelId, "defaultModelId"),
      requiredDefault(input.defaultModelThinkingLevel, "defaultModelThinkingLevel"),
      requiredDefault(input.defaultCwd, "defaultCwd"),
      input.updatedAt,
      workspaceId,
    );

    return this.getWorkspace(workspaceId);
  }

  listCategories(workspaceId: string): CollaborationCategoryRecord[] {
    return this.database
      .prepare<[string], CollaborationCategoryRow>(`${categorySelectSql} WHERE workspace_id = ? ORDER BY position ASC, category_id ASC`)
      .all(workspaceId)
      .map(mapCategoryRow);
  }

  getCategory(categoryId: string): CollaborationCategoryRecord | null {
    const row = this.database
      .prepare<[string], CollaborationCategoryRow>(`${categorySelectSql} WHERE category_id = ?`)
      .get(categoryId);
    return row ? mapCategoryRow(row) : null;
  }

  createCategory(input: CreateCollaborationCategoryInput): CollaborationCategoryRecord {
    this.database.prepare(
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
      input.categoryId,
      input.workspaceId,
      input.name,
      normalizeNullableString(input.defaultModelProvider),
      normalizeNullableString(input.defaultModelId),
      normalizeNullableString(input.defaultModelThinkingLevel),
      normalizeNullableString(input.defaultCwd),
      input.position,
      input.createdAt,
      input.updatedAt,
    );

    return requireCategory(this.getCategory(input.categoryId), input.categoryId);
  }

  updateCategory(categoryId: string, input: UpdateCollaborationCategoryInput): CollaborationCategoryRecord | null {
    const existing = this.getCategory(categoryId);
    if (!existing) {
      return null;
    }

    this.database.prepare(
      `UPDATE collab_category
       SET name = ?,
           default_model_provider = ?,
           default_model_id = ?,
           default_model_thinking_level = ?,
           default_cwd = ?,
           position = ?,
           updated_at = ?
       WHERE category_id = ?`,
    ).run(
      input.name ?? existing.name,
      input.defaultModelProvider !== undefined
        ? normalizeNullableString(input.defaultModelProvider)
        : normalizeNullableString(existing.defaultModelProvider),
      input.defaultModelId !== undefined
        ? normalizeNullableString(input.defaultModelId)
        : normalizeNullableString(existing.defaultModelId),
      input.defaultModelThinkingLevel !== undefined
        ? normalizeNullableString(input.defaultModelThinkingLevel)
        : normalizeNullableString(existing.defaultModelThinkingLevel),
      input.defaultCwd !== undefined
        ? normalizeNullableString(input.defaultCwd)
        : normalizeNullableString(existing.defaultCwd),
      input.position ?? existing.position,
      input.updatedAt,
      categoryId,
    );

    return this.getCategory(categoryId);
  }

  deleteCategory(categoryId: string): boolean {
    const result = this.database.prepare(`DELETE FROM collab_category WHERE category_id = ?`).run(categoryId);
    return result.changes > 0;
  }

  listChannels(
    workspaceId: string,
    options?: { includeArchived?: boolean },
  ): CollaborationChannelRecord[] {
    const includeArchived = options?.includeArchived ?? false;
    const rows = includeArchived
      ? this.database
          .prepare<[string], CollaborationChannelRow>(`${channelSelectSql} WHERE workspace_id = ? ORDER BY position ASC, channel_id ASC`)
          .all(workspaceId)
      : this.database
          .prepare<[string], CollaborationChannelRow>(`${channelSelectSql} WHERE workspace_id = ? AND archived = 0 ORDER BY position ASC, channel_id ASC`)
          .all(workspaceId);
    return rows.map(mapChannelRow);
  }

  getChannel(channelId: string): CollaborationChannelRecord | null {
    const row = this.database
      .prepare<[string], CollaborationChannelRow>(`${channelSelectSql} WHERE channel_id = ?`)
      .get(channelId);
    return row ? mapChannelRow(row) : null;
  }

  getChannelByBackingSessionAgentId(backingSessionAgentId: string): CollaborationChannelRecord | null {
    const row = this.database
      .prepare<[string], CollaborationChannelRow>(`${channelSelectSql} WHERE backing_session_agent_id = ?`)
      .get(backingSessionAgentId);
    return row ? mapChannelRow(row) : null;
  }

  createChannel(input: CreateCollaborationChannelInput): CollaborationChannelRecord {
    this.database.prepare(
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
         model_thinking_level,
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
      input.channelId,
      input.workspaceId,
      input.categoryId,
      input.backingSessionAgentId,
      input.name,
      input.slug,
      input.description ?? null,
      input.aiEnabled ? 1 : 0,
      normalizeNullableString(input.modelId ?? null),
      normalizeNullableString(input.modelThinkingLevel ?? null),
      input.position,
      input.archived ? 1 : 0,
      input.archivedAt ?? null,
      input.archivedByUserId ?? null,
      input.createdByUserId ?? null,
      input.lastMessageSeq ?? 0,
      input.lastMessageId ?? null,
      input.lastMessageAt ?? null,
      input.createdAt,
      input.updatedAt,
    );

    return requireChannel(this.getChannel(input.channelId), input.channelId);
  }

  updateChannel(channelId: string, input: UpdateCollaborationChannelInput): CollaborationChannelRecord | null {
    const existing = this.getChannel(channelId);
    if (!existing) {
      return null;
    }

    this.database.prepare(
      `UPDATE collab_channel
       SET category_id = ?,
           name = ?,
           slug = ?,
           description = ?,
           ai_enabled = ?,
           model_id = ?,
           model_thinking_level = ?,
           position = ?,
           archived = ?,
           archived_at = ?,
           archived_by_user_id = ?,
           last_message_seq = ?,
           last_message_id = ?,
           last_message_at = ?,
           updated_at = ?
       WHERE channel_id = ?`,
    ).run(
      input.categoryId !== undefined ? input.categoryId : existing.categoryId,
      input.name ?? existing.name,
      input.slug ?? existing.slug,
      input.description !== undefined ? input.description : existing.description,
      input.aiEnabled !== undefined ? (input.aiEnabled ? 1 : 0) : (existing.aiEnabled ? 1 : 0),
      input.modelId !== undefined ? normalizeNullableString(input.modelId) : normalizeNullableString(existing.modelId),
      input.modelThinkingLevel !== undefined
        ? normalizeNullableString(input.modelThinkingLevel)
        : normalizeNullableString(existing.modelThinkingLevel),
      input.position ?? existing.position,
      input.archived !== undefined ? (input.archived ? 1 : 0) : (existing.archived ? 1 : 0),
      input.archivedAt !== undefined ? input.archivedAt : existing.archivedAt,
      input.archivedByUserId !== undefined ? input.archivedByUserId : existing.archivedByUserId,
      input.lastMessageSeq ?? existing.lastMessageSeq,
      input.lastMessageId !== undefined ? input.lastMessageId : existing.lastMessageId,
      input.lastMessageAt !== undefined ? input.lastMessageAt : existing.lastMessageAt,
      input.updatedAt,
      channelId,
    );

    return this.getChannel(channelId);
  }

  advanceChannelActivity(
    channelId: string,
    input: AdvanceCollaborationChannelActivityInput,
  ): CollaborationChannelRecord | null {
    const result = this.database.prepare(
      `UPDATE collab_channel
       SET last_message_seq = last_message_seq + 1,
           last_message_id = ?,
           last_message_at = ?,
           updated_at = ?
       WHERE channel_id = ?`,
    ).run(input.lastMessageId ?? null, input.lastMessageAt, input.updatedAt, channelId);

    if (result.changes === 0) {
      return null;
    }

    return this.getChannel(channelId);
  }

  getChannelUserState(channelId: string, userId: string): CollaborationChannelUserStateRecord | null {
    const row = this.database
      .prepare<[string, string], CollaborationChannelUserStateRow>(
        `${channelUserStateSelectSql} WHERE channel_id = ? AND user_id = ?`,
      )
      .get(channelId, userId);
    return row ? mapChannelUserStateRow(row) : null;
  }

  upsertChannelReadState(
    input: UpsertCollaborationChannelReadStateInput,
  ): CollaborationChannelUserStateRecord {
    this.database.prepare(
      `INSERT INTO collab_channel_user_state (
         channel_id,
         user_id,
         last_read_message_id,
         last_read_message_seq,
         last_read_at,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, user_id) DO UPDATE SET
         last_read_message_id = excluded.last_read_message_id,
         last_read_message_seq = excluded.last_read_message_seq,
         last_read_at = excluded.last_read_at,
         updated_at = excluded.updated_at`,
    ).run(
      input.channelId,
      input.userId,
      input.lastReadMessageId ?? null,
      input.lastReadMessageSeq,
      input.lastReadAt ?? null,
      input.createdAt,
      input.updatedAt,
    );

    return requireChannelUserState(
      this.getChannelUserState(input.channelId, input.userId),
      input.channelId,
      input.userId,
    );
  }

  archiveChannel(channelId: string, input: ArchiveCollaborationChannelInput): CollaborationChannelRecord | null {
    return this.updateChannel(channelId, {
      archived: true,
      archivedAt: input.archivedAt,
      archivedByUserId: input.archivedByUserId,
      updatedAt: input.updatedAt,
    });
  }
}

export async function createCollaborationDbHelpers(config: SwarmConfig): Promise<CollaborationDbHelpers> {
  return new CollaborationDbHelpers(await getOrCreateCollaborationAuthDb(config));
}

const workspaceSelectSql = `SELECT workspace_id,
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
FROM collab_workspace`;

const categorySelectSql = `SELECT category_id,
  workspace_id,
  name,
  default_model_provider,
  default_model_id,
  default_model_thinking_level,
  default_cwd,
  position,
  created_at,
  updated_at
FROM collab_category`;

const channelSelectSql = `SELECT channel_id,
  workspace_id,
  category_id,
  backing_session_agent_id,
  name,
  slug,
  description,
  ai_enabled,
  model_id,
  model_thinking_level,
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
FROM collab_channel`;

const channelUserStateSelectSql = `SELECT channel_id,
  user_id,
  last_read_message_id,
  last_read_message_seq,
  last_read_at,
  created_at,
  updated_at
FROM collab_channel_user_state`;

function mapWorkspaceRow(row: CollaborationWorkspaceRow): CollaborationWorkspaceRecord {
  return {
    workspaceId: row.workspace_id,
    backingProfileId: row.backing_profile_id,
    displayName: row.display_name,
    description: row.description,
    aiDisplayName: row.ai_display_name,
    createdByUserId: row.created_by_user_id,
    defaultModelProvider: row.default_model_provider,
    defaultModelId: row.default_model_id,
    defaultModelThinkingLevel: row.default_model_thinking_level,
    defaultCwd: row.default_cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCategoryRow(row: CollaborationCategoryRow): CollaborationCategoryRecord {
  return {
    categoryId: row.category_id,
    workspaceId: row.workspace_id,
    name: row.name,
    defaultModelProvider: row.default_model_provider,
    defaultModelId: row.default_model_id,
    defaultModelThinkingLevel: row.default_model_thinking_level,
    defaultCwd: row.default_cwd,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChannelRow(row: CollaborationChannelRow): CollaborationChannelRecord {
  return {
    channelId: row.channel_id,
    workspaceId: row.workspace_id,
    categoryId: row.category_id,
    backingSessionAgentId: row.backing_session_agent_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    aiEnabled: row.ai_enabled === 1,
    modelId: row.model_id,
    modelThinkingLevel: row.model_thinking_level,
    position: row.position,
    archived: row.archived === 1,
    archivedAt: row.archived_at,
    archivedByUserId: row.archived_by_user_id,
    createdByUserId: row.created_by_user_id,
    lastMessageSeq: row.last_message_seq,
    lastMessageId: row.last_message_id,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChannelUserStateRow(
  row: CollaborationChannelUserStateRow,
): CollaborationChannelUserStateRecord {
  return {
    channelId: row.channel_id,
    userId: row.user_id,
    lastReadMessageId: row.last_read_message_id,
    lastReadMessageSeq: row.last_read_message_seq,
    lastReadAt: row.last_read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireWorkspace(
  workspace: CollaborationWorkspaceRecord | null,
  workspaceId: string,
): CollaborationWorkspaceRecord {
  if (workspace) {
    return workspace;
  }

  throw new Error(`Unknown collaboration workspace: ${workspaceId}`);
}

function requireCategory(
  category: CollaborationCategoryRecord | null,
  categoryId: string,
): CollaborationCategoryRecord {
  if (category) {
    return category;
  }

  throw new Error(`Unknown collaboration category: ${categoryId}`);
}

function requireChannel(
  channel: CollaborationChannelRecord | null,
  channelId: string,
): CollaborationChannelRecord {
  if (channel) {
    return channel;
  }

  throw new Error(`Unknown collaboration channel: ${channelId}`);
}

function requireChannelUserState(
  channelUserState: CollaborationChannelUserStateRecord | null,
  channelId: string,
  userId: string,
): CollaborationChannelUserStateRecord {
  if (channelUserState) {
    return channelUserState;
  }

  throw new Error(`Unknown collaboration channel user state: ${channelId}/${userId}`);
}

function requiredDefault(value: string | null, fieldName: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Missing collaboration workspace ${fieldName}`);
  }

  return normalized;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
