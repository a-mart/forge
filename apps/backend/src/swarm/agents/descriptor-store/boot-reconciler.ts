import { migrateDataDirectory } from "../../data-migration.js";
import type { AgentDescriptor, AgentsStoreFile, ManagerProfile, SwarmConfig } from "../../types.js";
import type { ProfileBootReconciler } from "./profile-boot-reconciler.js";
import { prunePersistedWorkerSidecars } from "./worker-boot-recovery.js";
import { resolveDelegationRosterSettings } from "../../specialists/delegation-roster-store.js";

interface BootReconcilerOptions {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  loadStore: () => Promise<AgentsStoreFile>;
  saveStore: () => Promise<void>;
  profileReconciler: ProfileBootReconciler;
  preloadPinnedMessageIndexes: () => Promise<void>;
  preloadSessionPlanStates: () => Promise<void>;
  logDebug: (message: string, details?: unknown) => void;
}

export class BootReconciler {
  constructor(private readonly options: BootReconcilerOptions) {}

  async loadAndReconcilePersistedStore(): Promise<AgentsStoreFile> {
    let loaded = await this.options.loadStore();
    const migrationResult = await migrateDataDirectory(
      {
        dataDir: this.options.config.paths.dataDir,
        agentsStoreFile: this.options.config.paths.agentsStoreFile
      },
      loaded.agents,
      loaded.profiles ?? [],
      {
        debug: (message, details) => this.options.logDebug(message, details),
        info: (message, details) => this.options.logDebug(message, details),
        warn: (message, details) => this.options.logDebug(message, details)
      }
    );
    loaded = {
      ...loaded,
      agents: migrationResult.updatedAgents
    };

    const cortexPruneResult = this.options.profileReconciler.prunePersistedCortexStateForBoot(loaded);
    loaded = cortexPruneResult.store;
    const workerSidecarPruneResult = prunePersistedWorkerSidecars(loaded, this.options.logDebug);
    loaded = workerSidecarPruneResult.store;

    for (const descriptor of loaded.agents) {
      this.options.descriptors.set(descriptor.agentId, descriptor);
    }
    for (const profile of loaded.profiles ?? []) {
      this.options.profiles.set(profile.profileId, profile);
    }

    await this.options.preloadPinnedMessageIndexes();
    await this.options.preloadSessionPlanStates();

    const normalizedSessionModelState = this.options.profileReconciler.reconcileProfilesOnBoot();
    const delegationRosterSettings = await resolveDelegationRosterSettings(
      this.options.config.paths.dataDir,
    );
    const normalizedDelegationState =
      this.options.profileReconciler.reconcileDelegationStateOnBoot(
        delegationRosterSettings.defaultRosterId,
      );
    const normalizedSystemProfileTypes = this.options.profileReconciler.normalizeSystemProfileTypes();
    if (
      cortexPruneResult.pruned ||
      workerSidecarPruneResult.pruned ||
      normalizedSessionModelState ||
      normalizedDelegationState ||
      normalizedSystemProfileTypes
    ) {
      await this.options.saveStore();
    }

    return loaded;
  }
}
