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

function requireWorkspace(
  workspace: CollaborationWorkspaceRecord | null,
  workspaceId: string,
): CollaborationWorkspaceRecord {
  if (workspace) {
    return workspace;
  }

  throw new Error(`Unknown collaboration workspace: ${workspaceId}`);
}

function requiredDefault(value: string | null, fieldName: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Missing collaboration workspace ${fieldName}`);
  }

  return normalized;
}
