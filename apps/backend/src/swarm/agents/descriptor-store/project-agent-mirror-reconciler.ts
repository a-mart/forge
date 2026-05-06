import { ProjectAgentRegistry } from "../project-agent-registry.js";
import type { AgentDescriptor, ManagerProfile } from "../../types.js";

export interface ProjectAgentMirrorReconcilerOptions {
  dataDir: string;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  info?: (message: string) => void;
}

export interface ProjectAgentMirrorReconcileResult {
  hydrated: string[];
  materialized: string[];
  orphansRemoved: string[];
}

export class ProjectAgentMirrorReconciler {
  constructor(private readonly options: ProjectAgentMirrorReconcilerOptions) {}

  async reconcileAllProfiles(): Promise<ProjectAgentMirrorReconcileResult> {
    const combined: ProjectAgentMirrorReconcileResult = {
      hydrated: [],
      materialized: [],
      orphansRemoved: []
    };

    for (const profile of this.options.profiles.values()) {
      const registry = new ProjectAgentRegistry({
        dataDir: this.options.dataDir,
        descriptors: this.options.descriptors
      });
      const result = await registry.reconcileProfile(profile.profileId);

      combined.hydrated.push(...result.hydrated);
      combined.materialized.push(...result.materialized);
      combined.orphansRemoved.push(...result.orphansRemoved);

      this.logProfileResult(profile.profileId, result);
    }

    return combined;
  }

  private logProfileResult(profileId: string, result: ProjectAgentMirrorReconcileResult): void {
    const info = this.options.info ?? console.info;
    if (result.materialized.length > 0) {
      info(
        `[swarm][boot] Materialized ${result.materialized.length} project agent(s) for profile ${profileId}: ${result.materialized.join(", ")}`
      );
    }
    if (result.hydrated.length > 0) {
      info(
        `[swarm][boot] Hydrated ${result.hydrated.length} project agent descriptor(s) for profile ${profileId}: ${result.hydrated.join(", ")}`
      );
    }
    if (result.orphansRemoved.length > 0) {
      info(
        `[swarm][boot] Removed ${result.orphansRemoved.length} orphan project agent directories for profile ${profileId}: ${result.orphansRemoved.join(", ")}`
      );
    }
  }
}
