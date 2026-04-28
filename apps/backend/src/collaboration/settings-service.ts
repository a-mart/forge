import type { CollaborationStatus } from "@forge/protocol";
import { isCollaborationServerRuntimeTarget } from "../runtime-target.js";
import type { SwarmConfig } from "../swarm/types.js";
import {
  buildDegradedCollaborationStatus,
  buildDisabledCollaborationStatus,
  type CollaborationReadinessStatusProvider,
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

