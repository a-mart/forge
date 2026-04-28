import { randomUUID } from "node:crypto";
import type { CollaborationWorkspace } from "@forge/protocol";
import type { ManagerProfile, SwarmConfig } from "../swarm/types.js";
import type {
  CollaborationDbHelpers,
  CollaborationWorkspaceDefaultsRecord,
  CollaborationWorkspaceRecord,
} from "./collab-db-helpers.js";
import {
  COLLABORATION_CHANNEL_ARCHETYPE_ID,
  COLLABORATION_DISPLAY_NAME,
  COLLABORATION_PROFILE_ID,
} from "./constants.js";

export interface CollaborationWorkspaceServiceSwarmManager {
  listProfiles?(): ManagerProfile[];
  getConfig?(): SwarmConfig;
}

export class CollaborationWorkspaceServiceError extends Error {
  constructor(
    public readonly code: "not_found" | "profile_template_missing" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CollaborationWorkspaceServiceError";
  }
}

export class CollaborationWorkspaceService {
  constructor(
    private readonly dbHelpers: Pick<
      CollaborationDbHelpers,
      "getWorkspace" | "getWorkspaceByBackingProfileId" | "listWorkspaces" | "createWorkspace" | "updateWorkspaceDefaults"
    >,
    private readonly swarmManager?: CollaborationWorkspaceServiceSwarmManager,
    private readonly config?: SwarmConfig,
  ) {}

  getWorkspace(workspaceId: string): CollaborationWorkspace {
    const record = this.dbHelpers.getWorkspace(normalizeRequiredString(workspaceId, "workspaceId"));
    if (!record) {
      throw new CollaborationWorkspaceServiceError("not_found", `Unknown collaboration workspace: ${workspaceId}`);
    }

    return this.toWorkspaceDto(record);
  }

  async ensureDefaultWorkspace(): Promise<CollaborationWorkspace | null> {
    const existingWorkspace = this.dbHelpers.listWorkspaces()[0] ?? null;
    if (existingWorkspace) {
      const repaired = this.repairDefaults(existingWorkspace);
      return this.toWorkspaceDto(repaired);
    }

    const config = this.resolveConfig();
    if (!config) {
      return null;
    }

    const existingForProfile = this.dbHelpers.getWorkspaceByBackingProfileId(COLLABORATION_PROFILE_ID);
    if (existingForProfile) {
      const repaired = this.repairDefaults(existingForProfile);
      return this.toWorkspaceDto(repaired);
    }

    const now = new Date().toISOString();
    const record = this.dbHelpers.createWorkspace({
      workspaceId: randomUUID(),
      backingProfileId: COLLABORATION_PROFILE_ID,
      displayName: "Workspace",
      description: null,
      aiDisplayName: null,
      createdByUserId: null,
      ...workspaceDefaultsFromConfig(config),
      createdAt: now,
      updatedAt: now,
    });

    return this.toWorkspaceDto(record);
  }

  toWorkspaceDto(record: CollaborationWorkspaceRecord): CollaborationWorkspace {
    const defaults = requireInitializedWorkspaceDefaults(record);
    const collaborationProfile = this.getCollaborationProfile();

    return {
      workspaceId: record.workspaceId,
      backingProfileId: record.backingProfileId,
      displayName: record.displayName,
      ...(record.description ? { description: record.description } : {}),
      ...(record.aiDisplayName ? { aiDisplayName: record.aiDisplayName } : {}),
      ...(record.createdByUserId ? { createdByUserId: record.createdByUserId } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      profileDisplayName: collaborationProfile?.displayName ?? COLLABORATION_DISPLAY_NAME,
      defaultSessionAgentId: collaborationProfile?.defaultSessionAgentId ?? COLLABORATION_PROFILE_ID,
      baseAi: {
        model: {
          provider: defaults.defaultModelProvider,
          modelId: defaults.defaultModelId,
          thinkingLevel: defaults.defaultModelThinkingLevel,
        },
        archetypeId: COLLABORATION_CHANNEL_ARCHETYPE_ID,
        cwd: defaults.defaultCwd,
        contextMode: "prompt_and_memory",
      },
    };
  }

  private repairDefaults(workspace: CollaborationWorkspaceRecord): CollaborationWorkspaceRecord {
    const repairedDefaults = resolveWorkspaceDefaults(workspace, this.resolveConfig());
    if (
      workspace.defaultModelProvider === repairedDefaults.defaultModelProvider &&
      workspace.defaultModelId === repairedDefaults.defaultModelId &&
      workspace.defaultModelThinkingLevel === repairedDefaults.defaultModelThinkingLevel &&
      workspace.defaultCwd === repairedDefaults.defaultCwd
    ) {
      return workspace;
    }

    return this.dbHelpers.updateWorkspaceDefaults(workspace.workspaceId, {
      ...repairedDefaults,
      updatedAt: new Date().toISOString(),
    }) ?? workspace;
  }

  private getCollaborationProfile(): ManagerProfile | null {
    return this.swarmManager?.listProfiles?.().find((profile) => profile.profileId === COLLABORATION_PROFILE_ID) ?? null;
  }

  private resolveConfig(): SwarmConfig | null {
    return this.config ?? this.swarmManager?.getConfig?.() ?? null;
  }
}

export function workspaceDefaultsFromConfig(config: SwarmConfig): CollaborationWorkspaceDefaultsRecord {
  return {
    defaultModelProvider: config.defaultModel.provider,
    defaultModelId: config.defaultModel.modelId,
    defaultModelThinkingLevel: config.defaultModel.thinkingLevel,
    defaultCwd: config.defaultCwd,
  };
}

export function hasInitializedWorkspaceDefaults(record: CollaborationWorkspaceDefaultsRecord): boolean {
  return Boolean(
    normalizeOptionalDefault(record.defaultModelProvider) &&
      normalizeOptionalDefault(record.defaultModelId) &&
      normalizeOptionalDefault(record.defaultModelThinkingLevel) &&
      normalizeOptionalDefault(record.defaultCwd),
  );
}

interface InitializedWorkspaceDefaults {
  defaultModelProvider: string;
  defaultModelId: string;
  defaultModelThinkingLevel: string;
  defaultCwd: string;
}

export function requireInitializedWorkspaceDefaults(
  record: CollaborationWorkspaceDefaultsRecord,
): InitializedWorkspaceDefaults {
  const defaultModelProvider = normalizeOptionalDefault(record.defaultModelProvider);
  const defaultModelId = normalizeOptionalDefault(record.defaultModelId);
  const defaultModelThinkingLevel = normalizeOptionalDefault(record.defaultModelThinkingLevel);
  const defaultCwd = normalizeOptionalDefault(record.defaultCwd);

  if (!defaultModelProvider || !defaultModelId || !defaultModelThinkingLevel || !defaultCwd) {
    throw new CollaborationWorkspaceServiceError(
      "profile_template_missing",
      "Collaboration workspace defaults are not initialized",
    );
  }

  return {
    defaultModelProvider,
    defaultModelId,
    defaultModelThinkingLevel,
    defaultCwd,
  };
}

function resolveWorkspaceDefaults(
  workspace: CollaborationWorkspaceRecord,
  config: SwarmConfig | null,
): CollaborationWorkspaceDefaultsRecord {
  const configDefaults = config ? workspaceDefaultsFromConfig(config) : null;
  return {
    defaultModelProvider: normalizeOptionalDefault(workspace.defaultModelProvider) ?? configDefaults?.defaultModelProvider ?? null,
    defaultModelId: normalizeOptionalDefault(workspace.defaultModelId) ?? configDefaults?.defaultModelId ?? null,
    defaultModelThinkingLevel:
      normalizeOptionalDefault(workspace.defaultModelThinkingLevel) ?? configDefaults?.defaultModelThinkingLevel ?? null,
    defaultCwd: normalizeOptionalDefault(workspace.defaultCwd) ?? configDefaults?.defaultCwd ?? null,
  };
}

function normalizeOptionalDefault(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Missing collaboration workspace ${fieldName}`);
  }

  return normalized;
}
