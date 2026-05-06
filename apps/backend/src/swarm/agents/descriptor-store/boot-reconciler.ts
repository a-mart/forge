import { migrateDataDirectory } from "../../data-migration.js";
import type { AgentDescriptor, AgentsStoreFile, ManagerProfile, SwarmConfig } from "../../types.js";

interface BootReconcilerOptions {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  loadStore: () => Promise<AgentsStoreFile>;
  saveStore: () => Promise<void>;
  prunePersistedCortexStateForBoot: (store: AgentsStoreFile) => { store: AgentsStoreFile; pruned: boolean };
  prunePersistedWorkerSidecarDescriptorsForBoot: (store: AgentsStoreFile) => { store: AgentsStoreFile; pruned: boolean };
  preloadPinnedMessageIndexes: () => Promise<void>;
  reconcileProfilesOnBoot: () => boolean;
  normalizeSystemProfileTypes: () => boolean;
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

    const cortexPruneResult = this.options.prunePersistedCortexStateForBoot(loaded);
    loaded = cortexPruneResult.store;
    const workerSidecarPruneResult = this.options.prunePersistedWorkerSidecarDescriptorsForBoot(loaded);
    loaded = workerSidecarPruneResult.store;

    for (const descriptor of loaded.agents) {
      this.options.descriptors.set(descriptor.agentId, descriptor);
    }
    for (const profile of loaded.profiles ?? []) {
      this.options.profiles.set(profile.profileId, profile);
    }

    await this.options.preloadPinnedMessageIndexes();

    const normalizedSessionModelState = this.options.reconcileProfilesOnBoot();
    const normalizedSystemProfileTypes = this.options.normalizeSystemProfileTypes();
    if (
      cortexPruneResult.pruned ||
      workerSidecarPruneResult.pruned ||
      normalizedSessionModelState ||
      normalizedSystemProfileTypes
    ) {
      await this.options.saveStore();
    }

    return loaded;
  }
}
