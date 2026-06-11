import type { AgentRuntimeExtensionSnapshot } from "@forge/protocol";
import type { ForgeExtensionHost } from "./forge-extension-host.js";
import { createForgeBindingToken } from "./forge-extension-types.js";
import type { ProjectExecutableTrustPlan } from "./project-executable-trust.js";
import type { CredentialPoolService } from "./credential-pool.js";
import type { SkillMetadata } from "./skills/skill-metadata-service.js";
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeShutdownOptions,
  SwarmAgentRuntime
} from "./runtime-contracts.js";
import {
  RuntimeCallbackGate,
  type RuntimeCallbackFallbackHandoffReplayHandlers,
  type RuntimeCallbackFallbackHandoffSnapshot
} from "./runtime/runtime-callback-gate.js";
import { RuntimeBinding } from "./runtime/runtime-binding.js";
import { RuntimeFactory } from "./runtime/runtime-factory.js";
import { RuntimeStatusProjector } from "./runtime/runtime-status-projector.js";
import { RuntimeErrorProjector } from "./runtime/runtime-error-projector.js";
import { RuntimeEventProjector } from "./runtime/runtime-event-projector.js";
import type { RuntimeRecoveryState } from "./runtime/runtime-recovery-state.js";
import type {
  WorkerActivityStateLike,
  WorkerStallStateLike,
  WorkerWatchdogStateLike
} from "./runtime/worker-health-types.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  ConversationMessageEvent,
  SwarmConfig,
  SwarmReasoningLevel
} from "./types.js";
import { withManagerTimeout } from "./swarm-manager-utils.js";
import type { VersioningMutation } from "../versioning/versioning-types.js";
import type { SwarmSpecialistFallbackManager } from "./swarm-specialist-fallback-manager.js";
import type { ObservabilityFacade } from "../observability/observability-types.js";

const RUNTIME_SHUTDOWN_TIMEOUT_MS = 1_500;
const RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS = 500;

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  fallbackModelId?: string;
  fallbackReasoningLevel?: SwarmReasoningLevel;
}

export interface SwarmRuntimeControllerHost extends SwarmToolHost {
  config: SwarmConfig;
  forgeExtensionHost: ForgeExtensionHost;
  now: () => string;
  descriptors: Map<string, AgentDescriptor>;
  workerWatchdogState: Map<string, WorkerWatchdogStateLike>;
  workerStallState: Map<string, WorkerStallStateLike>;
  workerActivityState: Map<string, WorkerActivityStateLike>;
  watchdogTimerTokens: Map<string, number>;
  runtimeRecoveryState: Pick<
    RuntimeRecoveryState,
    "markRecoveryAbortedWorkerTurn" | "hasRecoveryAbortedWorkerTurn" | "clearRecoveryAbortedWorkerTurn"
  >;
  conversationProjector: {
    captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent): void;
    emitConversationMessage(event: ConversationMessageEvent): void;
  };
  promptService: {
    buildClaudeRuntimeSystemPrompt(descriptor: AgentDescriptor, systemPrompt: string): Promise<string>;
    buildCursorSdkRuntimeSystemPrompt(descriptor: AgentDescriptor, systemPrompt: string): Promise<string>;
  };
  secretsEnvService: {
    getCredentialPoolService(): CredentialPoolService;
  };
  getObservabilityService?(): ObservabilityFacade | undefined;
  cortexService: {
    handleManagerStatusTransition(
      descriptor: AgentDescriptor,
      status: AgentStatus,
      pendingCount: number
    ): void | Promise<void>;
  };
  getPiModelsJsonPathOrThrow(): string;
  getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
    skillMetadata: SkillMetadata[];
  }>;
  getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>>;
  resolveProjectExecutableTrustPlanForRuntime(options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
  }): Promise<ProjectExecutableTrustPlan>;
  resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string>;
  injectWorkerIdentityContext(descriptor: AgentDescriptor, systemPrompt: string): string;
  resolveSpecialistRosterForProfile(profileId: string): Promise<ResolvedSpecialistDefinitionLike[]>;
  resolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor
  ): Promise<AgentModelDescriptor | undefined>;
  maybeRecoverWorkerWithSpecialistFallback(
    agentId: string,
    errorMessage: string,
    sourcePhase: "prompt_dispatch" | "prompt_start",
    runtimeToken?: number
  ): Promise<boolean>;
  resolveSpawnModelWithCapacityFallback(model: AgentModelDescriptor): AgentModelDescriptor;
  createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number
  ): Promise<SwarmAgentRuntime>;
  updateSessionMetaForWorkerDescriptor(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void>;
  refreshSessionMetaStatsBySessionId(sessionAgentId: string, sessionFileOverride?: string): Promise<void>;
  refreshSessionMetaStats(descriptor: AgentDescriptor, sessionFileOverride?: string): Promise<void>;
  maybeRecordModelCapacityBlock(agentId: string, descriptor: AgentDescriptor, error: RuntimeErrorEvent): void;
  consumePendingManualManagerStopNoticeIfApplicable(agentId: string, event: RuntimeSessionEvent): boolean;
  stripManagerAbortErrorFromEvent(event: RuntimeSessionEvent): RuntimeSessionEvent;
  getOrCreateWorkerWatchdogState(agentId: string): WorkerWatchdogStateLike;
  clearWatchdogTimer(agentId: string): void;
  removeWorkerFromWatchdogBatchQueues(agentId: string): void;
  beginPendingTransientWorkerTerminatedError(
    agentId: string,
    event: RuntimeSessionEvent,
    expire: (event: RuntimeSessionEvent) => void | Promise<void>
  ): boolean;
  cancelPendingTransientWorkerTerminatedError(agentId: string, reason: "runtime_progress" | "worker_reported" | "clear_state"): void;
  hasPendingTransientWorkerTerminatedError(agentId: string): boolean;
  finalizeWorkerIdleTurn(
    agentId: string,
    descriptor: AgentDescriptor,
    source: "agent_end" | "status_idle" | "deferred"
  ): Promise<void>;
  isRuntimeRecoveryActive(agentId: string): boolean;
  incrementSessionCompactionCount(
    profileId: string,
    sessionId: string,
    failureLogKey: string
  ): Promise<number | undefined>;
  patchDescriptorFromRuntimeStatus(
    agentId: string,
    patch: Partial<AgentDescriptor>
  ): Promise<AgentDescriptor | undefined>;
  emitConversationMessage(event: ConversationMessageEvent): void;
  emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): void;
  emitAgentsSnapshot(): void;
  saveStore(): Promise<void>;
  applyManagerRuntimeRecyclePolicy(
    agentId: string,
    reason: "model_change" | "cwd_change" | "idle_transition" | "prompt_mode_change" | "project_agent_directory_change" | "project_resource_trust_change" | "specialist_roster_change" | "work_plans_settings_change"
  ): Promise<"recycled" | "deferred" | "none">;
  queueVersionedToolMutation(descriptor: AgentDescriptor, mutation: VersioningMutation): Promise<void>;
  logDebug(message: string, details?: unknown): void;
}

export class SwarmRuntimeController {
  readonly runtimes: Map<string, SwarmAgentRuntime>;
  readonly runtimeCreationPromisesByAgentId: Map<string, Promise<SwarmAgentRuntime>>;
  readonly runtimeTokensByAgentId: Map<string, number>;
  readonly runtimeExtensionSnapshotsByAgentId: Map<string, AgentRuntimeExtensionSnapshot>;

  private specialistFallbackManager: SwarmSpecialistFallbackManager | null = null;
  private readonly runtimeBinding: RuntimeBinding;
  private readonly runtimeCallbackGate: RuntimeCallbackGate;
  private readonly runtimeFactory: RuntimeFactory;
  private runtimeStatusProjector: RuntimeStatusProjector | null = null;
  private runtimeErrorProjector: RuntimeErrorProjector | null = null;
  private runtimeEventProjector: RuntimeEventProjector | null = null;

  constructor(private readonly host: SwarmRuntimeControllerHost) {
    this.runtimeBinding = new RuntimeBinding({
      deactivateRuntimeBindings: (bindingToken) => this.host.forgeExtensionHost.deactivateRuntimeBindings(bindingToken),
      clearIntentionalStopRuntimeCallbackSuppression: (agentId, runtimeToken) =>
        this.clearIntentionalStopRuntimeCallbackSuppression(agentId, runtimeToken)
    });
    this.runtimes = this.runtimeBinding.runtimes;
    this.runtimeCreationPromisesByAgentId = this.runtimeBinding.runtimeCreationPromisesByAgentId;
    this.runtimeTokensByAgentId = this.runtimeBinding.runtimeTokensByAgentId;
    this.runtimeExtensionSnapshotsByAgentId = this.runtimeBinding.runtimeExtensionSnapshotsByAgentId;

    this.runtimeCallbackGate = new RuntimeCallbackGate({
      getCurrentRuntimeToken: (agentId) => this.runtimeBinding.getRuntimeToken(agentId),
      now: () => this.now()
    });
    this.runtimeFactory = new RuntimeFactory({
      host,
      forgeExtensionHost: host.forgeExtensionHost,
      config: host.config,
      now: host.now,
      logDebug: (message, details) => this.logDebug(message, details),
      getPiModelsJsonPath: () => this.host.getPiModelsJsonPathOrThrow(),
      getAgentDescriptor: (agentId) => this.host.descriptors.get(agentId),
      getCredentialPoolService: () => this.host.secretsEnvService.getCredentialPoolService(),
      observability: this.host.getObservabilityService?.(),
      onSessionFileRotated: async (descriptor, sessionFile) => {
        if (descriptor.role !== "manager") {
          await this.refreshSessionMetaStatsBySessionId(descriptor.managerId, sessionFile);
          return;
        }

        await this.refreshSessionMetaStats(descriptor, sessionFile);
      },
      getMemoryRuntimeResources: async (descriptor) => this.host.getMemoryRuntimeResources(descriptor),
      getSwarmContextFiles: async (cwd) => this.host.getSwarmContextFiles(cwd),
      resolveProjectExecutableTrustPlan: async (options) =>
        this.host.resolveProjectExecutableTrustPlanForRuntime(options),
      buildClaudeRuntimeSystemPrompt: async (descriptor, systemPrompt) =>
        this.host.promptService.buildClaudeRuntimeSystemPrompt(descriptor, systemPrompt),
      buildCursorSdkRuntimeSystemPrompt: async (descriptor, systemPrompt) =>
        this.host.promptService.buildCursorSdkRuntimeSystemPrompt(descriptor, systemPrompt),
      mergeRuntimeContextFiles: (baseAgentsFiles, options) =>
        this.mergeRuntimeContextFiles(baseAgentsFiles, options),
      callbacks: {
        onStatusChange: async (runtimeToken, agentId, status, pendingCount, contextUsage) => {
          await this.handleRuntimeStatus(runtimeToken, agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (runtimeToken, agentId, event) => {
          await this.handleRuntimeSessionEvent(runtimeToken, agentId, event);
        },
        onAgentEnd: async (runtimeToken, agentId) => {
          await this.handleRuntimeAgentEnd(runtimeToken, agentId);
        },
        onRuntimeError: async (runtimeToken, agentId, error) => {
          await this.handleRuntimeError(runtimeToken, agentId, error);
        },
        onRuntimeExtensionSnapshot: async (runtimeToken, agentId, snapshot) => {
          this.handleRuntimeExtensionSnapshot(runtimeToken, agentId, snapshot);
        }
      }
    });
  }

  setSpecialistFallbackManager(manager: SwarmSpecialistFallbackManager): void {
    this.specialistFallbackManager = manager;
    manager.setFallbackHandoffController({
      beginFallbackHandoff: (agentId, suppressedRuntimeToken) =>
        this.beginFallbackHandoff(agentId, suppressedRuntimeToken),
      endFallbackHandoff: (agentId, suppressedRuntimeToken) =>
        this.endFallbackHandoff(agentId, suppressedRuntimeToken),
      getFallbackHandoffSnapshot: (agentId, suppressedRuntimeToken) =>
        this.getFallbackHandoffSnapshot(agentId, suppressedRuntimeToken),
      reconcileBufferedCallbacksOnAbort: (agentId, suppressedRuntimeToken, handlers) =>
        this.reconcileBufferedCallbacksOnAbort(agentId, suppressedRuntimeToken, handlers)
    });
  }

  listRuntimeExtensionSnapshots(): AgentRuntimeExtensionSnapshot[] {
    return this.runtimeBinding.listRuntimeExtensionSnapshots();
  }

  getRuntime(agentId: string): SwarmAgentRuntime | undefined {
    return this.runtimeBinding.getRuntime(agentId);
  }

  hasRuntime(agentId: string): boolean {
    return this.runtimeBinding.hasRuntime(agentId);
  }

  isRuntime(agentId: string, runtime: SwarmAgentRuntime): boolean {
    return this.runtimeBinding.isRuntime(agentId, runtime);
  }

  attachRuntime(agentId: string, runtime: SwarmAgentRuntime): void {
    this.runtimeBinding.attachRuntime(agentId, runtime);
  }

  get trackedToolPathsByAgentId(): Map<string, Map<string, { toolName: string; path: string }>> {
    return this.getRuntimeEventProjector().getTrackedToolPathsByAgentId();
  }

  clearTrackedToolPaths(agentId: string): void {
    this.getRuntimeEventProjector().clearTrackedToolPaths(agentId);
  }

  suppressIntentionalStopRuntimeCallbacks(agentId: string, runtimeToken?: number): void {
    this.runtimeCallbackGate.suppressIntentionalStopRuntimeCallbacks(agentId, runtimeToken);
  }

  clearIntentionalStopRuntimeCallbackSuppression(agentId: string, runtimeToken?: number): void {
    this.runtimeCallbackGate.clearIntentionalStopRuntimeCallbackSuppression(agentId, runtimeToken);
  }

  allowInvalidatedManualStopMessageEnd(agentId: string, runtimeToken?: number): void {
    this.runtimeCallbackGate.allowInvalidatedManualStopMessageEnd(agentId, runtimeToken);
  }

  clearInvalidatedManualStopMessageEndAllowance(agentId: string, runtimeToken?: number): void {
    this.runtimeCallbackGate.clearInvalidatedManualStopMessageEndAllowance(agentId, runtimeToken);
  }

  beginFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void {
    this.runtimeCallbackGate.beginFallbackHandoff(agentId, suppressedRuntimeToken);
  }

  endFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void {
    this.runtimeCallbackGate.endFallbackHandoff(agentId, suppressedRuntimeToken);
  }

  getFallbackHandoffSnapshot(
    agentId: string,
    suppressedRuntimeToken?: number
  ): RuntimeCallbackFallbackHandoffSnapshot | undefined {
    return this.runtimeCallbackGate.getFallbackHandoffSnapshot(agentId, suppressedRuntimeToken);
  }

  async reconcileBufferedCallbacksOnAbort(
    agentId: string,
    suppressedRuntimeToken: number | undefined,
    handlers: RuntimeCallbackFallbackHandoffReplayHandlers
  ): Promise<void> {
    await this.runtimeCallbackGate.reconcileBufferedCallbacksOnAbort(agentId, suppressedRuntimeToken, handlers);
  }

  async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken = this.allocateRuntimeToken(descriptor.agentId),
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    try {
      return await this.runtimeFactory.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options);
    } catch (error) {
      this.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw error;
    }
  }

  allocateRuntimeToken(agentId: string): number {
    return this.runtimeBinding.allocateRuntimeToken(agentId);
  }

  getRuntimeToken(agentId: string): number | undefined {
    return this.runtimeBinding.getRuntimeToken(agentId);
  }

  clearRuntimeToken(agentId: string, runtimeToken?: number): void {
    this.runtimeBinding.clearRuntimeToken(agentId, runtimeToken);
  }

  restoreRuntimeTokenForFallbackRollback(agentId: string, runtimeToken: number): void {
    this.runtimeBinding.restoreRuntimeTokenForFallbackRollback(agentId, runtimeToken);
  }

  detachRuntime(agentId: string, runtimeToken?: number): boolean {
    return this.runtimeBinding.detachRuntime(agentId, runtimeToken);
  }

  detachRuntimeIfMatches(
    agentId: string,
    expectedRuntime: SwarmAgentRuntime,
    runtimeToken?: number
  ): boolean {
    return this.runtimeBinding.detachRuntimeIfMatches(agentId, expectedRuntime, runtimeToken);
  }

  getRuntimeCreationPromise(agentId: string): Promise<SwarmAgentRuntime> | undefined {
    return this.runtimeBinding.getRuntimeCreationPromise(agentId);
  }

  setRuntimeCreationPromise(agentId: string, promise: Promise<SwarmAgentRuntime>): void {
    this.runtimeBinding.setRuntimeCreationPromise(agentId, promise);
  }

  clearRuntimeCreationPromiseIfCurrent(agentId: string, promise: Promise<SwarmAgentRuntime>): boolean {
    return this.runtimeBinding.clearRuntimeCreationPromiseIfCurrent(agentId, promise);
  }

  async runRuntimeShutdown(
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions
  ): Promise<{ timedOut: boolean; runtimeToken?: number }> {
    const runtime = this.runtimes.get(descriptor.agentId);
    if (!runtime) {
      return { timedOut: false, runtimeToken: undefined };
    }

    const runtimeToken = this.runtimeTokensByAgentId.get(descriptor.agentId);
    const operation =
      action === "terminate"
        ? runtime.terminate({
            abort: options?.abort,
            shutdownTimeoutMs: options?.shutdownTimeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS,
            drainTimeoutMs: options?.drainTimeoutMs ?? RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
          })
        : runtime.stopInFlight({
            abort: options?.abort,
            shutdownTimeoutMs: options?.shutdownTimeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS,
            drainTimeoutMs: options?.drainTimeoutMs ?? RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
          });

    try {
      await withManagerTimeout(
        operation,
        options?.shutdownTimeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS,
        `${action}:${descriptor.agentId}`
      );
      return { timedOut: false, runtimeToken };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timed out/i.test(message);
      if (timedOut) {
        this.logDebug("runtime:shutdown:timeout", {
          agentId: descriptor.agentId,
          action,
          timeoutMs: options?.shutdownTimeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS,
          message,
        });
        void operation.catch((lateError) => {
          this.logDebug("runtime:shutdown:late_completion", {
            agentId: descriptor.agentId,
            action,
            message: lateError instanceof Error ? lateError.message : String(lateError),
          });
        });
        this.detachRuntime(descriptor.agentId, runtimeToken);
        return { timedOut: true, runtimeToken };
      }

      throw error;
    }
  }

  private getRuntimeStatusProjector(): RuntimeStatusProjector {
    if (!this.runtimeStatusProjector) {
      this.runtimeStatusProjector = new RuntimeStatusProjector({
        descriptors: this.host.descriptors,
        workerWatchdogState: this.host.workerWatchdogState,
        workerStallState: this.host.workerStallState,
        workerActivityState: this.host.workerActivityState,
        watchdogTimerTokens: this.host.watchdogTimerTokens,
        now: () => this.now(),
        patchDescriptorFromRuntimeStatus: (agentId, patch) => this.host.patchDescriptorFromRuntimeStatus(agentId, patch),
        updateSessionMetaForWorkerDescriptor: (descriptor) => this.host.updateSessionMetaForWorkerDescriptor(descriptor),
        refreshSessionMetaStatsBySessionId: (sessionAgentId) => this.host.refreshSessionMetaStatsBySessionId(sessionAgentId),
        refreshSessionMetaStats: (descriptor) => this.host.refreshSessionMetaStats(descriptor),
        saveStore: () => this.host.saveStore(),
        emitStatus: (agentId, status, pendingCount, contextUsage) =>
          this.host.emitStatus(agentId, status, pendingCount, contextUsage),
        emitAgentsSnapshot: () => this.host.emitAgentsSnapshot(),
        logDebug: (message, details) => this.logDebug(message, details),
        getOrCreateWorkerWatchdogState: (agentId) => this.host.getOrCreateWorkerWatchdogState(agentId),
        clearWatchdogTimer: (agentId) => this.host.clearWatchdogTimer(agentId),
        removeWorkerFromWatchdogBatchQueues: (agentId) => this.host.removeWorkerFromWatchdogBatchQueues(agentId),
        finalizeWorkerIdleTurn: (agentId, descriptor, source) =>
          this.host.finalizeWorkerIdleTurn(agentId, descriptor, source),
        shouldSuppressWorkerIdleFinalization: (descriptor) => this.shouldSuppressWorkerIdleFinalization(descriptor),
        handleManagerStatusTransition: (descriptor, status, pendingCount) =>
          this.host.cortexService.handleManagerStatusTransition(descriptor, status, pendingCount),
        applyManagerRuntimeRecyclePolicy: (agentId, reason) =>
          this.host.applyManagerRuntimeRecyclePolicy(agentId, reason)
      });
    }

    return this.runtimeStatusProjector;
  }

  private getRuntimeErrorProjector(): RuntimeErrorProjector {
    if (!this.runtimeErrorProjector) {
      this.runtimeErrorProjector = new RuntimeErrorProjector({
        descriptors: this.host.descriptors,
        getRuntimeToken: (agentId) => this.runtimeBinding.getRuntimeToken(agentId),
        now: () => this.now(),
        maybeRecordModelCapacityBlock: (agentId, descriptor, error) =>
          this.host.maybeRecordModelCapacityBlock(agentId, descriptor, error),
        dispatchRuntimeError: (runtimeToken, error) =>
          this.host.forgeExtensionHost.dispatchRuntimeError(createForgeBindingToken(runtimeToken), error),
        maybeRecoverWorkerWithSpecialistFallback: (agentId, errorMessage, sourcePhase, runtimeToken) =>
          this.maybeRecoverWorkerWithSpecialistFallback(agentId, errorMessage, sourcePhase, runtimeToken),
        incrementSessionCompactionCount: (profileId, sessionId, failureLogKey) =>
          this.host.incrementSessionCompactionCount(profileId, sessionId, failureLogKey),
        patchDescriptorFromRuntimeStatus: (agentId, patch) =>
          this.host.patchDescriptorFromRuntimeStatus(agentId, patch),
        emitConversationMessage: (event) => this.host.emitConversationMessage(event),
        logDebug: (message, details) => this.logDebug(message, details)
      });
    }

    return this.runtimeErrorProjector;
  }

  private getRuntimeEventProjector(): RuntimeEventProjector {
    if (!this.runtimeEventProjector) {
      this.runtimeEventProjector = new RuntimeEventProjector({
        config: this.host.config,
        descriptors: this.host.descriptors,
        workerStallState: this.host.workerStallState,
        workerActivityState: this.host.workerActivityState,
        runtimeRecoveryState: this.host.runtimeRecoveryState,
        now: () => this.now(),
        conversationProjector: this.host.conversationProjector,
        maybeRecordModelCapacityBlock: (agentId, descriptor, error) =>
          this.host.maybeRecordModelCapacityBlock(agentId, descriptor, error),
        maybeRecoverWorkerWithSpecialistFallback: (agentId, errorMessage, sourcePhase, runtimeToken) =>
          this.maybeRecoverWorkerWithSpecialistFallback(agentId, errorMessage, sourcePhase, runtimeToken),
        consumePendingManualManagerStopNoticeIfApplicable: (agentId, event) =>
          this.host.consumePendingManualManagerStopNoticeIfApplicable(agentId, event),
        stripManagerAbortErrorFromEvent: (event) => this.host.stripManagerAbortErrorFromEvent(event),
        isRuntimeRecoveryActive: (agentId) => this.host.isRuntimeRecoveryActive(agentId),
        beginPendingTransientWorkerTerminatedError: (agentId, event, expire) =>
          this.host.beginPendingTransientWorkerTerminatedError(agentId, event, expire),
        cancelPendingTransientWorkerTerminatedError: (agentId, reason) =>
          this.host.cancelPendingTransientWorkerTerminatedError(agentId, reason),
        hasPendingTransientWorkerTerminatedError: (agentId) =>
          this.host.hasPendingTransientWorkerTerminatedError(agentId),
        queueVersionedToolMutation: (descriptor, mutation) => this.host.queueVersionedToolMutation(descriptor, mutation),
        logDebug: (message, details) => this.logDebug(message, details)
      });
    }

    return this.runtimeEventProjector;
  }

  async handleRuntimeStatus(
    runtimeToken: number,
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): Promise<void> {
    if (this.runtimeCallbackGate.bufferStatusDuringHandoff(agentId, runtimeToken, status, pendingCount, contextUsage)) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    await this.getRuntimeStatusProjector().projectStatus({ agentId, status, pendingCount, contextUsage });
  }

  async handleRuntimeSessionEvent(
    runtimeTokenOrAgentId: number | string,
    agentIdOrEvent: string | RuntimeSessionEvent,
    maybeEvent?: RuntimeSessionEvent
  ): Promise<boolean> {
    const invokedWithExplicitToken = typeof runtimeTokenOrAgentId === "number";
    const runtimeToken = invokedWithExplicitToken ? runtimeTokenOrAgentId : undefined;
    const agentId = invokedWithExplicitToken
      ? (agentIdOrEvent as string)
      : runtimeTokenOrAgentId;
    const event = invokedWithExplicitToken ? maybeEvent : (agentIdOrEvent as RuntimeSessionEvent);

    if (!event) {
      return false;
    }

    if (this.runtimeCallbackGate.shouldIgnoreRuntimeSessionEvent(agentId, runtimeToken, event.type)) {
      return false;
    }

    await this.getRuntimeEventProjector().projectEvent({ agentId, runtimeToken, event });
    return true;
  }

  async handleRuntimeError(
    runtimeTokenOrAgentId: number | string,
    agentIdOrError: string | RuntimeErrorEvent,
    maybeError?: RuntimeErrorEvent
  ): Promise<void> {
    const invokedWithExplicitToken = typeof runtimeTokenOrAgentId === "number";
    const runtimeToken = invokedWithExplicitToken ? runtimeTokenOrAgentId : undefined;
    const agentId = invokedWithExplicitToken
      ? (agentIdOrError as string)
      : runtimeTokenOrAgentId;
    const error = invokedWithExplicitToken ? maybeError : (agentIdOrError as RuntimeErrorEvent);

    if (!error) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    this.recordObservabilityRuntimeError(agentId, runtimeToken, error);
    await this.getRuntimeErrorProjector().projectError({ agentId, runtimeToken, error });
  }

  async handleRuntimeAgentEnd(runtimeTokenOrAgentId: number | string, maybeAgentId?: string): Promise<void> {
    const runtimeToken = typeof runtimeTokenOrAgentId === "number" ? runtimeTokenOrAgentId : undefined;
    const agentId = typeof runtimeTokenOrAgentId === "number" ? maybeAgentId : runtimeTokenOrAgentId;

    if (!agentId) {
      return;
    }

    if (this.runtimeCallbackGate.bufferAgentEndDuringHandoff(agentId, runtimeToken)) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }
    this.clearTrackedToolPaths(agentId);
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return;
    }

    if (this.shouldSuppressWorkerIdleFinalization(descriptor)) {
      const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
      watchdogState.turnSeq += 1;
      watchdogState.reportedThisTurn = false;
      watchdogState.pendingReportTurnSeq = null;
      watchdogState.deferredFinalizeTurnSeq = null;
      watchdogState.hadStreamingThisTurn = false;
      watchdogState.lastFinalizedTurnSeq = watchdogState.turnSeq;
      this.workerWatchdogState.set(agentId, watchdogState);

      this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
      this.clearWatchdogTimer(agentId);
      this.getRuntimeEventProjector().clearRecoveryAbortedWorkerTurn(agentId);
      return;
    }

    await this.finalizeWorkerIdleTurn(agentId, descriptor, "agent_end");
  }

  private recordObservabilityRuntimeError(agentId: string, runtimeToken: number | undefined, error: RuntimeErrorEvent): void {
    const descriptor = this.descriptors.get(agentId);
    const observability = this.host.getObservabilityService?.();
    if (!descriptor || !observability) {
      return;
    }

    observability.recordRuntimeError({
      agentId,
      managerId: descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId,
      profileId: descriptor.profileId,
      role: descriptor.role,
      runtimeType: descriptor.model.provider === "claude-sdk"
        ? "claude-sdk"
        : descriptor.model.provider === "cursor-sdk"
          ? "cursor-sdk"
          : "pi",
      runtimeToken,
      agentName: descriptor.displayName,
      phase: error.phase,
      message: error.message,
      stack: error.stack,
      details: error.details,
      metadata: {
        modelProvider: descriptor.model.provider,
        modelId: descriptor.model.modelId,
        status: descriptor.status,
      },
    });
  }

  private shouldSuppressWorkerIdleFinalization(descriptor: AgentDescriptor): boolean {
    return this.getRuntimeEventProjector().shouldSuppressWorkerIdleFinalization(descriptor);
  }

  private get descriptors(): Map<string, AgentDescriptor> {
    return this.host.descriptors;
  }

  private get workerWatchdogState(): Map<string, WorkerWatchdogStateLike> {
    return this.host.workerWatchdogState;
  }

  private get watchdogTimerTokens(): Map<string, number> {
    return this.host.watchdogTimerTokens;
  }

  private now(): string {
    return this.host.now();
  }

  private logDebug(message: string, details?: unknown): void {
    this.host.logDebug(message, details);
  }

  private async refreshSessionMetaStatsBySessionId(
    sessionAgentId: string,
    sessionFileOverride?: string
  ): Promise<void> {
    await this.host.refreshSessionMetaStatsBySessionId(sessionAgentId, sessionFileOverride);
  }

  private async refreshSessionMetaStats(
    descriptor: AgentDescriptor,
    sessionFileOverride?: string
  ): Promise<void> {
    await this.host.refreshSessionMetaStats(descriptor, sessionFileOverride);
  }

  private getOrCreateWorkerWatchdogState(agentId: string): WorkerWatchdogStateLike {
    return this.host.getOrCreateWorkerWatchdogState(agentId);
  }

  private clearWatchdogTimer(agentId: string): void {
    this.host.clearWatchdogTimer(agentId);
  }

  private async finalizeWorkerIdleTurn(
    agentId: string,
    descriptor: AgentDescriptor,
    source: "agent_end" | "status_idle" | "deferred"
  ): Promise<void> {
    await this.host.finalizeWorkerIdleTurn(agentId, descriptor, source);
  }

  private mergeRuntimeContextFiles(
    baseAgentsFiles: Array<{ path: string; content: string }>,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ): Array<{ path: string; content: string }> {
    const swarmContextPaths = new Set(options.swarmContextFiles.map((entry) => entry.path));
    const withoutSwarmAndMemory = baseAgentsFiles.filter(
      (entry) => entry.path !== options.memoryContextFile.path && !swarmContextPaths.has(entry.path)
    );

    return [...withoutSwarmAndMemory, ...options.swarmContextFiles, options.memoryContextFile];
  }

  private shouldIgnoreRuntimeCallback(agentId: string, runtimeToken?: number): boolean {
    return this.runtimeCallbackGate.shouldIgnoreRuntimeCallback(agentId, runtimeToken);
  }

  private handleRuntimeExtensionSnapshot(
    runtimeToken: number,
    agentId: string,
    snapshot: AgentRuntimeExtensionSnapshot
  ): void {
    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    this.runtimeBinding.recordRuntimeExtensionSnapshot(agentId, snapshot);
  }

  updateWorkerActivity(agentId: string, event: RuntimeSessionEvent): void {
    this.getRuntimeEventProjector().updateWorkerActivity(agentId, event);
  }

  async resolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor
  ): Promise<AgentModelDescriptor | undefined> {
    return this.specialistFallbackManager?.resolveSpecialistFallbackModelForDescriptor(descriptor);
  }

  private async maybeRecoverWorkerWithSpecialistFallback(
    agentId: string,
    errorMessage: string,
    sourcePhase: "prompt_dispatch" | "prompt_start",
    runtimeToken?: number
  ): Promise<boolean> {
    return this.host.maybeRecoverWorkerWithSpecialistFallback(
      agentId,
      errorMessage,
      sourcePhase,
      runtimeToken
    );
  }
}
