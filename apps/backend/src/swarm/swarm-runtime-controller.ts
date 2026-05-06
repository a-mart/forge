import { basename } from "node:path";
import type { AgentRuntimeExtensionSnapshot } from "@forge/protocol";
import type { ForgeExtensionHost } from "./forge-extension-host.js";
import { createForgeBindingToken } from "./forge-extension-types.js";
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
import {
  extractVersionedToolPath,
  formatToolExecutionPayload,
  isVersionedWriteToolName,
  previewForLog,
  readPositiveIntegerDetail,
  readStringDetail,
  safeJson,
  trimToMaxChars,
  trimToMaxCharsFromEnd,
  withManagerTimeout
} from "./swarm-manager-utils.js";
import {
  extractMessageErrorMessage,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  isAbortLikeErrorMessage
} from "./message-utils.js";
import type { VersioningMutation } from "../versioning/versioning-types.js";
import type { SwarmSpecialistFallbackManager } from "./swarm-specialist-fallback-manager.js";

const MANUAL_MANAGER_STOP_NOTICE = "Session stopped.";
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 1_500;
const RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS = 500;

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  fallbackModelId?: string;
  fallbackReasoningLevel?: SwarmReasoningLevel;
}

export interface WorkerWatchdogStateLike {
  turnSeq: number;
  reportedThisTurn: boolean;
  pendingReportTurnSeq: number | null;
  deferredFinalizeTurnSeq: number | null;
  hadStreamingThisTurn: boolean;
  lastFinalizedTurnSeq: number | null;
}

export interface WorkerStallStateLike {
  lastProgressAt: number;
  nudgeSent: boolean;
  nudgeSentAt: number | null;
  lastToolName: string | null;
  lastToolInput: string | null;
  lastToolOutput: string | null;
  lastDetailedReportAt: number | null;
}

export interface WorkerActivityStateLike {
  currentToolName: string | null;
  currentToolStartedAt: number | null;
  lastProgressAt: number;
  toolCallCount: number;
  errorCount: number;
  turnCount: number;
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
  conversationProjector: {
    captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent): void;
    emitConversationMessage(event: ConversationMessageEvent): void;
  };
  promptService: {
    buildClaudeRuntimeSystemPrompt(descriptor: AgentDescriptor, systemPrompt: string): Promise<string>;
    buildAcpRuntimeSystemPrompt(descriptor: AgentDescriptor, systemPrompt: string): Promise<string>;
  };
  secretsEnvService: {
    getCredentialPoolService(): CredentialPoolService;
  };
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
    reason: "model_change" | "cwd_change" | "idle_transition" | "prompt_mode_change" | "project_agent_directory_change" | "specialist_roster_change"
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
  private readonly trackedToolPathsByAgentId = new Map<string, Map<string, { toolName: string; path: string }>>();
  private readonly recoveryAbortedWorkerTurnAgentIds = new Set<string>();
  private readonly runtimeBinding: RuntimeBinding;
  private readonly runtimeCallbackGate: RuntimeCallbackGate;
  private readonly runtimeFactory: RuntimeFactory;
  private runtimeStatusProjector: RuntimeStatusProjector | null = null;

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
      onSessionFileRotated: async (descriptor, sessionFile) => {
        if (descriptor.role !== "manager") {
          await this.refreshSessionMetaStatsBySessionId(descriptor.managerId, sessionFile);
          return;
        }

        await this.refreshSessionMetaStats(descriptor, sessionFile);
      },
      getMemoryRuntimeResources: async (descriptor) => this.host.getMemoryRuntimeResources(descriptor),
      getSwarmContextFiles: async (cwd) => this.host.getSwarmContextFiles(cwd),
      buildClaudeRuntimeSystemPrompt: async (descriptor, systemPrompt) =>
        this.host.promptService.buildClaudeRuntimeSystemPrompt(descriptor, systemPrompt),
      buildAcpRuntimeSystemPrompt: async (descriptor, systemPrompt) =>
        this.host.promptService.buildAcpRuntimeSystemPrompt(descriptor, systemPrompt),
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

  clearTrackedToolPaths(agentId: string): void {
    this.trackedToolPathsByAgentId.delete(agentId);
  }

  suppressIntentionalStopRuntimeCallbacks(agentId: string, runtimeToken?: number): void {
    this.runtimeCallbackGate.suppressIntentionalStopRuntimeCallbacks(agentId, runtimeToken);
  }

  clearIntentionalStopRuntimeCallbackSuppression(agentId: string, runtimeToken?: number): void {
    this.runtimeCallbackGate.clearIntentionalStopRuntimeCallbackSuppression(agentId, runtimeToken);
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
  ): Promise<void> {
    const invokedWithExplicitToken = typeof runtimeTokenOrAgentId === "number";
    const runtimeToken = invokedWithExplicitToken ? runtimeTokenOrAgentId : undefined;
    const agentId = invokedWithExplicitToken
      ? (agentIdOrEvent as string)
      : runtimeTokenOrAgentId;
    const event = invokedWithExplicitToken ? maybeEvent : (agentIdOrEvent as RuntimeSessionEvent);

    if (!event) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    const descriptor = this.descriptors.get(agentId);
    if (
      descriptor?.role === "worker" &&
      event.type === "message_end" &&
      extractMessageStopReason(event.message) === "error"
    ) {
      const errorText =
        extractMessageErrorMessage(event.message) ??
        extractMessageText(event.message) ??
        "Unknown runtime error";
      const parentRecoveryActive = descriptor.managerId
        ? this.host.isRuntimeRecoveryActive(descriptor.managerId)
        : false;
      if (
        extractRole(event.message) === "assistant" &&
        isAbortLikeErrorMessage(errorText) &&
        (this.host.isRuntimeRecoveryActive(agentId) || parentRecoveryActive)
      ) {
        this.recoveryAbortedWorkerTurnAgentIds.add(agentId);
        return;
      }

      this.host.maybeRecordModelCapacityBlock(agentId, descriptor, {
        phase: "prompt_start",
        message: errorText
      });

      const recoveredWithFallback = await this.maybeRecoverWorkerWithSpecialistFallback(
        agentId,
        errorText,
        "prompt_start",
        runtimeToken
      );
      if (recoveredWithFallback) {
        return;
      }
    }

    const shouldSurfaceManualStopNotice =
      descriptor?.role === "manager" && this.host.consumePendingManualManagerStopNoticeIfApplicable(agentId, event);

    // Also suppress abort errors during context recovery (smart compaction) — the abort is intentional
    const isContextRecoveryAbort =
      !shouldSurfaceManualStopNotice &&
      descriptor?.role === "manager" &&
      this.host.isRuntimeRecoveryActive(agentId) &&
      event.type === "message_end" &&
      extractMessageStopReason(event.message) === "error" &&
      isAbortLikeErrorMessage(extractMessageErrorMessage(event.message) ?? extractMessageText(event.message));

    const effectiveEvent = (shouldSurfaceManualStopNotice || isContextRecoveryAbort)
      ? this.host.stripManagerAbortErrorFromEvent(event)
      : event;

    this.host.conversationProjector.captureConversationEventFromRuntime(agentId, effectiveEvent);
    if (shouldSurfaceManualStopNotice) {
      this.host.conversationProjector.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: MANUAL_MANAGER_STOP_NOTICE,
        timestamp: this.now(),
        source: "system"
      });
    }
    this.maybeRecordVersionedToolMutation(agentId, effectiveEvent);

    if (descriptor?.role === "worker") {
      this.trackWorkerStallProgressEvent(descriptor.agentId, effectiveEvent);
      this.updateWorkerActivity(descriptor.agentId, effectiveEvent);
    }

    if (!this.host.config.debug) return;

    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    switch (effectiveEvent.type) {
      case "agent_start":
      case "agent_end":
      case "turn_start":
        this.logDebug(`manager:event:${event.type}`);
        return;

      case "turn_end":
        this.logDebug("manager:event:turn_end", {
          toolResults: effectiveEvent.toolResults.length
        });
        return;

      case "tool_execution_start":
        this.logDebug("manager:tool:start", {
          toolName: effectiveEvent.toolName,
          toolCallId: effectiveEvent.toolCallId,
          args: previewForLog(safeJson(effectiveEvent.args), 240)
        });
        return;

      case "tool_execution_end":
        this.logDebug("manager:tool:end", {
          toolName: effectiveEvent.toolName,
          toolCallId: effectiveEvent.toolCallId,
          isError: effectiveEvent.isError,
          result: previewForLog(safeJson(effectiveEvent.result), 240)
        });
        return;

      case "message_start":
      case "message_end":
        this.logDebug(`manager:event:${effectiveEvent.type}`, {
          role: extractRole(effectiveEvent.message),
          textPreview: previewForLog(extractMessageText(effectiveEvent.message) ?? "")
        });
        break;

      case "message_update":
      case "tool_execution_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        break;
    }
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
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }

    const message = error.message.trim().length > 0 ? error.message.trim() : "Unknown runtime error";
    this.host.maybeRecordModelCapacityBlock(agentId, descriptor, {
      ...error,
      message
    });

    const forgeBindingRuntimeToken = runtimeToken ?? this.runtimeTokensByAgentId.get(agentId);
    if (forgeBindingRuntimeToken !== undefined) {
      await this.host.forgeExtensionHost.dispatchRuntimeError(createForgeBindingToken(forgeBindingRuntimeToken), {
        ...error,
        message
      });
    }

    if (error.phase === "prompt_dispatch" || error.phase === "prompt_start") {
      const recoveredWithFallback = await this.maybeRecoverWorkerWithSpecialistFallback(
        agentId,
        message,
        error.phase,
        runtimeToken
      );
      if (recoveredWithFallback) {
        return;
      }
    }

    const attempt = readPositiveIntegerDetail(error.details, "attempt");
    const maxAttempts = readPositiveIntegerDetail(error.details, "maxAttempts");
    const droppedPendingCount = readPositiveIntegerDetail(error.details, "droppedPendingCount");
    const recoveryStage = readStringDetail(error.details, "recoveryStage");

    this.logDebug("runtime:error", {
      agentId,
      runtime:
        descriptor.model.provider.includes("cursor-acp")
          ? "cursor-acp"
          : descriptor.model.provider.includes("claude-sdk")
            ? "claude-sdk"
            : "pi",
      phase: error.phase,
      message,
      stack: error.stack,
      details: error.details
    });

    const retryLabel =
      attempt && maxAttempts && maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";

    const extensionPath = readStringDetail(error.details, "extensionPath");
    const extensionEvent = readStringDetail(error.details, "event");
    const extensionBaseName = extensionPath ? basename(extensionPath) : undefined;
    const userFacingMessage = readStringDetail(error.details, "userFacingMessage");

    if (error.phase === "compaction" && recoveryStage === "auto_compaction_succeeded" && descriptor.profileId) {
      const autoCount = await this.host.incrementSessionCompactionCount(
        descriptor.profileId,
        agentId,
        "runtime:compact:count-increment-failed"
      );
      if (autoCount !== undefined) {
        await this.host.patchDescriptorFromRuntimeStatus(agentId, { compactionCount: autoCount });
      }
    }

    const text =
      userFacingMessage
      ?? (
        error.phase === "compaction"
          ? recoveryStage === "auto_compaction_succeeded"
            ? `📋 ${message}.`
            : recoveryStage === "recovery_failed"
              ? `🚨 Context recovery failed: ${message}. Start a new session or manually trim history/compact before continuing.`
              : `⚠️ Compaction error${retryLabel}: ${message}. Attempting fallback recovery.`
          : error.phase === "context_guard"
            ? recoveryStage === "guard_started"
              ? `📋 ${message}.`
              : `⚠️ Context guard error${retryLabel}: ${message}.`
            : error.phase === "extension"
              ? extensionBaseName && extensionEvent
                ? `⚠️ Extension error (${extensionBaseName} · ${extensionEvent}): ${message}`
                : extensionBaseName
                  ? `⚠️ Extension error (${extensionBaseName}): ${message}`
                  : `⚠️ Extension error: ${message}`
              : droppedPendingCount && droppedPendingCount > 0
                ? `⚠️ Agent error${retryLabel}: ${message}. ${droppedPendingCount} queued message${droppedPendingCount === 1 ? "" : "s"} could not be delivered and were dropped. Please resend.`
                : `⚠️ Agent error${retryLabel}: ${message}. Message may need to be resent.`
      );

    this.host.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text,
      timestamp: this.now(),
      source: "system"
    });
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
      this.recoveryAbortedWorkerTurnAgentIds.delete(agentId);
      return;
    }

    await this.finalizeWorkerIdleTurn(agentId, descriptor, "agent_end");
  }

  private shouldSuppressWorkerIdleFinalization(descriptor: AgentDescriptor): boolean {
    return this.recoveryAbortedWorkerTurnAgentIds.has(descriptor.agentId) || this.host.isRuntimeRecoveryActive(descriptor.agentId);
  }

  private get descriptors(): Map<string, AgentDescriptor> {
    return this.host.descriptors;
  }

  private get workerWatchdogState(): Map<string, WorkerWatchdogStateLike> {
    return this.host.workerWatchdogState;
  }

  private get workerStallState(): Map<string, WorkerStallStateLike> {
    return this.host.workerStallState;
  }

  private get workerActivityState(): Map<string, WorkerActivityStateLike> {
    return this.host.workerActivityState;
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

  private trackWorkerStallProgressEvent(agentId: string, event: RuntimeSessionEvent): void {
    const stallState = this.workerStallState.get(agentId);
    if (!stallState) {
      return;
    }

    switch (event.type) {
      case "tool_execution_start": {
        stallState.lastToolName = event.toolName;
        stallState.lastToolInput = trimToMaxChars(formatToolExecutionPayload(event.args), 500);
        stallState.lastToolOutput = null;
        this.workerStallState.set(agentId, stallState);
        return;
      }

      case "tool_execution_update": {
        stallState.lastToolName = event.toolName;
        const chunk = formatToolExecutionPayload(event.partialResult);
        const mergedOutput = `${stallState.lastToolOutput ?? ""}${chunk}`;
        stallState.lastToolOutput = trimToMaxCharsFromEnd(mergedOutput, 500);
        this.workerStallState.set(agentId, stallState);
        return;
      }

      case "tool_execution_end":
      case "turn_end":
        this.recordWorkerStallProgress(agentId);
        return;

      case "message_update":
      case "message_end": {
        const role = extractRole(event.message);
        if (role === "assistant" || role === "system") {
          this.recordWorkerStallProgress(agentId);
        }
        return;
      }

      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        this.recordWorkerStallProgress(agentId);
        break;

      default:
        break;
    }
  }

  updateWorkerActivity(agentId: string, event: RuntimeSessionEvent): void {
    if (!this.workerStallState.has(agentId)) {
      this.workerActivityState.delete(agentId);
      return;
    }

    let state = this.workerActivityState.get(agentId);
    if (!state) {
      state = {
        currentToolName: null,
        currentToolStartedAt: null,
        lastProgressAt: Date.now(),
        toolCallCount: 0,
        errorCount: 0,
        turnCount: 0
      };
      this.workerActivityState.set(agentId, state);
    }

    switch (event.type) {
      case "tool_execution_start":
        state.currentToolName = event.toolName;
        state.currentToolStartedAt = Date.now();
        state.toolCallCount++;
        state.lastProgressAt = Date.now();
        break;

      case "tool_execution_end":
        state.currentToolName = null;
        state.currentToolStartedAt = null;
        if (event.isError) {
          state.errorCount++;
        }
        state.lastProgressAt = Date.now();
        break;

      case "turn_end":
        state.turnCount++;
        state.lastProgressAt = Date.now();
        break;

      case "message_update":
      case "message_end":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        state.lastProgressAt = Date.now();
        break;

      default:
        break;
    }
  }

  private recordWorkerStallProgress(agentId: string): void {
    const stallState = this.workerStallState.get(agentId);
    if (!stallState) {
      return;
    }

    stallState.lastProgressAt = Date.now();
    stallState.lastDetailedReportAt = null;
    stallState.lastToolName = null;
    stallState.lastToolInput = null;
    stallState.lastToolOutput = null;

    if (stallState.nudgeSent) {
      stallState.nudgeSent = false;
      stallState.nudgeSentAt = null;
    }

    this.workerStallState.set(agentId, stallState);
  }

  private maybeRecordVersionedToolMutation(agentId: string, event: RuntimeSessionEvent): void {
    if (event.type === "tool_execution_start") {
      if (!isVersionedWriteToolName(event.toolName)) {
        return;
      }

      const path = extractVersionedToolPath(event.args);
      if (!path) {
        return;
      }

      const byToolCallId = this.trackedToolPathsByAgentId.get(agentId) ?? new Map<string, { toolName: string; path: string }>();
      byToolCallId.set(event.toolCallId, { toolName: event.toolName, path });
      this.trackedToolPathsByAgentId.set(agentId, byToolCallId);
      return;
    }

    if (event.type !== "tool_execution_end" || event.isError || !isVersionedWriteToolName(event.toolName)) {
      return;
    }

    const descriptor = this.descriptors.get(agentId);
    const tracked = this.trackedToolPathsByAgentId.get(agentId)?.get(event.toolCallId);
    this.trackedToolPathsByAgentId.get(agentId)?.delete(event.toolCallId);

    const path = tracked?.path ?? extractVersionedToolPath(event.result);
    if (!descriptor || !path) {
      return;
    }

    void this.host.queueVersionedToolMutation(descriptor, {
      path,
      action: "write",
      source: tracked?.toolName === "edit" ? "agent-edit-tool" : "agent-write-tool",
      profileId: descriptor.profileId ?? descriptor.agentId,
      sessionId: descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId,
      agentId
    });
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
