import type {
  DelegationRoster,
  DelegationRoute,
  EffortTier,
  ManagerExactModelSelection,
  SpecialistTargetSpace,
  TierConfig,
} from "@forge/protocol";
import { getSessionFilePath, getWorkerSessionFilePath } from "./data-paths.js";
import { normalizeThinkingLevelForModelDescriptor, resolveModelDescriptorFromPreset, inferProviderFromModelId, parseSwarmModelPreset, parseSwarmReasoningLevel, assertSwarmModelIdNotRetired } from "./model-presets.js";
import { normalizeArchetypeId } from "./prompt-registry.js";
import type {
  RuntimeAcquisitionRequirements,
  RuntimeCreationOptions,
  RuntimeShutdownOptions,
  SetPinnedContentOptions,
  SwarmAgentRuntime
} from "./runtime-contracts.js";
import type { ModelChangeContinuityRequest } from "./runtime/model-change-continuity.js";
import {
  isRuntimeRecoveryActiveForRuntime,
  type ManagerRuntimeRecycleReason as RuntimeManagerRuntimeRecycleReason,
  type RuntimeRecoveryState
} from "./runtime/runtime-recovery-state.js";
import { SessionProvisioner, type ProvisionedSessionDescriptor } from "./session-provisioner.js";
import { isNonRunningAgentStatus, transitionAgentStatus } from "./agent-state-machine.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  ConversationAttachment,
  ManagerProfile,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SpawnAgentInput,
  SwarmModelPreset,
  SwarmReasoningLevel
} from "./types.js";
import {
  formatWorkerStopTimeoutNotice,
  MANUAL_MANAGER_STOP_TIMEOUT_NOTICE,
} from "./manual-stop-notice.js";
import {
  SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE,
  SECURE_RUNTIME_PROVIDER_UNSUPPORTED_MESSAGE,
} from "./secure-sessions/runtime/secure-runtime-binding.js";
import { supportsSecureRuntimeProvider } from "./secure-sessions/runtime/secure-runtime-provider-policy.js";
import {
  buildModelCapacityBlockKey,
  cloneDescriptor,
  normalizeAgentId,
  normalizeOptionalAgentId,
  normalizeOptionalModelId,
  resolveNextCapacityFallbackModelId,
  shouldRetrySpecialistSpawnWithFallback,
  isCollabSession
} from "./swarm-manager-utils.js";
import { resolveExactManagerModelSelection } from "./catalog/manager-model-selection.js";
import { modelCatalogService } from "./catalog/model-catalog-service.js";
import {
  getTierAttributionId,
  normalizeEffortTier,
  resolveLegacySpecialistRewrite,
  resolveTierConfig,
  resolveTierConfigs,
  DEFAULT_TIER_CONFIGS,
  EFFORT_TIER_ORDER,
} from "./specialists/specialist-registry.js";
import {
  assertForgeRuntimeEligibleDescriptor,
  interruptExternalThreadWorkerDescriptor,
  isExternalThreadDescriptor,
  shouldPreserveExternalThreadWorkerOnSessionStop,
  shouldInterruptExternalThreadSidecar,
} from "./external-thread-compatibility.js";
import { isBuiltinModePromptId } from "./worker-mode-prompt.js";
import type { SecureWorkerLifecyclePort } from "./secure-sessions/secure-session-lifecycle-port.js";
import { resolveDelegationRoute } from "./specialists/delegation-roster-store.js";
import { getWorkerBehaviorModeLensId } from "./specialists/delegation-policy.js";

const MANAGER_ARCHETYPE_ID = "manager";
const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";

function getDefaultReasoningLevelForModel(provider: string, modelId: string): string {
  return modelCatalogService.getModel(modelId, provider)?.defaultReasoningLevel ?? "xhigh";
}

function getDelegationTierDisplayName(tier: EffortTier, configuredName: string): string {
  if (tier === "fast") return "Support";
  if (tier === "standard") return "Routine";
  if (tier === "deep") return "Deep";
  return configuredName;
}

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId?: string;
  provider?: string;
  reasoningLevel?: SwarmReasoningLevel;
  fallbackModelId?: string;
  fallbackProvider?: string;
  fallbackReasoningLevel?: SwarmReasoningLevel;
  webSearch?: boolean;
  promptBody: string;
  available: boolean;
  availabilityCode?: string;
  availabilityMessage?: string;
  defaultTier?: EffortTier;
}

interface ModelCapacityBlockLike {
  provider: string;
  modelId: string;
  blockedUntilMs: number;
}

export interface AgentLifecycleDescriptorMutations {
  upsertDescriptor: (descriptor: AgentDescriptor) => void;
  deleteDescriptor: (agentId: string) => void;
  upsertProfile: (profile: ManagerProfile) => void;
  deleteProfile: (profileId: string) => void;
}

export type AgentLifecycleStopSessionOptions = {
  saveStore: boolean;
  emitSnapshots: boolean;
  emitStatus?: boolean;
  deleteWorkers?: boolean;
  manualStopNotice?: boolean;
  taskLifecycle?: "manual_stop" | "none";
};

export type ManagerRuntimeRecycleReason = RuntimeManagerRuntimeRecycleReason;

/**
 * Stop-path hook for preserved external-thread sidecars.
 *
 * Intended for stop/interrupt semantics only (for example, binding to
 * CodexAppServerService.interruptTurn when that real service is available).
 */
export type ExternalThreadStopInterruptCallback = (agentId: string) => Promise<void>;

/**
 * Terminate/delete cleanup hook for external-thread sidecars.
 *
 * This is deliberately distinct from stop/interrupt. Integration must NOT bind
 * this to interruptTurn(); kill/delete should keep terminated/delete semantics
 * while later real service work provides a cleanup-only method that releases any
 * shared busy-state bookkeeping.
 */
export type ExternalThreadTerminateCleanupCallback = (agentId: string) => Promise<void>;

export interface SwarmAgentLifecycleServiceOptions {
  dataDir: string;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  runtimes: Map<string, SwarmAgentRuntime>;
  runtimeCreationPromisesByAgentId?: Map<string, Promise<SwarmAgentRuntime>>;
  getRuntime: (agentId: string) => SwarmAgentRuntime | undefined;
  getRuntimeCreationPromise: (agentId: string) => Promise<SwarmAgentRuntime> | undefined;
  setRuntimeCreationPromise: (agentId: string, promise: Promise<SwarmAgentRuntime>) => void;
  clearRuntimeCreationPromiseIfCurrent: (agentId: string, promise: Promise<SwarmAgentRuntime>) => boolean;
  runtimeRecoveryState: Pick<
    RuntimeRecoveryState,
    | "hasPendingManagerRuntimeRecycle"
    | "getPendingManagerRuntimeRecycleReason"
    | "setPendingManagerRuntimeRecycle"
    | "clearPendingManagerRuntimeRecycle"
    | "clearRecoveryAbortedWorkerTurn"
  >;
  secureWorkers: SecureWorkerLifecyclePort;
  modelCapacityBlocks: Map<string, ModelCapacityBlockLike>;
  sessionProvisioner: SessionProvisioner;
  descriptorMutations: AgentLifecycleDescriptorMutations;
  now: () => string;
  getRequiredSessionDescriptor: (agentId: string) => ProvisionedSessionDescriptor;
  assertManager: (agentId: string, action: string) => AgentDescriptor;
  hasRunningManagers: (options?: { excludeCortex?: boolean }) => boolean;
  generateUniqueAgentId: (source: string) => string;
  generateUniqueManagerId: (source: string) => string;
  resolveAndValidateCwd: (cwd: string) => Promise<string>;
  resolveDefaultModelDescriptor: () => AgentModelDescriptor;
  getManagedModelProviderAvailability: () => Promise<Map<string, boolean>>;
  resolveSpawnWorkerArchetypeId: (
    input: SpawnAgentInput,
    normalizedAgentId: string,
    profileId: string
  ) => Promise<string | undefined>;
  resolveSpecialistRosterForProfile: (
    profileId: string,
    targetSpace?: SpecialistTargetSpace
  ) => Promise<ResolvedSpecialistDefinitionLike[]>;
  resolveSpecialistRosterForManager?: (
    manager: AgentDescriptor,
    targetSpace?: SpecialistTargetSpace
  ) => Promise<ResolvedSpecialistDefinitionLike[]>;
  normalizeSpecialistHandle: (value: string) => Promise<string | undefined>;
  resolveSystemPromptForDescriptor: (descriptor: AgentDescriptor) => Promise<string>;
  injectWorkerIdentityContext: (descriptor: AgentDescriptor, systemPrompt: string) => string;
  createRuntimeForDescriptor: (
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions
  ) => Promise<SwarmAgentRuntime>;
  allocateRuntimeToken: (agentId: string) => number;
  clearRuntimeToken: (agentId: string, runtimeToken?: number) => void;
  getRuntimeToken: (agentId: string) => number | undefined;
  getActiveTurnId: (agentId: string, runtimeToken?: number) => string | undefined;
  isSecureRuntimeBindingUsable(
    agentId: string,
    runtime: SwarmAgentRuntime,
  ): boolean;
  hasSecureRuntimeBinding(runtime: SwarmAgentRuntime): boolean;
  ensureSessionFileParentDirectory: (sessionFile: string) => Promise<void>;
  updateSessionMetaForWorkerDescriptor: (
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string
  ) => Promise<void>;
  refreshSessionMetaStatsBySessionId: (sessionAgentId: string) => Promise<void>;
  refreshSessionMetaStats: (descriptor: AgentDescriptor) => Promise<void>;
  captureSessionRuntimePromptMeta: (
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ) => Promise<void>;
  prepareManagerRuntimeCreation?: (
    descriptor: ProvisionedSessionDescriptor,
    systemPrompt: string
  ) => Promise<{
    continuityRequest?: ModelChangeContinuityRequest;
    runtimeCreationOptions?: RuntimeCreationOptions;
  }>;
  appendAppliedModelChangeContinuity?: (
    descriptor: ProvisionedSessionDescriptor,
    request: ModelChangeContinuityRequest,
    runtime: SwarmAgentRuntime
  ) => Promise<void>;
  attachRuntime: (agentId: string, runtime: SwarmAgentRuntime) => void;
  saveStore: () => Promise<void>;
  /** Manual lifecycle actions suppress the current work epoch before teardown. */
  suppressSessionAttention: (sessionAgentId: string) => Promise<void>;
  emitStatus: (
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ) => void;
  emitAgentsSnapshot: () => void;
  emitProfilesSnapshot: () => void;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
  clearWorkerHealthState: (agentId: string) => void;
  deleteWorkerStallState: (agentId: string) => void;
  deleteWorkerActivityState: (agentId: string) => void;
  clearTrackedToolPaths: (agentId: string) => void;
  suppressIntentionalStopRuntimeCallbacks: (agentId: string, runtimeToken?: number) => void;
  clearIntentionalStopRuntimeCallbackSuppression: (agentId: string, runtimeToken?: number) => void;
  allowInvalidatedManualStopMessageEnd: (agentId: string, runtimeToken?: number) => void;
  markPendingManualManagerStopNotice: (agentId: string) => void;
  emitImmediateManualManagerStopNotice: (agentId: string, text?: string) => void;
  cancelAllPendingChoicesForAgent: (agentId: string) => void;
  runRuntimeShutdown: (
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions
  ) => Promise<{ timedOut: boolean; runtimeToken?: number }>;
  prepareRuntimeShutdown: (agentId: string) => void;
  assertRuntimeCreationAllowed: (agentId: string) => void;
  detachRuntime: (agentId: string, runtimeToken?: number) => boolean;
  clearAgentTurnState: (agentId: string) => void;
  reconcileStoppedManagerRuntime: (input: {
    agentId: string;
    turnId?: string;
  }) => Promise<boolean>;
  detachRuntimeIfMatches: (
    agentId: string,
    expectedRuntime: SwarmAgentRuntime,
    runtimeToken?: number
  ) => boolean;
  syncPinnedContentForManagerRuntime: (
    descriptor: ProvisionedSessionDescriptor,
    options?: {
      runtime?: SwarmAgentRuntime;
      setPinnedContentOptions?: SetPinnedContentOptions;
    }
  ) => Promise<void>;
  interruptExternalThreadSidecarTurn?: ExternalThreadStopInterruptCallback;
  terminateExternalThreadSidecarTurn?: ExternalThreadTerminateCleanupCallback;
  sendMessage: (
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
    options?: {
      origin?: "user" | "internal";
      attachments?: ConversationAttachment[];
      planStep?: string;
      planAssignmentSource?: "spawn_agent" | "send_message_to_agent";
      requiresSecureRuntime?: boolean;
    }
  ) => Promise<SendMessageReceipt>;
  sendManagerBootstrapMessage: (managerId: string) => Promise<void>;
  materializeSortOrder: () => void;
  getSessionsForProfile: (profileId: string) => Array<AgentDescriptor & { role: "manager"; profileId: string }>;
  getWorkersForManager: (managerId: string) => AgentDescriptor[];
  deleteConversationHistory: (agentId: string, sessionFile: string) => void;
  deleteManagerSchedulesFile: (profileId: string) => Promise<void>;
  migrateLegacyProfileKnowledgeToReferenceDoc: (profileId: string) => Promise<void>;
  prepareWorkerDescriptorForSpawn?: (context: {
    callerAgentId: string;
    input: SpawnAgentInput;
    descriptor: AgentDescriptor;
    specialistId?: string;
  }) => void | Promise<void>;
}

export class SwarmAgentLifecycleService {
  constructor(private readonly options: SwarmAgentLifecycleServiceOptions) {}

  private upsertDescriptor(descriptor: AgentDescriptor): void {
    this.options.descriptorMutations.upsertDescriptor(descriptor);
  }

  private deleteDescriptor(agentId: string): void {
    this.options.descriptorMutations.deleteDescriptor(agentId);
  }

  private deleteProfile(profileId: string): void {
    this.options.descriptorMutations.deleteProfile(profileId);
  }

  private getRuntime(agentId: string): SwarmAgentRuntime | undefined {
    return this.options.getRuntime(agentId);
  }

  private getRuntimeCreationPromise(agentId: string): Promise<SwarmAgentRuntime> | undefined {
    return this.options.getRuntimeCreationPromise(agentId);
  }

  private setRuntimeCreationPromise(agentId: string, promise: Promise<SwarmAgentRuntime>): void {
    this.options.setRuntimeCreationPromise(agentId, promise);
  }

  private clearRuntimeCreationPromiseIfCurrent(agentId: string, promise: Promise<SwarmAgentRuntime>): boolean {
    return this.options.clearRuntimeCreationPromiseIfCurrent(agentId, promise);
  }

  private clearWorkerTeardownState(agentId: string): void {
    this.options.clearWorkerHealthState(agentId);
    this.options.deleteWorkerStallState(agentId);
    this.options.deleteWorkerActivityState(agentId);
    this.options.clearTrackedToolPaths(agentId);
    this.options.runtimeRecoveryState.clearRecoveryAbortedWorkerTurn(agentId);
  }

  private async interruptExternalThreadWorker(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    this.clearWorkerTeardownState(descriptor.agentId);

    const interruptSidecarTurn = this.options.interruptExternalThreadSidecarTurn;
    if (interruptSidecarTurn) {
      try {
        await interruptSidecarTurn(descriptor.agentId);
        if (descriptor.status !== "streaming") {
          return;
        }
      } catch (error) {
        this.options.logDebug("external_thread:interrupt_service_failed", {
          agentId: descriptor.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    interruptExternalThreadWorkerDescriptor(descriptor, {
      abort: options.abort,
      emitStatus: options.emitStatus,
      now: this.options.now,
      emitStatusEvent: (agentId, status, pendingCount) => {
        this.options.emitStatus(agentId, status, pendingCount);
      },
      logDebug: (message, details) => {
        this.options.logDebug(message, details);
      },
    });
    this.upsertDescriptor(descriptor);
  }

  private async cleanupExternalThreadWorkerForTermination(descriptor: AgentDescriptor): Promise<void> {
    this.clearWorkerTeardownState(descriptor.agentId);

    const terminateSidecarTurn = this.options.terminateExternalThreadSidecarTurn;
    if (!terminateSidecarTurn) {
      return;
    }

    // Cleanup-only seam for kill/delete. Do not treat this as a stop/interrupt
    // path; callers still project the descriptor to terminated immediately after.

    try {
      await terminateSidecarTurn(descriptor.agentId);
    } catch (error) {
      this.options.logDebug("external_thread:terminate_service_failed", {
        agentId: descriptor.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private invalidateManagerRuntimeBeforeWorkerTeardown(
    agentId: string,
    options?: { allowManualStopMessageEnd?: boolean }
  ): {
    runtime?: SwarmAgentRuntime;
    runtimeToken?: number;
    turnId?: string;
  } {
    this.options.prepareRuntimeShutdown(agentId);
    const runtime = this.options.runtimes.get(agentId);
    const runtimeToken = this.options.getRuntimeToken(agentId);
    const turnId = this.options.getActiveTurnId(agentId, runtimeToken);
    if (options?.allowManualStopMessageEnd) {
      this.options.allowInvalidatedManualStopMessageEnd(agentId, runtimeToken);
    }
    this.options.clearRuntimeToken(agentId);
    return { runtime, runtimeToken, turnId };
  }

  private async shutdownLatestManagerRuntime(
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    invalidatedRuntime: { runtime?: SwarmAgentRuntime; runtimeToken?: number }
  ): Promise<boolean> {
    const latestRuntime = this.options.runtimes.get(descriptor.agentId);
    if (!latestRuntime) {
      // The shutdown guard is installed before worker teardown. A manager can
      // legitimately have no attached runtime (for example, a restored idle
      // session), but the prepared guard still has to be completed so a later
      // resume is not permanently rejected as "stopping".
      const shutdown = await this.options.runRuntimeShutdown(descriptor, action, { abort: true });
      this.options.clearRuntimeToken(descriptor.agentId);
      return shutdown.timedOut;
    }

    const shutdown = await this.options.runRuntimeShutdown(descriptor, action, { abort: true });
    const runtimeToken = shutdown.runtimeToken ??
      (latestRuntime === invalidatedRuntime.runtime ? invalidatedRuntime.runtimeToken : undefined);

    if (latestRuntime === invalidatedRuntime.runtime && shutdown.runtimeToken === undefined) {
      this.options.detachRuntimeIfMatches(descriptor.agentId, latestRuntime, runtimeToken);
      return shutdown.timedOut;
    }

    this.options.detachRuntime(descriptor.agentId, runtimeToken);
    return shutdown.timedOut;
  }

  private async shutdownWorkerRuntimeWithSuppressedCallbacks(
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions
  ): Promise<boolean> {
    if (descriptor.role !== "worker" || isExternalThreadDescriptor(descriptor) || !this.options.runtimes.has(descriptor.agentId)) {
      return false;
    }

    const runtimeToken = this.options.getRuntimeToken(descriptor.agentId);
    this.options.suppressIntentionalStopRuntimeCallbacks(descriptor.agentId, runtimeToken);

    try {
      const shutdown = await this.options.runRuntimeShutdown(descriptor, action, options);
      this.options.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
      return shutdown.timedOut;
    } finally {
      this.clearWorkerTeardownState(descriptor.agentId);
      this.options.clearIntentionalStopRuntimeCallbackSuppression(descriptor.agentId, runtimeToken);
    }
  }

  async stopSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    const { terminatedWorkerIds } = await this.stopSessionInternal(agentId, {
      saveStore: true,
      emitSnapshots: true
    });

    return { terminatedWorkerIds };
  }

  async resumeSession(agentId: string): Promise<void> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);

    if (this.options.runtimes.has(agentId)) {
      throw new Error(`Session is already running: ${agentId}`);
    }

    const previousStatus = descriptor.status;
    if (descriptor.status === "error") {
      throw new Error(`Session is not resumable from error status: ${agentId}`);
    }

    if (
      descriptor.status !== "idle" &&
      descriptor.status !== "terminated" &&
      descriptor.status !== "stopped"
    ) {
      throw new Error(`Session is not resumable from status ${descriptor.status}: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
    }

    descriptor.updatedAt = this.options.now();
    this.upsertDescriptor(descriptor);

    try {
      const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);
      descriptor.contextUsage = runtime.getContextUsage();
      this.upsertDescriptor(descriptor);
    } catch (error) {
      descriptor.status = previousStatus;
      descriptor.updatedAt = this.options.now();
      this.upsertDescriptor(descriptor);
      throw error;
    }

    await this.options.saveStore();
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    const manager = this.options.assertManager(callerAgentId, "spawn agents");

    const requestedAgentId = input.agentId?.trim();
    if (!requestedAgentId) {
      throw new Error("spawn_agent requires a non-empty agentId");
    }

    const agentId = this.options.generateUniqueAgentId(requestedAgentId);
    const createdAt = this.options.now();
    const managerProfileId = manager.profileId ?? manager.agentId;
    const rawSpecialist = input.specialist?.trim();
    const requestedTier = normalizeEffortTier(input.tier);
    const rawLens = input.lens?.trim();
    let requestedLensId = rawLens ? await this.options.normalizeSpecialistHandle(rawLens) : undefined;
    const requestedRoute = input.route?.trim();
    let requestedSpecialistId: string | undefined;
    let tierSelection: { tier: EffortTier; lens?: string; legacySpecialistId?: string } | undefined;

    if (rawSpecialist) {
      requestedSpecialistId = await this.options.normalizeSpecialistHandle(rawSpecialist);
      const rewrite = requestedSpecialistId ? resolveLegacySpecialistRewrite(requestedSpecialistId) : undefined;
      if (rewrite) {
        tierSelection = {
          ...rewrite,
          legacySpecialistId: requestedSpecialistId,
        };
        requestedSpecialistId = undefined;
      }
    }

    if (input.tier !== undefined && !requestedTier) {
      throw new Error(`spawn_agent.tier must be one of ${EFFORT_TIER_ORDER.join("|")}`);
    }

    if (!tierSelection && requestedTier) {
      tierSelection = { tier: requestedTier, ...(requestedLensId ? { lens: requestedLensId } : {}) };
    } else if (tierSelection && requestedLensId) {
      tierSelection = { ...tierSelection, lens: requestedLensId };
    } else if (!tierSelection && requestedLensId && !requestedRoute) {
      tierSelection = { tier: "standard", lens: requestedLensId };
    }

    if (
      (requestedSpecialistId || tierSelection || requestedRoute) &&
      (
        input.model !== undefined ||
        input.modelId !== undefined ||
        input.systemPrompt !== undefined ||
        input.archetypeId !== undefined
      )
    ) {
      throw new Error(
        "Cannot combine specialist/route/tier mode with model, prompt, or archetype overrides."
      );
    }

    if (requestedSpecialistId && (input.tier !== undefined || requestedLensId || requestedRoute)) {
      throw new Error("Cannot combine a saved custom specialist with a roster specialist, legacy tier, or task mode.");
    }
    if (requestedRoute && input.tier !== undefined) {
      throw new Error("Cannot combine route with legacy tier selection.");
    }

    let model: AgentModelDescriptor;
    let archetypeId: string | undefined;
    let specialist: ResolvedSpecialistDefinitionLike | undefined;
    let specialistFallbackModel: AgentModelDescriptor | undefined;
    let explicitSystemPrompt: string | undefined;
    let webSearch = false;
    let selectedTierConfig: TierConfig | undefined;
    let selectedDelegationRoster: DelegationRoster | undefined;
    let selectedDelegationRoute: DelegationRoute | undefined;

    const resolveRoster = async () => this.options.resolveSpecialistRosterForManager
      ? await this.options.resolveSpecialistRosterForManager(
          manager,
          isCollabSession(manager) ? "collaboration" : "builder"
        )
      : await this.options.resolveSpecialistRosterForProfile(
          managerProfileId,
          isCollabSession(manager) ? "collaboration" : "builder"
        );

    if (requestedRoute) {
      const behaviorMode = input.behaviorMode ?? "general";
      const resolved = await resolveDelegationRoute(
        this.options.dataDir,
        manager,
        requestedRoute,
        behaviorMode,
      );
      selectedDelegationRoster = resolved.roster;
      selectedDelegationRoute = resolved.route;
      const taskBehaviorMode = requestedRoute === "auto"
        ? behaviorMode
        : selectedDelegationRoute.behaviorMode;
      if (taskBehaviorMode) {
        const specialistId = getWorkerBehaviorModeLensId(taskBehaviorMode);
        requestedLensId = specialistId
          ? await this.options.normalizeSpecialistHandle(specialistId)
          : undefined;
      }

      if (requestedLensId) {
        const roster = await resolveRoster();
        specialist = roster.find((entry) => entry.specialistId === requestedLensId);
        if (!specialist) {
          throw new Error(`Unknown lens: ${requestedLensId}. See manager system prompt for available modes.`);
        }
        if (!specialist.enabled) {
          throw new Error(`Lens "${requestedLensId}" is disabled for this profile. Enable it before spawning.`);
        }
        if (!specialist.available && !isBuiltinModePromptId(requestedLensId)) {
          const reason = specialist.availabilityMessage?.trim()
            || specialist.availabilityCode
            || "unavailable with current auth/configuration";
          throw new Error(`Lens "${requestedLensId}" is currently unavailable: ${reason}`);
        }
      }

      model = {
        provider: selectedDelegationRoute.provider,
        modelId: selectedDelegationRoute.modelId,
        thinkingLevel: selectedDelegationRoute.reasoningLevel,
      };
      model.thinkingLevel = normalizeThinkingLevelForModelDescriptor(model);
      const routePrimaryCapacityBlocked = Boolean(
        this.getActiveModelCapacityBlock(model.provider, model.modelId),
      );

      if (selectedDelegationRoute.availabilityFallback) {
        specialistFallbackModel = {
          provider: selectedDelegationRoute.availabilityFallback.provider,
          modelId: selectedDelegationRoute.availabilityFallback.modelId,
          thinkingLevel: selectedDelegationRoute.availabilityFallback.reasoningLevel,
        };
        specialistFallbackModel.thinkingLevel =
          normalizeThinkingLevelForModelDescriptor(specialistFallbackModel);
      }
      model = routePrimaryCapacityBlocked && specialistFallbackModel
        ? { ...specialistFallbackModel }
        : this.resolveSpawnModelWithCapacityFallback(model);

      archetypeId = undefined;
      explicitSystemPrompt = undefined;
      if (specialist?.webSearch) webSearch = true;
    } else if (tierSelection) {
      let tierConfig = await resolveTierConfig(this.options.dataDir, tierSelection.tier);
      selectedTierConfig = tierConfig;
      const roster = this.options.resolveSpecialistRosterForManager
        ? await this.options.resolveSpecialistRosterForManager(
            manager,
            isCollabSession(manager) ? "collaboration" : "builder"
          )
        : await this.options.resolveSpecialistRosterForProfile(
            managerProfileId,
            isCollabSession(manager) ? "collaboration" : "builder"
          );
      const lensId = tierSelection.lens;
      if (lensId) {
        specialist = roster.find((entry) => entry.specialistId === lensId);
        if (!specialist) {
          throw new Error(
            `Unknown lens: ${lensId}. See manager system prompt for available lenses.`
          );
        }
        if (!specialist.enabled) {
          throw new Error(`Lens "${lensId}" is disabled for this profile. Enable it before spawning.`);
        }
        if (
          !specialist.available &&
          !(input.policyControlledModel === true && isBuiltinModePromptId(lensId))
        ) {
          const reason =
            specialist.availabilityMessage?.trim() ||
            (specialist.availabilityCode
              ? `availability code: ${specialist.availabilityCode}`
              : "unavailable with current auth/configuration");
          throw new Error(`Lens "${lensId}" is currently unavailable: ${reason}`);
        }
        if (!input.tier && !tierSelection.legacySpecialistId && specialist.defaultTier) {
          tierSelection = { ...tierSelection, tier: specialist.defaultTier };
          tierConfig = await resolveTierConfig(this.options.dataDir, specialist.defaultTier);
          selectedTierConfig = tierConfig;
        }
      }

      // New mode + policy delegation lets the policy exclusively own model,
      // reasoning, and fallback. Legacy direct specialist/tier calls retain
      // their saved model behavior for compatibility.
      const modelConfig = input.policyControlledModel === true || !specialist?.modelId
        ? tierConfig
        : {
            provider: specialist.provider || inferProviderFromModelId(specialist.modelId),
            modelId: specialist.modelId,
            reasoningLevel: specialist.reasoningLevel,
            fallbackModelId: specialist.fallbackModelId,
            fallbackProvider: specialist.fallbackProvider,
            fallbackReasoningLevel: specialist.fallbackReasoningLevel,
          };
      if (!modelConfig.provider) {
        throw new Error(`Tier "${tierSelection.tier}" has an unknown modelId provider mapping: ${modelConfig.modelId}`);
      }

      const reasoningLevelOverride = parseSwarmReasoningLevel(
        input.reasoningLevel,
        "spawn_agent.reasoningLevel"
      );
      model = {
        provider: modelConfig.provider,
        modelId: modelConfig.modelId,
        thinkingLevel: reasoningLevelOverride
          ?? modelConfig.reasoningLevel
          ?? getDefaultReasoningLevelForModel(modelConfig.provider, modelConfig.modelId),
      };
      model.thinkingLevel = normalizeThinkingLevelForModelDescriptor(model);
      model = this.resolveSpawnModelWithCapacityFallback(model);

      if (modelConfig.fallbackModelId) {
        const inferredFallbackProvider = modelConfig.fallbackProvider || inferProviderFromModelId(modelConfig.fallbackModelId);
        if (inferredFallbackProvider) {
          specialistFallbackModel = {
            provider: inferredFallbackProvider,
            modelId: modelConfig.fallbackModelId,
            thinkingLevel: modelConfig.fallbackReasoningLevel ?? model.thinkingLevel
          };
          specialistFallbackModel.thinkingLevel = normalizeThinkingLevelForModelDescriptor(specialistFallbackModel);
          specialistFallbackModel = this.resolveSpawnModelWithCapacityFallback(specialistFallbackModel);
        }
      }

      archetypeId = undefined;
      // Resolve the prompt after descriptor attribution so shipped behavior
      // modes receive the stable worker core while custom specialists remain
      // standalone.
      explicitSystemPrompt = undefined;
      if (specialist?.webSearch) {
        webSearch = true;
      }
    } else if (requestedSpecialistId) {
      const roster = await resolveRoster();
      specialist = roster.find((entry) => entry.specialistId === requestedSpecialistId);
      if (!specialist) {
        throw new Error(
          `Unknown specialist: ${requestedSpecialistId}. See manager system prompt for available specialists.`
        );
      }

      if (!specialist.enabled) {
        throw new Error(
          `Specialist "${requestedSpecialistId}" is disabled for this profile. Enable it before spawning.`
        );
      }

      if (!specialist.available) {
        const reason =
          specialist.availabilityMessage?.trim() ||
          (specialist.availabilityCode
            ? `availability code: ${specialist.availabilityCode}`
            : "unavailable with current auth/configuration");
        throw new Error(`Specialist "${requestedSpecialistId}" is currently unavailable: ${reason}`);
      }

      if (!specialist.modelId) {
        const tier = specialist.defaultTier ?? "standard";
        tierSelection = { tier, lens: specialist.specialistId, legacySpecialistId: requestedSpecialistId };
        const tierConfig = await resolveTierConfig(this.options.dataDir, tier);
        selectedTierConfig = tierConfig;
        const reasoningLevelOverride = parseSwarmReasoningLevel(
          input.reasoningLevel,
          "spawn_agent.reasoningLevel"
        );
        model = {
          provider: tierConfig.provider,
          modelId: tierConfig.modelId,
          thinkingLevel: reasoningLevelOverride ?? tierConfig.reasoningLevel ?? "xhigh",
        };
        model.thinkingLevel = normalizeThinkingLevelForModelDescriptor(model);
        model = this.resolveSpawnModelWithCapacityFallback(model);
        if (tierConfig.fallbackModelId) {
          specialistFallbackModel = {
            provider: tierConfig.fallbackProvider ?? inferProviderFromModelId(tierConfig.fallbackModelId) ?? tierConfig.provider,
            modelId: tierConfig.fallbackModelId,
            thinkingLevel: tierConfig.fallbackReasoningLevel ?? model.thinkingLevel,
          };
          specialistFallbackModel.thinkingLevel = normalizeThinkingLevelForModelDescriptor(specialistFallbackModel);
          specialistFallbackModel = this.resolveSpawnModelWithCapacityFallback(specialistFallbackModel);
        }
        archetypeId = undefined;
        explicitSystemPrompt = specialist.promptBody;
        if (specialist.webSearch) {
          webSearch = true;
        }
      } else {
        const inferredProvider = specialist.provider || inferProviderFromModelId(specialist.modelId);
        if (!inferredProvider) {
        throw new Error(
          `Specialist "${requestedSpecialistId}" has an unknown modelId provider mapping: ${specialist.modelId}`
        );
      }

        const reasoningLevelOverride = parseSwarmReasoningLevel(
        input.reasoningLevel,
        "spawn_agent.reasoningLevel"
      );

        const defaultReasoningLevel = getDefaultReasoningLevelForModel(
          inferredProvider,
          specialist.modelId,
        );

        model = {
        provider: inferredProvider,
        modelId: specialist.modelId,
        thinkingLevel: reasoningLevelOverride ?? specialist.reasoningLevel ?? defaultReasoningLevel
      };
        model.thinkingLevel = normalizeThinkingLevelForModelDescriptor(model);
        model = this.resolveSpawnModelWithCapacityFallback(model);

        if (specialist.fallbackModelId) {
        const inferredFallbackProvider = specialist.fallbackProvider || inferProviderFromModelId(specialist.fallbackModelId);
        if (inferredFallbackProvider) {
          specialistFallbackModel = {
            provider: inferredFallbackProvider,
            modelId: specialist.fallbackModelId,
            thinkingLevel: specialist.fallbackReasoningLevel ?? model.thinkingLevel
          };
          specialistFallbackModel.thinkingLevel = normalizeThinkingLevelForModelDescriptor(specialistFallbackModel);
          specialistFallbackModel = this.resolveSpawnModelWithCapacityFallback(specialistFallbackModel);
        }
      }

        archetypeId = undefined;
        explicitSystemPrompt = specialist.promptBody;
      }
    } else {
      const requestedModel = this.resolveSpawnModel(input, manager.model);
      model = this.resolveSpawnModelWithCapacityFallback(requestedModel);
      archetypeId = await this.options.resolveSpawnWorkerArchetypeId(input, agentId, managerProfileId);
      explicitSystemPrompt = input.systemPrompt?.trim();
      webSearch = input.webSearch === true;
    }

    if (
      input.requiresSecureRuntime
      && !supportsSecureRuntimeProvider(model.provider)
    ) {
      if (
        specialistFallbackModel
        && supportsSecureRuntimeProvider(specialistFallbackModel.provider)
      ) {
        model = { ...specialistFallbackModel };
        specialistFallbackModel = undefined;
      } else {
        throw new Error(SECURE_RUNTIME_PROVIDER_UNSUPPORTED_MESSAGE);
      }
    }

    const descriptor: AgentDescriptor = {
      agentId,
      displayName: agentId,
      role: "worker",
      managerId: manager.agentId,
      profileId: manager.profileId ?? manager.agentId,
      archetypeId,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: input.cwd ? await this.options.resolveAndValidateCwd(input.cwd) : manager.cwd,
      model,
      sessionFile: getWorkerSessionFilePath(
        this.options.dataDir,
        manager.profileId ?? manager.agentId,
        manager.agentId,
        agentId
      ),
      // New workers have explicit current attribution; legacy descriptors that
      // lack this field remain unknown when historical records are scanned.
      specialistAttributionKnown: true,
      ...(webSearch ? { webSearch: true } : {})
    };

    if (tierSelection) {
      const tierDisplayName = getDelegationTierDisplayName(
        tierSelection.tier,
        selectedTierConfig?.displayName ?? DEFAULT_TIER_CONFIGS[tierSelection.tier].displayName,
      );
      descriptor.specialistTier = tierSelection.tier;
      if (tierSelection.lens) {
        descriptor.specialistLens = tierSelection.lens;
      }
      descriptor.specialistId = getTierAttributionId(tierSelection.tier, tierSelection.lens);
      descriptor.specialistDisplayName = specialist
        ? `${tierDisplayName} — ${specialist.displayName}`
        : tierDisplayName;
      descriptor.specialistColor = specialist?.color ?? selectedTierConfig?.color ?? DEFAULT_TIER_CONFIGS[tierSelection.tier].color;
      if (specialist?.webSearch) {
        descriptor.webSearch = true;
      }
    } else if (selectedDelegationRoster && selectedDelegationRoute) {
      descriptor.delegationRosterId = selectedDelegationRoster.rosterId;
      descriptor.delegationRosterRevision = selectedDelegationRoster.revision;
      descriptor.delegationRouteId = selectedDelegationRoute.routeId;
      descriptor.delegationRouteLabel = selectedDelegationRoute.label;
      if (requestedLensId) {
        descriptor.specialistLens = requestedLensId;
      }
      descriptor.specialistId = `route:${selectedDelegationRoute.routeId}`;
      descriptor.specialistDisplayName = selectedDelegationRoute.label;
      descriptor.specialistColor = selectedDelegationRoute.color ?? "#7c3aed";
      if (specialistFallbackModel) {
        descriptor.delegationFallbackModel = { ...specialistFallbackModel };
      }
      if (selectedDelegationRoute.capabilityEscalationRouteId) {
        descriptor.delegationCapabilityEscalationRouteId =
          selectedDelegationRoute.capabilityEscalationRouteId;
      }
      if (specialist?.webSearch) descriptor.webSearch = true;
    } else if (specialist) {
      descriptor.specialistId = specialist.specialistId;
      descriptor.specialistDisplayName = specialist.displayName;
      descriptor.specialistColor = specialist.color;
      if (specialist.webSearch) {
        descriptor.webSearch = true;
      }
    }

    await this.options.prepareWorkerDescriptorForSpawn?.({
      callerAgentId,
      input,
      descriptor,
      specialistId: specialist?.specialistId,
    });

    this.upsertDescriptor(descriptor);
    await this.options.ensureSessionFileParentDirectory(descriptor.sessionFile);
    await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
    await this.options.saveStore();
    this.options.emitAgentsSnapshot();

    this.options.logDebug("agent:spawn", {
      callerAgentId,
      agentId,
      managerId: descriptor.managerId,
      displayName: descriptor.displayName,
      archetypeId: descriptor.archetypeId,
      specialistId: descriptor.specialistId,
      model: descriptor.model,
      cwd: descriptor.cwd
    });

    let secureWorkerPrepared = false;
    try {
      secureWorkerPrepared =
        await this.options.secureWorkers.prepareWorkerForSecureTeam(agentId);
      if (input.requiresSecureRuntime && !secureWorkerPrepared) {
        throw new Error(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
      }
      if (secureWorkerPrepared) {
        this.options.emitStatus(agentId, descriptor.status, 0);
        this.options.emitAgentsSnapshot();
      } else {
        const baseSystemPrompt =
          explicitSystemPrompt && explicitSystemPrompt.length > 0
            ? explicitSystemPrompt
            : await this.options.resolveSystemPromptForDescriptor(descriptor);

        const runtimeSystemPrompt = this.options.injectWorkerIdentityContext(descriptor, baseSystemPrompt);

        let runtime: SwarmAgentRuntime;
        try {
          runtime = await this.options.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);
        } catch (error) {
          if (specialistFallbackModel && shouldRetrySpecialistSpawnWithFallback(error, descriptor.model)) {
            const previousModel = { ...descriptor.model };
            descriptor.model = { ...specialistFallbackModel };
            this.upsertDescriptor(descriptor);
            await this.options.saveStore();

            this.options.logDebug("agent:spawn:specialist_fallback_retry", {
              agentId,
              specialistId: specialist?.specialistId,
              previousModel,
              fallbackModel: descriptor.model,
              error: error instanceof Error ? error.message : String(error)
            });

            runtime = await this.options.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);
          } else {
            throw error;
          }
        }

        this.options.attachRuntime(agentId, runtime);

        const persistedSystemPrompt = runtime.getSystemPrompt?.() ?? runtimeSystemPrompt;
        const contextUsage = runtime.getContextUsage();
        descriptor.contextUsage = contextUsage;
        this.upsertDescriptor(descriptor);
        await this.options.updateSessionMetaForWorkerDescriptor(descriptor, persistedSystemPrompt);
        await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);

        this.options.emitStatus(agentId, descriptor.status, runtime.getPendingCount(), contextUsage);
        this.options.emitAgentsSnapshot();
      }
    } catch (error) {
      try {
        if (this.options.runtimes.has(agentId)) {
          const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: true });
          this.options.detachRuntime(agentId, shutdown.runtimeToken);
        }
      } catch (shutdownError) {
        this.options.logDebug("agent:spawn:rollback_runtime_error", {
          agentId,
          error: String(shutdownError)
        });
      }

      this.options.clearWorkerHealthState(agentId);
      this.options.deleteWorkerStallState(agentId);
      this.options.deleteWorkerActivityState(agentId);
      this.options.clearAgentTurnState(agentId);

      this.deleteDescriptor(agentId);
      this.options.emitAgentsSnapshot();
      await this.options.saveStore();

      try {
        await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
      } catch (metaError) {
        this.options.logDebug("agent:spawn:rollback_meta_error", {
          agentId,
          managerId: descriptor.managerId,
          error: String(metaError)
        });
      }

      throw error;
    }

    if (input.initialMessage && input.initialMessage.trim().length > 0) {
      await this.options.sendMessage(callerAgentId, agentId, input.initialMessage, "auto", {
        origin: "internal",
        ...(input.planStep ? { planStep: input.planStep } : {}),
        planAssignmentSource: "spawn_agent",
        ...(input.requiresSecureRuntime
          ? { requiresSecureRuntime: true }
          : {}),
      });
    }

    return cloneDescriptor(descriptor);
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    const manager = this.options.assertManager(callerAgentId, "kill agents");

    const target = this.options.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown agent: ${targetAgentId}`);
    }
    if (target.role === "manager") {
      throw new Error("Manager cannot be killed");
    }

    if (target.managerId !== manager.agentId) {
      throw new Error(`Only owning manager can kill agent ${targetAgentId}`);
    }

    await this.options.suppressSessionAttention(manager.agentId);
    let cleanupFailure: unknown;
    try {
      await this.terminateDescriptor(target, {
        abort: true,
        emitStatus: false,
      });
    } catch (error) {
      cleanupFailure = error;
    }
    await this.options.saveStore();

    this.options.logDebug("agent:kill", {
      callerAgentId,
      targetAgentId,
      managerId: manager.agentId
    });

    const refreshedTarget = this.options.descriptors.get(targetAgentId) ?? target;
    this.options.emitStatus(targetAgentId, refreshedTarget.status, 0);
    this.options.emitAgentsSnapshot();
    if (cleanupFailure) {
      throw cleanupFailure instanceof Error
        ? cleanupFailure
        : new Error("agent_cleanup_failed");
    }
  }

  async stopWorker(agentId: string): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      throw new Error(`Unknown worker agent: ${agentId}`);
    }

    await this.stopWorkerRuntime(
      descriptor as AgentDescriptor & { role: "worker" },
    );
  }

  private async stopWorkerRuntime(
    descriptor: AgentDescriptor & { role: "worker" },
  ): Promise<void> {
    const agentId = descriptor.agentId;
    if (isExternalThreadDescriptor(descriptor)) {
      if (!shouldInterruptExternalThreadSidecar(descriptor)) {
        return;
      }

      await this.options.suppressSessionAttention(descriptor.managerId);
      await this.interruptExternalThreadWorker(descriptor, { abort: true, emitStatus: true });
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
      await this.options.saveStore();
      this.options.emitAgentsSnapshot();
      return;
    }

    await this.options.suppressSessionAttention(descriptor.managerId);
    this.clearWorkerTeardownState(agentId);
    const shutdownTimedOut = await this.shutdownWorkerRuntimeWithSuppressedCallbacks(
      descriptor,
      "terminate",
      { abort: true },
    );
    this.clearWorkerTeardownState(agentId);

    descriptor.status = shutdownTimedOut
      ? "stopped"
      : transitionAgentStatus(descriptor.status, "idle");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.options.now();
    this.upsertDescriptor(descriptor);

    await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
    await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    await this.options.saveStore();

    this.options.emitStatus(agentId, descriptor.status, 0);
    this.options.emitAgentsSnapshot();
    if (shutdownTimedOut) {
      this.options.emitImmediateManualManagerStopNotice(
        descriptor.managerId,
        formatWorkerStopTimeoutNotice([descriptor.agentId]),
      );
    }
  }

  async resumeWorker(agentId: string): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      throw new Error(`Unknown worker agent: ${agentId}`);
    }

    if (isExternalThreadDescriptor(descriptor)) {
      throw new Error(`External-thread sidecar does not use Forge runtime resume: ${agentId}`);
    }

    if (this.options.runtimes.has(agentId)) {
      throw new Error(`Worker is already running: ${agentId}`);
    }

    const previousStatus = descriptor.status;
    if (descriptor.status === "error") {
      throw new Error(`Worker is not resumable from error status: ${agentId}`);
    }

    if (
      descriptor.status !== "idle" &&
      descriptor.status !== "terminated" &&
      descriptor.status !== "stopped"
    ) {
      throw new Error(`Worker is not resumable from status ${descriptor.status}: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
    }

    descriptor.updatedAt = this.options.now();
    this.upsertDescriptor(descriptor);

    try {
      const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);
      descriptor.contextUsage = runtime.getContextUsage();
      this.upsertDescriptor(descriptor);
    } catch (error) {
      descriptor.status = previousStatus;
      descriptor.updatedAt = this.options.now();
      this.upsertDescriptor(descriptor);
      throw error;
    }

    await this.options.saveStore();
    this.options.emitAgentsSnapshot();
  }

  async stopAllAgents(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{
    managerId: string;
    stoppedWorkerIds: string[];
    managerStopped: boolean;
    terminatedWorkerIds: string[];
    managerTerminated: boolean;
  }> {
    const manager = this.options.assertManager(callerAgentId, "stop all agents");

    const target = this.options.descriptors.get(targetManagerId);
    if (!target || target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    if (target.agentId !== manager.agentId) {
      throw new Error(`Only selected manager can stop all agents for ${targetManagerId}`);
    }

    await this.options.suppressSessionAttention(target.agentId);
    const stoppedWorkerIds: string[] = [];
    const workerShutdownTimeoutIds: string[] = [];
    const managerRuntime = this.options.runtimes.get(target.agentId);
    const shouldAllowManualStopMessageEnd =
      managerRuntime !== undefined && (target.status === "streaming" || managerRuntime.getStatus() === "streaming");
    if (shouldAllowManualStopMessageEnd) {
      this.options.markPendingManualManagerStopNotice(target.agentId);
    }

    this.options.cancelAllPendingChoicesForAgent(targetManagerId);
    const invalidatedManagerRuntime = this.invalidateManagerRuntimeBeforeWorkerTeardown(target.agentId, {
      allowManualStopMessageEnd: shouldAllowManualStopMessageEnd
    });

    for (const descriptor of Array.from(this.options.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }

      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      if (isExternalThreadDescriptor(descriptor)) {
        if (!shouldInterruptExternalThreadSidecar(descriptor)) {
          continue;
        }

        await this.interruptExternalThreadWorker(descriptor, { abort: true, emitStatus: true });
        await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
        stoppedWorkerIds.push(descriptor.agentId);
        continue;
      }

      this.clearWorkerTeardownState(descriptor.agentId);

      if (isNonRunningAgentStatus(descriptor.status)) {
        continue;
      }

      const shutdownTimedOut = await this.shutdownWorkerRuntimeWithSuppressedCallbacks(
        descriptor,
        "stopInFlight",
        { abort: true },
      );
      this.clearWorkerTeardownState(descriptor.agentId);

      descriptor.status = shutdownTimedOut
        ? "stopped"
        : transitionAgentStatus(descriptor.status, "idle");
      descriptor.contextUsage = undefined;
      descriptor.updatedAt = this.options.now();
      this.upsertDescriptor(descriptor);
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      this.options.emitStatus(descriptor.agentId, descriptor.status, 0, descriptor.contextUsage);

      stoppedWorkerIds.push(descriptor.agentId);
      if (shutdownTimedOut) {
        workerShutdownTimeoutIds.push(descriptor.agentId);
      }
    }

    if (workerShutdownTimeoutIds.length > 0) {
      this.options.emitImmediateManualManagerStopNotice(
        target.agentId,
        formatWorkerStopTimeoutNotice(workerShutdownTimeoutIds),
      );
    }

    let managerStopped = false;
    let managerShutdownTimedOut = false;
    if (!isNonRunningAgentStatus(target.status)) {
      if (shouldAllowManualStopMessageEnd) {
        this.options.markPendingManualManagerStopNotice(target.agentId);
        this.options.allowInvalidatedManualStopMessageEnd(target.agentId, invalidatedManagerRuntime.runtimeToken);
      }
      managerShutdownTimedOut = await this.shutdownLatestManagerRuntime(
        target,
        "stopInFlight",
        invalidatedManagerRuntime,
      );

      if (managerShutdownTimedOut) {
        this.options.emitImmediateManualManagerStopNotice(
          target.agentId,
          MANUAL_MANAGER_STOP_TIMEOUT_NOTICE,
        );
      }

      target.status = transitionAgentStatus(target.status, "idle");
      target.contextUsage = undefined;
      target.updatedAt = this.options.now();
      this.upsertDescriptor(target);
      this.options.emitStatus(target.agentId, target.status, 0, target.contextUsage);
      managerStopped = true;
    }

    if (!managerShutdownTimedOut) {
      await this.options.reconcileStoppedManagerRuntime({
        agentId: target.agentId,
        turnId: invalidatedManagerRuntime.turnId,
      });
    }

    if (
      !shouldAllowManualStopMessageEnd &&
      !managerShutdownTimedOut &&
      workerShutdownTimeoutIds.length === 0 &&
      (stoppedWorkerIds.length > 0 || managerRuntime !== undefined)
    ) {
      this.options.emitImmediateManualManagerStopNotice(target.agentId);
    }

    await this.options.refreshSessionMetaStatsBySessionId(targetManagerId);
    await this.options.saveStore();
    this.options.emitAgentsSnapshot();

    this.options.logDebug("manager:stop_all", {
      callerAgentId,
      targetManagerId,
      stoppedWorkerIds,
      managerStopped
    });

    return {
      managerId: targetManagerId,
      stoppedWorkerIds,
      managerStopped,
      terminatedWorkerIds: stoppedWorkerIds,
      managerTerminated: managerStopped
    };
  }

  async createManager(
    callerAgentId: string,
    input: { name: string; cwd: string; model?: SwarmModelPreset; modelSelection?: ManagerExactModelSelection; reasoningLevel?: SwarmReasoningLevel }
  ): Promise<AgentDescriptor> {
    const callerDescriptor = this.options.descriptors.get(callerAgentId);
    if (!callerDescriptor || callerDescriptor.role !== "manager") {
      const canBootstrap = !this.options.hasRunningManagers({ excludeCortex: true });
      if (!canBootstrap) {
        throw new Error("Only manager can create managers");
      }
    } else if (isNonRunningAgentStatus(callerDescriptor.status)) {
      throw new Error(`Manager is not running: ${callerAgentId}`);
    }

    const requestedName = input.name?.trim();
    if (!requestedName) {
      throw new Error("create_manager requires a non-empty name");
    }

    const normalizedRequestedName = normalizeAgentId(requestedName);
    if (normalizedRequestedName === CORTEX_PROFILE_ID) {
      throw new Error('The manager name "cortex" is reserved');
    }

    if (input.model !== undefined && input.modelSelection !== undefined) {
      throw new Error("create_manager.model and create_manager.modelSelection are mutually exclusive");
    }

    const requestedModelPreset = parseSwarmModelPreset(input.model, "create_manager.model");
    const requestedReasoningLevel = parseSwarmReasoningLevel(input.reasoningLevel, "create_manager.reasoningLevel");
    const managerId = this.options.generateUniqueManagerId(requestedName);
    const createdAt = this.options.now();
    const cwd = await this.options.resolveAndValidateCwd(input.cwd);

    const initialModel = requestedModelPreset
      ? resolveModelDescriptorFromPreset(requestedModelPreset)
      : input.modelSelection
        ? resolveExactManagerModelSelection(input.modelSelection, {
            surface: "create",
            providerAvailability: await this.options.getManagedModelProviderAvailability(),
            reasoningLevel: requestedReasoningLevel,
          })
        : this.options.resolveDefaultModelDescriptor();

    if (!input.modelSelection) {
      initialModel.thinkingLevel = normalizeThinkingLevelForModelDescriptor(initialModel, requestedReasoningLevel);
    }

    const descriptor: AgentDescriptor = {
      agentId: managerId,
      displayName: managerId,
      role: "manager",
      managerId,
      profileId: managerId,
      archetypeId: MANAGER_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd,
      model: { ...initialModel },
      modelOrigin: "profile_default",
      sessionFile: getSessionFilePath(this.options.dataDir, managerId, managerId)
    };

    this.options.materializeSortOrder();

    for (const existingProfile of this.options.profiles.values()) {
      existingProfile.sortOrder = (existingProfile.sortOrder ?? 0) + 1;
      this.options.descriptorMutations.upsertProfile(existingProfile);
    }

    const profile: ManagerProfile = {
      profileId: descriptor.agentId,
      displayName: descriptor.displayName,
      defaultSessionAgentId: descriptor.agentId,
      defaultModel: { ...initialModel },
      createdAt: descriptor.createdAt,
      updatedAt: descriptor.createdAt,
      sortOrder: 0
    };

    let runtime: SwarmAgentRuntime | undefined;
    let persistedSystemPrompt: string | undefined;
    await this.options.sessionProvisioner.provisionSession({
      descriptor: descriptor as AgentDescriptor & { role: "manager"; profileId: string },
      profile,
      ensureProfilePiDirectories: true,
      initializeRuntime: async () => {
        const systemPrompt = await this.options.resolveSystemPromptForDescriptor(descriptor);
        runtime = await this.options.createRuntimeForDescriptor(descriptor, systemPrompt);
        this.options.attachRuntime(managerId, runtime);
        persistedSystemPrompt = runtime.getSystemPrompt?.() ?? systemPrompt;
      }
    });

    const contextUsage = runtime?.getContextUsage();
    descriptor.contextUsage = contextUsage;
    this.upsertDescriptor(descriptor);

    await this.options.captureSessionRuntimePromptMeta(descriptor, persistedSystemPrompt);
    await this.options.refreshSessionMetaStats(descriptor);
    await this.options.migrateLegacyProfileKnowledgeToReferenceDoc(profile.profileId);
    await this.options.saveStore();

    this.options.emitStatus(managerId, descriptor.status, runtime?.getPendingCount() ?? 0, contextUsage);
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    this.options.logDebug("manager:create", {
      callerAgentId,
      managerId,
      cwd: descriptor.cwd
    });

    await this.options.sendManagerBootstrapMessage(managerId);

    return cloneDescriptor(descriptor);
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    this.options.assertManager(callerAgentId, "delete managers");

    const profile = this.options.profiles.get(targetManagerId);
    const sessionDescriptors = profile ? this.options.getSessionsForProfile(profile.profileId) : [];

    if (sessionDescriptors.length === 0) {
      const target = this.options.descriptors.get(targetManagerId);
      if (!target || target.role !== "manager") {
        throw new Error(`Unknown manager: ${targetManagerId}`);
      }
      sessionDescriptors.push(target as ProvisionedSessionDescriptor);
    }

    if (sessionDescriptors.some((descriptor) => normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID)) {
      throw new Error("Cortex manager cannot be deleted");
    }

    const terminatedWorkerIds: string[] = [];
    const workerDescriptors: AgentDescriptor[] = [];
    const terminationFailures: unknown[] = [];

    // Delete/terminate is explicit lifecycle suppression, not a completed work
    // epoch. Retire before direct status mutations can look quiescent.
    for (const sessionDescriptor of sessionDescriptors) {
      await this.options.suppressSessionAttention(sessionDescriptor.agentId);
    }

    for (const sessionDescriptor of sessionDescriptors) {
      for (const workerDescriptor of this.options.getWorkersForManager(sessionDescriptor.agentId)) {
        terminatedWorkerIds.push(workerDescriptor.agentId);
        workerDescriptors.push(workerDescriptor);
        try {
          await this.terminateDescriptor(workerDescriptor, {
            abort: true,
            emitStatus: true,
          });
        } catch (error) {
          terminationFailures.push(error);
        }
      }

      try {
        await this.terminateDescriptor(sessionDescriptor, {
          abort: true,
          emitStatus: true,
        });
      } catch (error) {
        terminationFailures.push(error);
      }
    }

    if (terminationFailures.length > 0) {
      await this.options.saveStore();
      this.options.emitAgentsSnapshot();
      this.options.emitProfilesSnapshot();
      throw new AggregateError(
        terminationFailures,
        `agent_cleanup_failed: ${targetManagerId}`,
      );
    }

    for (const workerDescriptor of workerDescriptors) {
      this.deleteDescriptor(workerDescriptor.agentId);
      this.options.deleteConversationHistory(
        workerDescriptor.agentId,
        workerDescriptor.sessionFile,
      );
    }
    for (const sessionDescriptor of sessionDescriptors) {
      this.deleteDescriptor(sessionDescriptor.agentId);
      this.options.deleteConversationHistory(sessionDescriptor.agentId, sessionDescriptor.sessionFile);
    }

    if (profile) {
      this.deleteProfile(profile.profileId);
    } else {
      this.deleteProfile(targetManagerId);
    }

    const schedulesProfileId = profile?.profileId ?? sessionDescriptors[0]?.profileId ?? targetManagerId;
    await this.options.deleteManagerSchedulesFile(schedulesProfileId);

    await this.options.saveStore();
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    this.options.logDebug("manager:delete", {
      callerAgentId,
      targetManagerId,
      terminatedWorkerIds
    });

    return { managerId: targetManagerId, terminatedWorkerIds };
  }

  async notifySpecialistRosterChanged(profileId: string, options?: { sessionAgentId?: string }): Promise<void> {
    try {
      await this.syncWorkerSpecialistMetadataForProfile(profileId, options?.sessionAgentId);
    } catch (error) {
      this.options.logDebug("specialist:roster_change:sync:error", {
        profileId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const sessions = options?.sessionAgentId
      ? this.options.getSessionsForProfile(profileId).filter((session) => session.agentId === options.sessionAgentId)
      : this.options.getSessionsForProfile(profileId);
    const results = await Promise.allSettled(
      sessions.map((session) => this.applyManagerRuntimeRecyclePolicy(session.agentId, "specialist_roster_change")),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.options.logDebug("specialist:roster_change:recycle:error", {
          profileId,
          agentId: sessions[index]?.agentId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  async reconcileWorkerSpecialistMetadataForBoot(): Promise<void> {
    const profileIds = new Set(this.options.profiles.keys());
    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.profileId) {
        profileIds.add(descriptor.profileId);
      }
    }

    for (const profileId of profileIds) {
      try {
        await this.syncWorkerSpecialistMetadataForProfile(profileId, undefined, {
          persist: false,
          publish: false,
        });
      } catch (error) {
        this.options.logDebug("specialist:boot_metadata_sync:error", {
          profileId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async syncWorkerSpecialistMetadataForProfile(
    profileId: string,
    sessionAgentId?: string,
    options?: { persist?: boolean; publish?: boolean },
  ): Promise<void> {
    if (sessionAgentId) {
      const manager = this.options.descriptors.get(sessionAgentId);
      const roster = manager && this.options.resolveSpecialistRosterForManager
        ? await this.options.resolveSpecialistRosterForManager(manager, "collaboration")
        : [];
      await this.syncWorkerSpecialistMetadata(profileId, roster, sessionAgentId, options);
      return;
    }

    if (this.options.resolveSpecialistRosterForManager) {
      const sessions = this.options.getSessionsForProfile(profileId);
      await Promise.all(sessions.map(async (manager) => {
        const targetSpace = isCollabSession(manager) ? "collaboration" : "builder";
        const roster = await this.options.resolveSpecialistRosterForManager!(manager, targetSpace);
        await this.syncWorkerSpecialistMetadata(profileId, roster, manager.agentId, options);
      }));
      return;
    }

    const [builderRoster, collaborationRoster] = await Promise.all([
      this.options.resolveSpecialistRosterForProfile(profileId, "builder"),
      this.options.resolveSpecialistRosterForProfile(profileId, "collaboration"),
    ]);
    await this.syncWorkerSpecialistMetadata(profileId, [...builderRoster, ...collaborationRoster], undefined, options);
  }

  async notifyProjectAgentsChanged(profileId: string): Promise<void> {
    const sessions = this.options.getSessionsForProfile(profileId);
    const results = await Promise.allSettled(
      sessions.map((session) => this.applyManagerRuntimeRecyclePolicy(session.agentId, "project_agent_directory_change")),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.options.logDebug("project_agents:directory_change:recycle:error", {
          profileId,
          agentId: sessions[index]?.agentId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  shouldRestoreRuntimeForDescriptor(descriptor: AgentDescriptor): boolean {
    if (isExternalThreadDescriptor(descriptor)) {
      return false;
    }

    return descriptor.status === "streaming";
  }

  async getOrCreateRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    requirements?: RuntimeAcquisitionRequirements,
  ): Promise<SwarmAgentRuntime> {
    assertForgeRuntimeEligibleDescriptor(descriptor, "get or create runtime");
    this.options.assertRuntimeCreationAllowed(descriptor.agentId);

    if (
      descriptor.role === "worker"
      && requirements?.secureRuntimeRequired === true
      && this.options.runtimeRecoveryState.hasPendingManagerRuntimeRecycle(
        descriptor.agentId,
      )
    ) {
      // Team Secure Mode may begin while this worker is finishing an ordinary
      // turn. Apply that deferred runtime boundary before the next assignment
      // can reuse the worker; the secure requirement below remains fail-closed
      // if the worker has not actually become idle yet.
      await this.applyAgentRuntimeRecyclePolicy(
        descriptor.agentId,
        "idle_transition",
      );
    }

    const inFlightCreation = this.getRuntimeCreationPromise(descriptor.agentId);
    if (inFlightCreation) {
      return this.assertRuntimeMeetsCreationRequirements(
        descriptor.agentId,
        await inFlightCreation,
        requirements,
      );
    }

    const existingRuntime = this.getRuntime(descriptor.agentId);
    if (existingRuntime) {
      const hasStaleSecureBinding =
        requirements?.secureRuntimeRequired === true
        && !this.options.isSecureRuntimeBindingUsable(
          descriptor.agentId,
          existingRuntime,
        )
        && this.options.hasSecureRuntimeBinding(existingRuntime);
      if (!hasStaleSecureBinding) {
        return this.assertRuntimeMeetsCreationRequirements(
          descriptor.agentId,
          existingRuntime,
          requirements,
        );
      }
      if (!this.canRecycleAgentRuntimeImmediately(descriptor, existingRuntime)) {
        throw new Error(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
      }
      await this.recycleAgentRuntime(
        descriptor,
        existingRuntime,
        "secure_session_mode_change",
      );
    }

    const creationPromise = (async () => {
      if (descriptor.role === "worker") {
        await this.options.secureWorkers.prepareWorkerForSecureTeam(
          descriptor.agentId,
        );
      }
      return this.createAndAttachRuntimeForDescriptor(descriptor, requirements);
    })();
    this.setRuntimeCreationPromise(descriptor.agentId, creationPromise);

    try {
      return this.assertRuntimeMeetsCreationRequirements(
        descriptor.agentId,
        await creationPromise,
        requirements,
      );
    } finally {
      this.clearRuntimeCreationPromiseIfCurrent(descriptor.agentId, creationPromise);
    }
  }

  resolveSpawnModel(input: SpawnAgentInput, fallback: AgentModelDescriptor): AgentModelDescriptor {
    const requestedPreset = parseSwarmModelPreset(input.model, "spawn_agent.model");
    const requestedReasoningLevel = parseSwarmReasoningLevel(
      input.reasoningLevel,
      "spawn_agent.reasoningLevel"
    );

    const descriptor = requestedPreset
      ? resolveModelDescriptorFromPreset(requestedPreset)
      : {
          ...fallback,
          modelId: normalizeOptionalModelId(fallback.modelId) ?? fallback.modelId,
          provider: normalizeOptionalAgentId(fallback.provider) ?? fallback.provider,
          thinkingLevel: fallback.thinkingLevel
        };

    const requestedModelId = normalizeOptionalModelId(input.modelId);
    if (requestedModelId) {
      assertSwarmModelIdNotRetired(descriptor.provider, requestedModelId, "spawn_agent.modelId");
      descriptor.modelId = requestedModelId;
    }

    if (requestedReasoningLevel) {
      descriptor.thinkingLevel = requestedReasoningLevel;
    }

    descriptor.thinkingLevel = normalizeThinkingLevelForModelDescriptor(descriptor);

    return descriptor;
  }

  resolveSpawnModelWithCapacityFallback(model: AgentModelDescriptor): AgentModelDescriptor {
    const provider = normalizeOptionalAgentId(model.provider)?.toLowerCase();
    const requestedModelId = normalizeOptionalModelId(model.modelId)?.toLowerCase();
    if (!provider || !requestedModelId) {
      return model;
    }

    const requestedBlock = this.getActiveModelCapacityBlock(provider, requestedModelId);
    if (!requestedBlock) {
      return model;
    }

    const attemptedModelIds: string[] = [requestedModelId];
    let candidateModelId = requestedModelId;

    while (true) {
      const nextModelId = resolveNextCapacityFallbackModelId(provider, candidateModelId);
      if (!nextModelId) {
        this.options.logDebug("agent:spawn:model_blocked_no_fallback", {
          provider,
          requestedModelId,
          blockedUntil: new Date(requestedBlock.blockedUntilMs).toISOString(),
          attemptedModelIds
        });
        return model;
      }

      attemptedModelIds.push(nextModelId);

      const nextBlock = this.getActiveModelCapacityBlock(provider, nextModelId);
      if (!nextBlock) {
        this.options.logDebug("agent:spawn:model_reroute", {
          provider,
          requestedModelId,
          selectedModelId: nextModelId,
          attemptedModelIds
        });
        const fallbackModel = {
          ...model,
          modelId: nextModelId
        };
        return {
          ...fallbackModel,
          thinkingLevel: normalizeThinkingLevelForModelDescriptor(fallbackModel)
        };
      }

      candidateModelId = nextModelId;
    }
  }

  async stopSessionInternal(
    agentId: string,
    options: AgentLifecycleStopSessionOptions
  ): Promise<{ terminatedWorkerIds: string[]; unsafeShutdownAgentIds: string[] }> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    await this.options.suppressSessionAttention(descriptor.agentId);
    const terminatedWorkerIds: string[] = [];
    const terminatedWorkerDescriptors: AgentDescriptor[] = [];
    const unsafeShutdownAgentIds: string[] = [];
    const interruptedWorkerIds: string[] = [];
    const workerCleanupFailures: unknown[] = [];
    const runtime = this.options.runtimes.get(agentId);
    const shouldEmitManualStopNotice = (options.manualStopNotice ?? true) && !options.deleteWorkers;
    const shouldAllowManualStopMessageEnd =
      shouldEmitManualStopNotice &&
      runtime !== undefined &&
      (descriptor.status === "streaming" || runtime.getStatus() === "streaming");
    if (shouldAllowManualStopMessageEnd) {
      this.options.markPendingManualManagerStopNotice(agentId);
    }

    const invalidatedManagerRuntime = this.invalidateManagerRuntimeBeforeWorkerTeardown(agentId, {
      allowManualStopMessageEnd: shouldAllowManualStopMessageEnd
    });

    for (const workerDescriptor of this.options.getWorkersForManager(agentId)) {
      if (shouldPreserveExternalThreadWorkerOnSessionStop(workerDescriptor, options.deleteWorkers)) {
        if (shouldInterruptExternalThreadSidecar(workerDescriptor)) {
          interruptedWorkerIds.push(workerDescriptor.agentId);
          await this.interruptExternalThreadWorker(workerDescriptor, { abort: true, emitStatus: true });
          await this.options.updateSessionMetaForWorkerDescriptor(workerDescriptor);
        }
        continue;
      }

      try {
        await this.terminateDescriptor(workerDescriptor, {
          abort: true,
          emitStatus: true,
        });
      } catch (error) {
        workerCleanupFailures.push(error);
        unsafeShutdownAgentIds.push(workerDescriptor.agentId);
        continue;
      }
      if (workerDescriptor.status !== "terminated") {
        unsafeShutdownAgentIds.push(workerDescriptor.agentId);
        continue;
      }
      terminatedWorkerIds.push(workerDescriptor.agentId);
      terminatedWorkerDescriptors.push(workerDescriptor);
    }

    if (shouldAllowManualStopMessageEnd) {
      this.options.markPendingManualManagerStopNotice(agentId);
      this.options.allowInvalidatedManualStopMessageEnd(agentId, invalidatedManagerRuntime.runtimeToken);
    }
    const managerShutdownTimedOut = await this.shutdownLatestManagerRuntime(
      descriptor,
      "terminate",
      invalidatedManagerRuntime,
    );
    this.clearPendingManagerRuntimeRecycle(agentId);

    if (!managerShutdownTimedOut) {
      await this.options.reconcileStoppedManagerRuntime({
        agentId,
        turnId: invalidatedManagerRuntime.turnId,
      });
    }

    if (managerShutdownTimedOut) {
      unsafeShutdownAgentIds.push(agentId);
      this.options.emitImmediateManualManagerStopNotice(
        agentId,
        MANUAL_MANAGER_STOP_TIMEOUT_NOTICE,
      );
    }

    if (unsafeShutdownAgentIds.length === 0) {
      for (const workerDescriptor of terminatedWorkerDescriptors) {
        if (options.deleteWorkers) {
          this.deleteDescriptor(workerDescriptor.agentId);
        }
        this.options.deleteConversationHistory(workerDescriptor.agentId, workerDescriptor.sessionFile);
      }
    }

    if (
      shouldEmitManualStopNotice &&
      !shouldAllowManualStopMessageEnd &&
      !managerShutdownTimedOut &&
      (terminatedWorkerIds.length > 0 || interruptedWorkerIds.length > 0 || runtime !== undefined)
    ) {
      this.options.emitImmediateManualManagerStopNotice(agentId);
    }

    descriptor.status = managerShutdownTimedOut
      ? "stopped"
      : descriptor.status === "error"
        ? "idle"
        : transitionAgentStatus(descriptor.status, "idle");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.options.now();
    this.upsertDescriptor(descriptor);

    if (options.emitStatus ?? true) {
      this.options.emitStatus(agentId, descriptor.status, 0);
    }

    await this.options.refreshSessionMetaStatsBySessionId(agentId);

    if (options.saveStore) {
      await this.options.saveStore();
    }

    if (options.emitSnapshots) {
      this.options.emitAgentsSnapshot();
      this.options.emitProfilesSnapshot();
    }

    if (workerCleanupFailures.length > 0) {
      throw new AggregateError(
        workerCleanupFailures,
        `worker_cleanup_failed: ${agentId}`,
      );
    }

    return { terminatedWorkerIds, unsafeShutdownAgentIds };
  }

  async applyManagerRuntimeRecyclePolicy(
    agentId: string,
    reason: ManagerRuntimeRecycleReason
  ): Promise<"recycled" | "deferred" | "none"> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      this.clearPendingManagerRuntimeRecycle(agentId);
      return "none";
    }

    return this.applyAgentRuntimeRecyclePolicy(agentId, reason);
  }

  async applyAgentRuntimeRecyclePolicy(
    agentId: string,
    reason: ManagerRuntimeRecycleReason
  ): Promise<"recycled" | "deferred" | "none"> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || isExternalThreadDescriptor(descriptor)) {
      this.clearPendingManagerRuntimeRecycle(agentId);
      return "none";
    }

    if (reason === "idle_transition" && !this.options.runtimeRecoveryState.hasPendingManagerRuntimeRecycle(agentId)) {
      return "none";
    }

    const effectiveReason =
      reason === "idle_transition"
        ? this.options.runtimeRecoveryState.getPendingManagerRuntimeRecycleReason(agentId) ?? reason
        : reason;

    const runtime = this.options.runtimes.get(agentId);
    if (!runtime) {
      this.clearPendingManagerRuntimeRecycle(agentId);
      return "none";
    }

    if (!this.canRecycleAgentRuntimeImmediately(descriptor, runtime)) {
      this.setPendingManagerRuntimeRecycle(agentId, effectiveReason);
      return "deferred";
    }

    await this.recycleAgentRuntime(descriptor, runtime, effectiveReason);
    return "recycled";
  }

  async terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    await this.terminateDescriptorRuntime(descriptor, options);
  }

  private async terminateDescriptorRuntime(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    this.options.cancelAllPendingChoicesForAgent(descriptor.agentId);

    if (isExternalThreadDescriptor(descriptor)) {
      await this.cleanupExternalThreadWorkerForTermination(descriptor);
      this.clearPendingManagerRuntimeRecycle(descriptor.agentId);
      this.options.clearAgentTurnState(descriptor.agentId);

      descriptor.status = transitionAgentStatus(descriptor.status, "terminated");
      descriptor.contextUsage = undefined;
      descriptor.streamingStartedAt = undefined;
      descriptor.updatedAt = this.options.now();
      this.upsertDescriptor(descriptor);

      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);

      if (options.emitStatus) {
        this.options.emitStatus(descriptor.agentId, descriptor.status, 0);
      }
      return;
    }

    if (descriptor.role === "worker") {
      this.clearWorkerTeardownState(descriptor.agentId);
      const shutdownTimedOut = await this.shutdownWorkerRuntimeWithSuppressedCallbacks(
        descriptor,
        "terminate",
        { abort: options.abort },
      );
      this.clearWorkerTeardownState(descriptor.agentId);
      if (shutdownTimedOut) {
        this.clearPendingManagerRuntimeRecycle(descriptor.agentId);
        this.options.clearAgentTurnState(descriptor.agentId);
        descriptor.status = "stopped";
        descriptor.contextUsage = undefined;
        descriptor.updatedAt = this.options.now();
        this.upsertDescriptor(descriptor);
        await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
        await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
        if (options.emitStatus) {
          this.options.emitStatus(descriptor.agentId, descriptor.status, 0);
        }
        this.options.emitImmediateManualManagerStopNotice(
          descriptor.managerId,
          formatWorkerStopTimeoutNotice([descriptor.agentId]),
        );
        return;
      }
    } else {
      const runtime = this.options.runtimes.get(descriptor.agentId);
      if (runtime) {
        const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: options.abort });
        this.options.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
      }
    }
    this.clearPendingManagerRuntimeRecycle(descriptor.agentId);
    this.options.clearAgentTurnState(descriptor.agentId);

    descriptor.status = transitionAgentStatus(descriptor.status, "terminated");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.options.now();
    this.upsertDescriptor(descriptor);

    if (descriptor.role === "worker") {
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    } else {
      await this.options.refreshSessionMetaStats(descriptor);
    }

    if (options.emitStatus) {
      this.options.emitStatus(descriptor.agentId, descriptor.status, 0);
    }
  }

  async syncWorkerSpecialistMetadata(
    profileId: string,
    roster: ResolvedSpecialistDefinitionLike[],
    managerId?: string,
    options?: { persist?: boolean; publish?: boolean },
  ): Promise<void> {
    const rosterById = new Map(roster.map((entry) => [entry.specialistId, entry]));
    const tierConfigs = await resolveTierConfigs(this.options.dataDir);
    const tierConfigsById = new Map(tierConfigs.map((config) => [config.tier, config]));
    let changed = false;

    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.role !== "worker" || descriptor.profileId !== profileId) {
        continue;
      }

      if (isExternalThreadDescriptor(descriptor)) {
        continue;
      }

      if (managerId && descriptor.managerId !== managerId) {
        continue;
      }

      if (descriptor.specialistTier) {
        const tierConfig = tierConfigsById.get(descriptor.specialistTier) ?? DEFAULT_TIER_CONFIGS[descriptor.specialistTier];
        const tierDisplayName = getDelegationTierDisplayName(descriptor.specialistTier, tierConfig.displayName);
        const lensId = normalizeOptionalAgentId(
          descriptor.specialistLens ?? descriptor.specialistId?.split(":")[1],
        )?.toLowerCase();
        const specialist = lensId ? rosterById.get(lensId) : undefined;
        if (lensId && !specialist) {
          continue;
        }

        const specialistId = getTierAttributionId(descriptor.specialistTier, lensId);
        const specialistDisplayName = specialist
          ? `${tierDisplayName} — ${specialist.displayName}`
          : tierDisplayName;
        const specialistColor = specialist?.color ?? tierConfig.color;
        if (
          descriptor.specialistId === specialistId &&
          descriptor.specialistDisplayName === specialistDisplayName &&
          descriptor.specialistColor === specialistColor
        ) {
          continue;
        }

        descriptor.specialistId = specialistId;
        descriptor.specialistDisplayName = specialistDisplayName;
        descriptor.specialistColor = specialistColor;
        this.upsertDescriptor(descriptor);
        changed = true;
        continue;
      }

      const specialistId = normalizeOptionalAgentId(descriptor.specialistId)?.toLowerCase();
      if (!specialistId) {
        continue;
      }

      const specialist = rosterById.get(specialistId);
      if (!specialist) {
        continue;
      }

      if (
        descriptor.specialistId === specialist.specialistId &&
        descriptor.specialistDisplayName === specialist.displayName &&
        descriptor.specialistColor === specialist.color
      ) {
        continue;
      }

      descriptor.specialistId = specialist.specialistId;
      descriptor.specialistDisplayName = specialist.displayName;
      descriptor.specialistColor = specialist.color;
      this.upsertDescriptor(descriptor);
      changed = true;
    }

    if (!changed) {
      return;
    }

    if (options?.persist !== false) {
      await this.options.saveStore();
    }
    if (options?.publish !== false) {
      this.options.emitAgentsSnapshot();
    }
  }

  private canRecycleAgentRuntimeImmediately(
    descriptor: AgentDescriptor,
    runtime: SwarmAgentRuntime
  ): boolean {
    return (
      descriptor.status === "idle" &&
      runtime.getStatus() === "idle" &&
      runtime.getPendingCount() === 0 &&
      !isRuntimeRecoveryActiveForRuntime(runtime)
    );
  }

  private async recycleAgentRuntime(
    descriptor: AgentDescriptor,
    runtime: SwarmAgentRuntime,
    reason: ManagerRuntimeRecycleReason
  ): Promise<void> {
    const runtimeToken = this.options.getRuntimeToken(descriptor.agentId);
    this.clearPendingManagerRuntimeRecycle(descriptor.agentId);

    try {
      if (reason === "model_change") {
        await runtime.shutdownForReplacement();
      } else {
        await runtime.recycle();
      }
    } catch (error) {
      this.setPendingManagerRuntimeRecycle(descriptor.agentId, reason);
      throw error;
    }

    this.options.detachRuntime(descriptor.agentId, runtimeToken);

    if (descriptor.contextUsage) {
      descriptor.contextUsage = undefined;
      this.upsertDescriptor(descriptor);
    }

    if (descriptor.role === "worker") {
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.options.refreshSessionMetaStatsBySessionId(
        descriptor.managerId,
      );
    } else {
      await this.options.refreshSessionMetaStats(descriptor);
    }

    this.options.emitStatus(descriptor.agentId, descriptor.status, 0);
    this.options.logDebug("agent:runtime_recycled", {
      agentId: descriptor.agentId,
      role: descriptor.role,
      profileId: descriptor.profileId,
      reason,
      model: descriptor.model
    });
  }

  private setPendingManagerRuntimeRecycle(agentId: string, reason: ManagerRuntimeRecycleReason): void {
    this.options.runtimeRecoveryState.setPendingManagerRuntimeRecycle(agentId, reason);
  }

  private clearPendingManagerRuntimeRecycle(agentId: string): void {
    this.options.runtimeRecoveryState.clearPendingManagerRuntimeRecycle(agentId);
  }

  private async createAndAttachRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    requirements?: RuntimeAcquisitionRequirements,
  ): Promise<SwarmAgentRuntime> {
    await this.options.ensureSessionFileParentDirectory(descriptor.sessionFile);

    const existingRuntime = this.options.runtimes.get(descriptor.agentId);
    if (existingRuntime) {
      return existingRuntime;
    }

    const resolvedSystemPrompt =
      await this.options.resolveSystemPromptForDescriptor(descriptor);
    const systemPrompt =
      descriptor.role === "worker"
        ? this.options.injectWorkerIdentityContext(
            descriptor,
            resolvedSystemPrompt,
          )
        : resolvedSystemPrompt;
    const runtimeBeforeCreate = this.options.runtimes.get(descriptor.agentId);
    if (runtimeBeforeCreate) {
      return runtimeBeforeCreate;
    }

    const managerRuntimeCreation = descriptor.role === "manager"
      ? await this.options.prepareManagerRuntimeCreation?.(descriptor as ProvisionedSessionDescriptor, systemPrompt)
      : undefined;

    const shouldDeferCursorStartupRecoveryAppliedMarker =
      descriptor.role === "manager" &&
      managerRuntimeCreation?.continuityRequest?.targetModel.runtimeKind === "cursor-sdk" &&
      Boolean(managerRuntimeCreation.runtimeCreationOptions?.startupRecoveryContext);

    const deferredContinuityRequest = managerRuntimeCreation?.continuityRequest;
    const runtimeToken = this.options.allocateRuntimeToken(descriptor.agentId);
    const deferredRecoveryRuntimeRef: { current?: SwarmAgentRuntime } = {};
    const managerRuntimeCreationOptions =
      shouldDeferCursorStartupRecoveryAppliedMarker && deferredContinuityRequest
        ? {
            ...managerRuntimeCreation?.runtimeCreationOptions,
            onStartupRecoveryConsumed: async () => {
              try {
                if (this.options.getRuntimeToken(descriptor.agentId) !== runtimeToken) {
                  return;
                }

                const attachedRuntime = this.options.runtimes.get(descriptor.agentId);
                if (!attachedRuntime || attachedRuntime !== deferredRecoveryRuntimeRef.current) {
                  return;
                }

                const attachDescriptorForApplied = this.options.descriptors.get(descriptor.agentId);
                if (!attachDescriptorForApplied || attachDescriptorForApplied.role !== "manager") {
                  return;
                }

                await this.options.appendAppliedModelChangeContinuity?.(
                  attachDescriptorForApplied as ProvisionedSessionDescriptor,
                  deferredContinuityRequest,
                  attachedRuntime
                );
              } catch (error) {
                this.options.logDebug("manager:model_change_continuity:cursor_first_send_applied_write_error", {
                  agentId: descriptor.agentId,
                  requestId: deferredContinuityRequest.requestId,
                  message: error instanceof Error ? error.message : String(error)
                });
              }
            }
          }
        : managerRuntimeCreation?.runtimeCreationOptions;
    const requestedCreationOptions: RuntimeCreationOptions | undefined =
      requirements?.secureRuntimeRequired
        ? { secureRuntimeRequired: true }
        : undefined;
    const runtimeCreationOptions = requestedCreationOptions
      ? {
          ...managerRuntimeCreationOptions,
          ...requestedCreationOptions,
        }
      : managerRuntimeCreationOptions;

    const runtime = await this.options.createRuntimeForDescriptor(
      descriptor,
      systemPrompt,
      runtimeToken,
      runtimeCreationOptions
    );
    deferredRecoveryRuntimeRef.current = runtime;
    if (descriptor.role === "manager") {
      await this.options.syncPinnedContentForManagerRuntime(descriptor as ProvisionedSessionDescriptor, { runtime });
    }
    const persistedSystemPrompt = runtime.getSystemPrompt?.() ?? systemPrompt;

    const latestDescriptor = this.options.descriptors.get(descriptor.agentId);
    if (!latestDescriptor || isNonRunningAgentStatus(latestDescriptor.status)) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: 1_500,
        drainTimeoutMs: 500,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Target agent is not running: ${descriptor.agentId}`);
    }

    const concurrentRuntime = this.options.runtimes.get(descriptor.agentId);
    if (concurrentRuntime) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: 1_500,
        drainTimeoutMs: 500,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      return concurrentRuntime;
    }

    let attachDescriptor = this.options.descriptors.get(descriptor.agentId);
    if (!attachDescriptor || isNonRunningAgentStatus(attachDescriptor.status)) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: 1_500,
        drainTimeoutMs: 500,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Target agent is not running: ${descriptor.agentId}`);
    }

    const attachConcurrentRuntime = this.options.runtimes.get(descriptor.agentId);
    if (attachConcurrentRuntime) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: 1_500,
        drainTimeoutMs: 500,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      return attachConcurrentRuntime;
    }

    if (this.options.getRuntimeToken(descriptor.agentId) !== runtimeToken) {
      this.options.logDebug("manager:model_change_continuity:pre_write_attach_rejected", {
        agentId: descriptor.agentId,
        reason: "stale_runtime_token"
      });
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: 1_500,
        drainTimeoutMs: 500,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Runtime token is stale for agent: ${descriptor.agentId}`);
    }

    if (
      attachDescriptor.role === "manager" &&
      managerRuntimeCreation?.continuityRequest &&
      !shouldDeferCursorStartupRecoveryAppliedMarker
    ) {
      try {
        await this.options.appendAppliedModelChangeContinuity?.(
          attachDescriptor as ProvisionedSessionDescriptor,
          managerRuntimeCreation.continuityRequest,
          runtime
        );
      } catch (error) {
        this.options.logDebug("manager:model_change_continuity:applied_write_error", {
          agentId: attachDescriptor.agentId,
          requestId: managerRuntimeCreation.continuityRequest.requestId,
          message: error instanceof Error ? error.message : String(error)
        });
        await runtime.terminate({
          abort: true,
          shutdownTimeoutMs: 1_500,
          drainTimeoutMs: 500,
        });
        this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
        throw error;
      }
    }

    const postWriteDescriptor = this.options.descriptors.get(descriptor.agentId);
    if (!postWriteDescriptor || isNonRunningAgentStatus(postWriteDescriptor.status)) {
      this.options.logDebug("manager:model_change_continuity:post_write_attach_rejected", {
        agentId: descriptor.agentId,
        reason: postWriteDescriptor ? "not_running" : "missing_descriptor"
      });
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: 1_500,
        drainTimeoutMs: 500,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Target agent is not running: ${descriptor.agentId}`);
    }

    const postWriteConcurrentRuntime = this.options.runtimes.get(descriptor.agentId);
    if (postWriteConcurrentRuntime) {
      this.options.logDebug("manager:model_change_continuity:post_write_attach_rejected", {
        agentId: descriptor.agentId,
        reason: "concurrent_runtime"
      });
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: 1_500,
        drainTimeoutMs: 500,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      return postWriteConcurrentRuntime;
    }

    if (this.options.getRuntimeToken(descriptor.agentId) !== runtimeToken) {
      this.options.logDebug("manager:model_change_continuity:post_write_attach_rejected", {
        agentId: descriptor.agentId,
        reason: "stale_runtime_token"
      });
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: 1_500,
        drainTimeoutMs: 500,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Runtime token is stale for agent: ${descriptor.agentId}`);
    }

    attachDescriptor = postWriteDescriptor;
    this.options.attachRuntime(descriptor.agentId, runtime);

    const contextUsage = runtime.getContextUsage();
    attachDescriptor.contextUsage = contextUsage;
    this.upsertDescriptor(attachDescriptor);

    if (attachDescriptor.role === "manager") {
      await this.options.captureSessionRuntimePromptMeta(attachDescriptor, persistedSystemPrompt);
      await this.options.refreshSessionMetaStats(attachDescriptor);
    } else {
      await this.options.updateSessionMetaForWorkerDescriptor(attachDescriptor, persistedSystemPrompt);
      await this.options.refreshSessionMetaStatsBySessionId(attachDescriptor.managerId);
    }

    this.options.emitStatus(descriptor.agentId, attachDescriptor.status, runtime.getPendingCount(), contextUsage);
    return runtime;
  }

  private assertRuntimeMeetsCreationRequirements(
    agentId: string,
    runtime: SwarmAgentRuntime,
    requirements?: RuntimeAcquisitionRequirements,
  ): SwarmAgentRuntime {
    if (
      requirements?.secureRuntimeRequired
      && !this.options.isSecureRuntimeBindingUsable(agentId, runtime)
    ) {
      throw new Error(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
    }
    return runtime;
  }

  private getActiveModelCapacityBlock(provider: string, modelId: string): ModelCapacityBlockLike | undefined {
    const key = buildModelCapacityBlockKey(provider, modelId);
    if (!key) {
      return undefined;
    }

    const block = this.options.modelCapacityBlocks.get(key);
    if (!block) {
      return undefined;
    }

    if (Date.now() >= block.blockedUntilMs) {
      this.options.modelCapacityBlocks.delete(key);
      this.options.logDebug("model_capacity:block_expired", {
        provider: block.provider,
        modelId: block.modelId,
        blockedUntil: new Date(block.blockedUntilMs).toISOString()
      });
      return undefined;
    }

    return block;
  }
}
