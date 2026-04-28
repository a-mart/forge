import type { CollaborationStatus } from "@forge/protocol";
import { isCollaborationServerRuntimeTarget } from "../runtime-target.js";
import type { SwarmConfig } from "../swarm/types.js";
import { getOrCreateCollaborationAuthDb } from "./auth/collaboration-db.js";
import {
  buildDegradedCollaborationStatus,
  buildDisabledCollaborationStatus,
  createCollaborationReadinessService,
  type CollaborationReadinessStatusProvider,
  type CollaborationReadinessSwarmManager,
} from "./readiness-service.js";

export class CollaborationSettingsService {
  constructor(
    private readonly config: SwarmConfig,
    private readonly readinessService: CollaborationReadinessStatusProvider | null,
  ) {}

  getCollaborationBaseUrl(): string | undefined {
    return this.config.collaborationBaseUrl;
  }

  getCollaborationStatus(): CollaborationStatus {
    if (this.readinessService) {
      return this.readinessService.getCollaborationStatus();
    }

    const baseUrl = this.getCollaborationBaseUrl();
    return isCollaborationServerRuntimeTarget(this.config.runtimeTarget)
      ? buildDegradedCollaborationStatus(baseUrl)
      : buildDisabledCollaborationStatus(baseUrl);
  }
}

export async function createCollaborationSettingsService(
  config: SwarmConfig,
  swarmManager?: CollaborationReadinessSwarmManager,
  readinessService?: CollaborationReadinessStatusProvider,
): Promise<CollaborationSettingsService> {
  if (readinessService) {
    return new CollaborationSettingsService(config, readinessService);
  }

  if (!isCollaborationServerRuntimeTarget(config.runtimeTarget) || !swarmManager) {
    return new CollaborationSettingsService(config, null);
  }

  const database = await getOrCreateCollaborationAuthDb(config);
  const createdReadinessService = await createCollaborationReadinessService(config, database, swarmManager);
  return new CollaborationSettingsService(config, createdReadinessService);
}
