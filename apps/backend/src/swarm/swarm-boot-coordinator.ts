import { transitionAgentStatus } from "./agent-state-machine.js";
import type { BootReconciler } from "./agents/descriptor-store/boot-reconciler.js";
import type { WorkerBootRecovery } from "./agents/descriptor-store/worker-boot-recovery.js";
import { reconcilePersistedCodexDetailStateForBoot } from "./codex-app-server/codex-detail-boot-reconciliation.js";
import {
  isExternalThreadDescriptor,
  reconcilePersistedExternalThreadSidecarsForBoot,
  shouldIncludeDescriptorInBootInterruptedToolReconciliation,
} from "./external-thread-compatibility.js";
import { reconcileInterruptedToolCallsForBoot } from "./interrupted-tool-reconciliation.js";
import type { RestartRecoveryCoordinator } from "./restart-recovery-coordinator.js";
import type { SecureSessionCoordinatorPort } from "./secure-sessions/secure-session-lifecycle-port.js";
import { normalizeOptionalAgentId } from "./swarm-manager-utils.js";
import type { AgentDescriptor, SwarmConfig } from "./types.js";

export interface BootPreparationPort {
  ensureDirectories(): Promise<void>;
  migrateSharedConfigLayout(): Promise<void>;
  cleanupOldSharedConfigPaths(): Promise<void>;
  removeRetiredPlanningArtifacts(): Promise<void>;
  ensureCanonicalAuthFilePath(): Promise<void>;
  reloadModelCatalog(): Promise<void>;
  loadSecrets(): Promise<void>;
  loadCompactionSettings(): Promise<void>;
  loadSecureSecretSettings(): Promise<void>;
  reloadSkillMetadata(): Promise<void>;
  resolveDefaultCwd(cwd: string): Promise<string>;
  refreshDefaultMemoryTemplate(): Promise<unknown>;
}

export interface BootDomainPort {
  normalizeCodexPluginWorkers(): boolean;
  reconcileWorkerSpecialistMetadata(): Promise<void>;
  ensureCortexProfile(): Promise<void>;
  loadOnboardingState(): Promise<void>;
  ensureLegacyProfileKnowledgeReferenceDocs(): Promise<void>;
  reconcileProjectAgentMirror(): Promise<unknown>;
  reconcileProjectAgentSharing(): Promise<unknown>;
}

export interface BootSessionStatePort {
  ensureMemoryFiles(): Promise<void>;
  rebuildSessionManifest(): Promise<void>;
  hydrateCompactionCounts(): Promise<void>;
  startCompactionCountBackfill(): void;
  loadConversationHistories(): void;
}

export interface BootRuntimePort {
  sortedDescriptors(): AgentDescriptor[];
  shouldRestore(descriptor: AgentDescriptor): boolean;
  restore(descriptor: AgentDescriptor): Promise<void>;
  hasRuntime(agentId: string): boolean;
  restoredAgentIds(): string[];
  emitStatus(agentId: string, status: AgentDescriptor["status"], contextPercent: number): void;
}

export interface BootPublicationPort {
  listPrompts(): Promise<Array<{ category: string; promptId: string }>>;
  emitAgentsSnapshot(): void;
  emitProfilesSnapshot(): void;
  scheduleProjectExecutableTrustPrompts(): void;
  startWorkerHealth(): void;
  scheduleGoalContinuations(): void;
}

export interface BootDescriptorStorePort {
  save(): Promise<void>;
  upsertDescriptor(descriptor: AgentDescriptor): void;
}

export interface SwarmBootCoordinatorOptions {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  storeReconciler: BootReconciler;
  restartRecovery: RestartRecoveryCoordinator;
  workerRecovery: WorkerBootRecovery;
  preparation: BootPreparationPort;
  domains: BootDomainPort;
  sessions: BootSessionStatePort;
  secureSessions: Pick<SecureSessionCoordinatorPort, "initializeForBoot">;
  runtimes: BootRuntimePort;
  publication: BootPublicationPort;
  store: BootDescriptorStorePort;
  now(): string;
  logDebug(message: string, details?: unknown): void;
}

/**
 * Owns the one-way boot transaction. Its ports expose boot-only capabilities,
 * while profile repair and restart recovery remain with their existing owners.
 */
export class SwarmBootCoordinator {
  constructor(private readonly options: SwarmBootCoordinatorOptions) {}

  async boot(): Promise<void> {
    const { config, preparation, domains, sessions, publication, store } = this.options;
    this.options.logDebug("boot:start", {
      host: config.host,
      port: config.port,
      authFile: config.paths.sharedAuthFile,
      managerId: config.managerId,
    });

    await preparation.ensureDirectories();
    await preparation.migrateSharedConfigLayout();
    await preparation.cleanupOldSharedConfigPaths();
    await preparation.removeRetiredPlanningArtifacts();
    await preparation.ensureCanonicalAuthFilePath();
    await preparation.reloadModelCatalog();
    await preparation.loadSecrets();
    await preparation.loadCompactionSettings();
    await preparation.loadSecureSecretSettings();
    await preparation.reloadSkillMetadata();
    try {
      config.defaultCwd = await preparation.resolveDefaultCwd(config.defaultCwd);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Invalid default working directory: ${error.message}`);
      }
      throw error;
    }
    await preparation.refreshDefaultMemoryTemplate();

    await this.options.storeReconciler.loadAndReconcilePersistedStore();
    if (domains.normalizeCodexPluginWorkers()) await store.save();
    await domains.ensureCortexProfile();
    await domains.loadOnboardingState();
    await domains.ensureLegacyProfileKnowledgeReferenceDocs();

    this.reconcileInterruptedState();
    await this.options.restartRecovery.reconcileForBoot();
    this.normalizeStreamingStatuses();
    this.reconcileExternalThreadSidecars();
    await this.options.workerRecovery.recoverMissingDescriptors();
    await domains.reconcileWorkerSpecialistMetadata();

    await domains.reconcileProjectAgentMirror();
    await domains.reconcileProjectAgentSharing();
    try {
      // Begin Docker orphan cleanup immediately without delaying ordinary
      // readiness. Secure Session authorization joins this same promise and
      // remains fail-closed until recovery completes.
      void this.options.secureSessions.initializeForBoot().then(
        (recovery) => {
          this.options.logDebug("boot:secure_sessions:reconciled", {
            destroyedSandboxCount: recovery.destroyedSandboxIds.length,
          });
        },
        (error: unknown) => {
          this.options.logDebug("boot:secure_sessions:reconcile_error", {
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    } catch (error) {
      this.options.logDebug("boot:secure_sessions:reconcile_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await sessions.ensureMemoryFiles();
    await store.save();
    await sessions.rebuildSessionManifest();
    await sessions.hydrateCompactionCounts();
    sessions.startCompactionCountBackfill();
    sessions.loadConversationHistories();
    await this.restoreRuntimes();

    const manager = this.getBootLogManagerDescriptor();
    const loadedArchetypeIds = (await publication.listPrompts())
      .filter((prompt) => prompt.category === "archetype")
      .map((prompt) => prompt.promptId)
      .sort((left, right) => left.localeCompare(right));
    publication.emitAgentsSnapshot();
    publication.emitProfilesSnapshot();
    publication.scheduleProjectExecutableTrustPrompts();
    publication.startWorkerHealth();
    publication.scheduleGoalContinuations();
    this.options.logDebug("boot:ready", {
      managerId: manager?.agentId,
      managerStatus: manager?.status,
      model: manager?.model,
      cwd: manager?.cwd,
      managerAgentDir: config.paths.managerAgentDir,
      managerSystemPromptSource: manager ? "archetype:manager" : undefined,
      loadedArchetypeIds,
      restoredAgentIds: this.options.runtimes.restoredAgentIds(),
    });
  }

  private reconcileInterruptedState(): void {
    const interruptedActorAgentIds = new Set<string>();
    for (const descriptor of this.options.descriptors.values()) {
      if (shouldIncludeDescriptorInBootInterruptedToolReconciliation(descriptor)) {
        interruptedActorAgentIds.add(descriptor.agentId);
      }
    }
    reconcileInterruptedToolCallsForBoot({
      descriptors: this.options.descriptors,
      interruptedActorAgentIds,
      now: this.options.now,
      logDebug: this.options.logDebug,
    });
    reconcilePersistedCodexDetailStateForBoot({
      descriptors: this.options.descriptors,
      now: this.options.now,
      logDebug: this.options.logDebug,
    });
  }

  private normalizeStreamingStatuses(): void {
    const normalizedAgentIds: string[] = [];
    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.status !== "streaming" || isExternalThreadDescriptor(descriptor)) continue;
      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
      descriptor.updatedAt = this.options.now();
      this.options.store.upsertDescriptor(descriptor);
      normalizedAgentIds.push(descriptor.agentId);
    }
    if (normalizedAgentIds.length > 0) {
      this.options.logDebug("boot:normalize_streaming_statuses", { normalizedAgentIds });
    }
  }

  private reconcileExternalThreadSidecars(): void {
    const reconciledAgentIds = reconcilePersistedExternalThreadSidecarsForBoot({
      descriptors: this.options.descriptors.values(),
      now: this.options.now,
      upsertDescriptor: (descriptor) => this.options.store.upsertDescriptor(descriptor),
    });
    if (reconciledAgentIds.length > 0) {
      this.options.logDebug("boot:reconcile_external_thread_sidecars", {
        reconciledAgentIds,
      });
    }
  }

  private async restoreRuntimes(): Promise<void> {
    let shouldPersist = false;
    const configuredManagerId = normalizeOptionalAgentId(this.options.config.managerId);
    for (const descriptor of this.options.runtimes.sortedDescriptors()) {
      if (!this.options.runtimes.shouldRestore(descriptor)) continue;
      try {
        await this.options.runtimes.restore(descriptor);
      } catch (error) {
        if (
          descriptor.role === "manager" &&
          configuredManagerId &&
          descriptor.agentId === configuredManagerId
        ) {
          throw error;
        }
        const idleStatus =
          descriptor.status === "streaming"
            ? transitionAgentStatus(descriptor.status, "idle")
            : descriptor.status;
        descriptor.status = transitionAgentStatus(idleStatus, "stopped");
        descriptor.contextUsage = undefined;
        descriptor.updatedAt = this.options.now();
        this.options.store.upsertDescriptor(descriptor);
        shouldPersist = true;
        this.options.runtimes.emitStatus(descriptor.agentId, descriptor.status, 0);
        this.options.logDebug("boot:restore_runtime:error", {
          agentId: descriptor.agentId,
          role: descriptor.role,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (shouldPersist) await this.options.store.save();

    const managerId = configuredManagerId;
    const primaryManager = managerId ? this.options.descriptors.get(managerId) : undefined;
    if (
      primaryManager?.role === "manager" &&
      primaryManager.status === "streaming" &&
      !this.options.runtimes.hasRuntime(primaryManager.agentId)
    ) {
      throw new Error("Primary manager runtime is not initialized");
    }
  }

  private getBootLogManagerDescriptor(): AgentDescriptor | undefined {
    const configuredManagerId = normalizeOptionalAgentId(this.options.config.managerId);
    const configuredManager = configuredManagerId
      ? this.options.descriptors.get(configuredManagerId)
      : undefined;
    if (
      configuredManager?.role === "manager" &&
      configuredManager.status !== "terminated"
    ) {
      return configuredManager;
    }
    return [...this.options.descriptors.values()].find(
      (descriptor) => descriptor.role === "manager" && descriptor.status !== "terminated",
    );
  }
}
