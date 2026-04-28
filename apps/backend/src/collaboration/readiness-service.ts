import type Database from "better-sqlite3";
import type { CollaborationStatus, CollaborationWorkspace } from "@forge/protocol";
import { isCollaborationServerRuntimeTarget } from "../runtime-target.js";
import type { SwarmConfig } from "../swarm/types.js";
import { createCollaborationDbHelpers, type CollaborationDbHelpers } from "./collab-db-helpers.js";
import { CollaborationWorkspaceService, hasInitializedWorkspaceDefaults } from "./workspace-service.js";

interface AdminExistsRow {
  adminExists: number;
}

export interface CollaborationReadinessSwarmManager {
  ensureCollaborationStorageProfile?(): Promise<void>;
  hasCollaborationStorageProfile?(): boolean;
  hasCollaborationStorageRootSession?(): boolean;
}

export interface CollaborationReadinessResult extends CollaborationStatus {
  workspace: CollaborationWorkspace | null;
}

export interface CollaborationReadinessStatusProvider {
  getCollaborationStatus(): CollaborationStatus;
}

export interface CollaborationReadinessRequestService extends CollaborationReadinessStatusProvider {
  ensureCollaborationReady(): Promise<CollaborationReadinessResult>;
}

export class CollaborationReadinessError extends Error {
  constructor(
    message: string,
    public readonly status: CollaborationStatus,
  ) {
    super(message);
    this.name = "CollaborationReadinessError";
  }
}

export class CollaborationReadinessService implements CollaborationReadinessRequestService {
  private ensureInFlight: Promise<CollaborationReadinessResult> | null = null;
  private readonly workspaceService: CollaborationWorkspaceService;

  constructor(
    private readonly config: SwarmConfig,
    private readonly dbHelpers: CollaborationDbHelpers,
    private readonly database: Database.Database | null,
    private readonly swarmManager?: CollaborationReadinessSwarmManager,
  ) {
    this.workspaceService = new CollaborationWorkspaceService(dbHelpers, undefined, config);
  }

  getCollaborationStatus(): CollaborationStatus {
    const { workspace: _workspace, ...status } = this.evaluateReadiness({ initializing: this.ensureInFlight !== null });
    return status;
  }

  async ensureCollaborationReady(): Promise<CollaborationReadinessResult> {
    if (!isCollaborationServerRuntimeTarget(this.config.runtimeTarget)) {
      return this.evaluateReadiness({ initializing: false });
    }

    if (this.ensureInFlight) {
      return this.ensureInFlight;
    }

    const promise = this.ensureCollaborationReadyInternal();
    this.ensureInFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.ensureInFlight === promise) {
        this.ensureInFlight = null;
      }
    }
  }

  private async ensureCollaborationReadyInternal(): Promise<CollaborationReadinessResult> {
    await this.swarmManager?.ensureCollaborationStorageProfile?.();
    await this.workspaceService.ensureDefaultWorkspace();
    return this.evaluateReadiness({ initializing: false });
  }

  private evaluateReadiness(options: { initializing: boolean }): CollaborationReadinessResult {
    const enabled = isCollaborationServerRuntimeTarget(this.config.runtimeTarget);
    const adminExists = enabled ? this.hasEnabledAdmin() : false;
    const workspaceRecord = enabled ? this.dbHelpers.listWorkspaces()[0] ?? null : null;
    const workspaceExists = Boolean(workspaceRecord);
    const workspaceDefaultsInitialized = Boolean(
      workspaceRecord && hasInitializedWorkspaceDefaults(workspaceRecord),
    );
    const storageProfileExists = enabled && (this.swarmManager?.hasCollaborationStorageProfile?.() ?? false);
    const storageRootSessionExists = enabled && (this.swarmManager?.hasCollaborationStorageRootSession?.() ?? false);
    const ready = Boolean(
      enabled && adminExists && workspaceExists && workspaceDefaultsInitialized && storageProfileExists && storageRootSessionExists,
    );
    const bootstrapState: CollaborationStatus["bootstrapState"] = !enabled
      ? "disabled"
      : options.initializing
        ? "initializing"
        : ready
          ? "ready"
          : "degraded";

    return {
      enabled,
      adminExists,
      ready,
      bootstrapState,
      workspaceExists,
      workspaceDefaultsInitialized,
      storageProfileExists,
      storageRootSessionExists,
      ...(this.config.collaborationBaseUrl ? { baseUrl: this.config.collaborationBaseUrl } : {}),
      workspace:
        workspaceRecord && workspaceDefaultsInitialized
          ? this.workspaceService.toWorkspaceDto(workspaceRecord)
          : null,
    };
  }

  private hasEnabledAdmin(): boolean {
    if (!this.database) {
      return false;
    }

    const row = this.database.prepare<[], AdminExistsRow>([
      "SELECT EXISTS(",
      "  SELECT 1",
      "  FROM collaboration_user",
      "  WHERE role = 'admin' AND disabled = 0",
      ") AS adminExists",
    ].join("\n")).get();

    return Number(row?.adminExists ?? 0) === 1;
  }
}

export async function createCollaborationReadinessService(
  config: SwarmConfig,
  database?: Database.Database | null,
  swarmManager?: CollaborationReadinessSwarmManager,
): Promise<CollaborationReadinessService> {
  const dbHelpers = await createCollaborationDbHelpers(config);
  return new CollaborationReadinessService(config, dbHelpers, database ?? null, swarmManager);
}

export function buildDisabledCollaborationStatus(baseUrl?: string): CollaborationStatus {
  return {
    enabled: false,
    adminExists: false,
    ready: false,
    bootstrapState: "disabled",
    workspaceExists: false,
    workspaceDefaultsInitialized: false,
    storageProfileExists: false,
    storageRootSessionExists: false,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export function buildDegradedCollaborationStatus(baseUrl?: string): CollaborationStatus {
  return {
    enabled: true,
    adminExists: false,
    ready: false,
    bootstrapState: "degraded",
    workspaceExists: false,
    workspaceDefaultsInitialized: false,
    storageProfileExists: false,
    storageRootSessionExists: false,
    ...(baseUrl ? { baseUrl } : {}),
  };
}
