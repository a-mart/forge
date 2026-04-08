import { basename } from "node:path";
import type { AgentRuntimeExtensionSnapshot } from "@forge/protocol";
import type { CredentialPoolService } from "./credential-pool.js";
import { isNonRunningAgentStatus, transitionAgentStatus } from "./agent-state-machine.js";
import type {
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeShutdownOptions,
  SpecialistFallbackReplaySnapshot,
  SwarmAgentRuntime
} from "./runtime-contracts.js";
import { RuntimeFactory } from "./runtime/runtime-factory.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import { inferProviderFromModelId } from "./model-presets.js";
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
  areContextUsagesEqual,
  compareRuntimeExtensionSnapshots,
  createDeferred,
  extractRuntimeMessageText,
  extractVersionedToolPath,
  formatToolExecutionPayload,
  isVersionedWriteToolName,
  normalizeContextUsage,
  normalizeOptionalAgentId,
  normalizeThinkingLevelForProvider,
  previewForLog,
  readPositiveIntegerDetail,
  readStringDetail,
  safeJson,
  shouldRetrySpecialistSpawnWithFallback,
  toDisplayToolName,
  trimToMaxChars,
  trimToMaxCharsFromEnd,
  withManagerTimeout
} from "./swarm-manager-utils.js";
import {
  extractMessageErrorMessage,
  extractMessageStopReason,
  extractMessageText,
  extractRole
} from "./message-utils.js";
import type { VersioningMutation } from "../versioning/versioning-types.js";

const MANUAL_MANAGER_STOP_NOTICE = "Session stopped.";
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 1_500;
const RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS = 500;

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  fallbackModelId?: string;
  fallbackReasoningLevel?: SwarmReasoningLevel;
}

interface BufferedSpecialistFallbackStatus {
  status: AgentStatus;
  pendingCount: number;
  contextUsage?: AgentContextUsage;
}

interface SpecialistFallbackHandoffState {
  suppressedRuntimeToken: number;
  startedAt: string;
  bufferedStatus?: BufferedSpecialistFallbackStatus;
  receivedAgentEnd?: boolean;
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
    buildCodexRuntimeSystemPrompt(descriptor: AgentDescriptor, systemPrompt: string): Promise<string>;
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
  }>;
  getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>>;
  resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string>;
  injectWorkerIdentityContext(descriptor: AgentDescriptor, systemPrompt: string): string;
  resolveSpecialistRosterForProfile(profileId: string): Promise<ResolvedSpecialistDefinitionLike[]>;
  resolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor
  ): Promise<AgentModelDescriptor | undefined>;
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
  isRuntimeInContextRecovery(agentId: string): boolean;
  incrementSessionCompactionCount(
    profileId: string,
    sessionId: string,
    failureLogKey: string
  ): Promise<number | undefined>;
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
  readonly runtimes = new Map<string, SwarmAgentRuntime>();
  readonly runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
  readonly runtimeTokensByAgentId = new Map<string, number>();
  readonly runtimeExtensionSnapshotsByAgentId = new Map<string, AgentRuntimeExtensionSnapshot>();

  private readonly specialistFallbackHandoffsByAgentId = new Map<string, SpecialistFallbackHandoffState>();
  private readonly trackedToolPathsByAgentId = new Map<string, Map<string, { toolName: string; path: string }>>();
  private nextRuntimeToken = 1;
  private readonly runtimeFactory: RuntimeFactory;

  constructor(private readonly host: SwarmRuntimeControllerHost) {
    this.runtimeFactory = new RuntimeFactory({
      host,
      config: host.config,
      now: host.now,
      logDebug: (message, details) => this.logDebug(message, details),
      getPiModelsJsonPath: () => this.host.getPiModelsJsonPathOrThrow(),
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
      buildCodexRuntimeSystemPrompt: async (descriptor, systemPrompt) =>
        this.host.promptService.buildCodexRuntimeSystemPrompt(descriptor, systemPrompt),
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

  listRuntimeExtensionSnapshots(): AgentRuntimeExtensionSnapshot[] {
    return Array.from(this.runtimeExtensionSnapshotsByAgentId.values())
      .map((snapshot) => ({
        ...snapshot,
        extensions: snapshot.extensions.map((extension) => ({
          ...extension,
          events: [...extension.events],
          tools: [...extension.tools]
        })),
        loadErrors: snapshot.loadErrors.map((error) => ({ ...error }))
      }))
      .sort(compareRuntimeExtensionSnapshots);
  }

  attachRuntime(agentId: string, runtime: SwarmAgentRuntime): void {
    this.runtimes.set(agentId, runtime);
  }

  async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken = this.allocateRuntimeToken(descriptor.agentId)
  ): Promise<SwarmAgentRuntime> {
    try {
      return await this.runtimeFactory.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken);
    } catch (error) {
      this.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw error;
    }
  }

  allocateRuntimeToken(agentId: string): number {
    const token = this.nextRuntimeToken;
    this.nextRuntimeToken += 1;
    this.runtimeTokensByAgentId.set(agentId, token);
    return token;
  }

  getRuntimeToken(agentId: string): number | undefined {
    return this.runtimeTokensByAgentId.get(agentId);
  }

  clearRuntimeToken(agentId: string, runtimeToken?: number): void {
    if (runtimeToken !== undefined && !this.isCurrentRuntimeToken(agentId, runtimeToken)) {
      return;
    }

    this.runtimeTokensByAgentId.delete(agentId);
    this.runtimeExtensionSnapshotsByAgentId.delete(agentId);
  }

  detachRuntime(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken !== undefined && !this.isCurrentRuntimeToken(agentId, runtimeToken)) {
      return false;
    }

    this.runtimes.delete(agentId);
    this.clearRuntimeToken(agentId, runtimeToken);
    return true;
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

  async handleRuntimeStatus(
    runtimeToken: number,
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): Promise<void> {
    if (this.bufferSpecialistFallbackStatusDuringHandoff(agentId, runtimeToken, status, pendingCount, contextUsage)) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) return;

    const normalizedContextUsage = normalizeContextUsage(contextUsage);
    const contextUsageChanged = !areContextUsagesEqual(descriptor.contextUsage, normalizedContextUsage);
    let shouldPersist = false;

    if (contextUsageChanged) {
      descriptor.contextUsage = normalizedContextUsage;
    }

    const previousStatus = descriptor.status;
    const nextStatus = transitionAgentStatus(previousStatus, status);
    const statusChanged = previousStatus !== nextStatus;
    if (statusChanged) {
      descriptor.status = nextStatus;
      descriptor.updatedAt = this.now();
      shouldPersist = true;
    }

    if (previousStatus !== "streaming" && nextStatus === "streaming") {
      descriptor.streamingStartedAt = Date.now();
      shouldPersist = true;
    }

    if (descriptor.role === "worker") {
      const effectiveStatus = descriptor.status;
      if (effectiveStatus === "streaming" && !this.workerStallState.has(agentId)) {
        this.workerStallState.set(agentId, {
          lastProgressAt: Date.now(),
          nudgeSent: false,
          nudgeSentAt: null,
          lastToolName: null,
          lastToolInput: null,
          lastToolOutput: null,
          lastDetailedReportAt: null
        });
      } else if (effectiveStatus !== "streaming" && this.workerStallState.has(agentId)) {
        this.workerStallState.delete(agentId);
        this.workerActivityState.delete(agentId);
      }
    }

    if (isNonRunningAgentStatus(nextStatus) && descriptor.contextUsage) {
      descriptor.contextUsage = undefined;
      shouldPersist = true;
    }

    this.descriptors.set(agentId, descriptor);

    if (descriptor.role === "worker" && (statusChanged || contextUsageChanged || nextStatus === "terminated")) {
      await this.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    } else if (descriptor.role === "manager" && statusChanged) {
      await this.refreshSessionMetaStats(descriptor);
    }

    if (shouldPersist) {
      await this.saveStore();
    }

    this.emitStatus(agentId, status, pendingCount, descriptor.contextUsage);
    this.logDebug("runtime:status", {
      agentId,
      status,
      pendingCount,
      contextUsage: descriptor.contextUsage
    });

    if (descriptor.role === "worker") {
      if (nextStatus === "streaming") {
        const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
        watchdogState.hadStreamingThisTurn = true;
        this.workerWatchdogState.set(agentId, watchdogState);
        this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
        this.clearWatchdogTimer(agentId);
        this.removeWorkerFromWatchdogBatchQueues(agentId);
      } else if (nextStatus === "idle" && pendingCount === 0) {
        const watchdogState = this.workerWatchdogState.get(agentId);
        if (watchdogState?.hadStreamingThisTurn) {
          await this.finalizeWorkerIdleTurn(agentId, descriptor, "status_idle");
        }
      }
    }

    if (descriptor.role === "manager") {
      await this.host.cortexService.handleManagerStatusTransition(descriptor, nextStatus, pendingCount);
      if (nextStatus === "idle" && pendingCount === 0) {
        const recycleDisposition = await this.host.applyManagerRuntimeRecyclePolicy(descriptor.agentId, "idle_transition");
        if (recycleDisposition === "recycled") {
          await this.saveStore();
          this.emitAgentsSnapshot();
        }
      }
    }
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
    const effectiveEvent = shouldSurfaceManualStopNotice ? this.host.stripManagerAbortErrorFromEvent(event) : event;

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
        return;

      case "message_update":
      case "tool_execution_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
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
      runtime: descriptor.model.provider.includes("codex-app") ? "codex-app-server" : "pi",
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
        descriptor.compactionCount = autoCount;
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

    if (
      runtimeToken !== undefined &&
      this.bufferSpecialistFallbackAgentEndDuringHandoff(agentId, runtimeToken)
    ) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }
    this.trackedToolPathsByAgentId.delete(agentId);
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return;
    }

    if (this.host.isRuntimeInContextRecovery(agentId)) {
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
      return;
    }

    await this.finalizeWorkerIdleTurn(agentId, descriptor, "agent_end");
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

  private async saveStore(): Promise<void> {
    await this.host.saveStore();
  }

  private emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): void {
    this.host.emitStatus(agentId, status, pendingCount, contextUsage);
  }

  private emitAgentsSnapshot(): void {
    this.host.emitAgentsSnapshot();
  }

  private async updateSessionMetaForWorkerDescriptor(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void> {
    await this.host.updateSessionMetaForWorkerDescriptor(descriptor, resolvedSystemPrompt);
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

  private removeWorkerFromWatchdogBatchQueues(agentId: string): void {
    this.host.removeWorkerFromWatchdogBatchQueues(agentId);
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

  private isCurrentRuntimeToken(agentId: string, runtimeToken: number): boolean {
    return this.runtimeTokensByAgentId.get(agentId) === runtimeToken;
  }

  private getSuppressedSpecialistFallbackHandoff(
    agentId: string,
    runtimeToken?: number
  ): SpecialistFallbackHandoffState | undefined {
    if (runtimeToken === undefined) {
      return undefined;
    }

    const handoff = this.specialistFallbackHandoffsByAgentId.get(agentId);
    if (handoff?.suppressedRuntimeToken === runtimeToken) {
      return handoff;
    }

    return undefined;
  }

  private shouldIgnoreRuntimeCallback(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken === undefined) {
      return false;
    }

    if (this.getSuppressedSpecialistFallbackHandoff(agentId, runtimeToken)) {
      return true;
    }

    return !this.isCurrentRuntimeToken(agentId, runtimeToken);
  }

  private beginSpecialistFallbackHandoff(agentId: string, suppressedRuntimeToken: number): void {
    this.specialistFallbackHandoffsByAgentId.set(agentId, {
      suppressedRuntimeToken,
      startedAt: this.now()
    });
  }

  private bufferSpecialistFallbackStatusDuringHandoff(
    agentId: string,
    runtimeToken: number,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): boolean {
    const handoff = this.getSuppressedSpecialistFallbackHandoff(agentId, runtimeToken);
    if (!handoff) {
      return false;
    }

    handoff.bufferedStatus = {
      status,
      pendingCount,
      contextUsage: normalizeContextUsage(contextUsage)
    };
    this.specialistFallbackHandoffsByAgentId.set(agentId, handoff);
    return true;
  }

  private bufferSpecialistFallbackAgentEndDuringHandoff(agentId: string, runtimeToken: number): boolean {
    const handoff = this.getSuppressedSpecialistFallbackHandoff(agentId, runtimeToken);
    if (!handoff) {
      return false;
    }

    handoff.receivedAgentEnd = true;
    this.specialistFallbackHandoffsByAgentId.set(agentId, handoff);
    return true;
  }

  private endSpecialistFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void {
    const handoff = this.specialistFallbackHandoffsByAgentId.get(agentId);
    if (!handoff) {
      return;
    }

    if (suppressedRuntimeToken !== undefined && handoff.suppressedRuntimeToken !== suppressedRuntimeToken) {
      return;
    }

    this.specialistFallbackHandoffsByAgentId.delete(agentId);
  }

  private async reconcileBufferedSpecialistFallbackCallbacksOnAbort(
    agentId: string,
    suppressedRuntimeToken: number | undefined
  ): Promise<void> {
    if (suppressedRuntimeToken === undefined) {
      return;
    }

    const handoffState = this.getSuppressedSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
    this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
    if (!handoffState) {
      return;
    }

    if (handoffState.bufferedStatus) {
      await this.handleRuntimeStatus(
        suppressedRuntimeToken,
        agentId,
        handoffState.bufferedStatus.status,
        handoffState.bufferedStatus.pendingCount,
        handoffState.bufferedStatus.contextUsage
      );
    }

    if (handoffState.receivedAgentEnd) {
      await this.handleRuntimeAgentEnd(suppressedRuntimeToken, agentId);
    }
  }

  private handleRuntimeExtensionSnapshot(
    runtimeToken: number,
    agentId: string,
    snapshot: AgentRuntimeExtensionSnapshot
  ): void {
    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    this.runtimeExtensionSnapshotsByAgentId.set(agentId, {
      ...snapshot,
      extensions: snapshot.extensions.map((extension) => ({
        ...extension,
        events: [...extension.events],
        tools: [...extension.tools]
      })),
      loadErrors: snapshot.loadErrors.map((error) => ({ ...error }))
    });
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
        return;

      default:
        return;
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
    if (descriptor.role !== "worker" || !descriptor.specialistId || !descriptor.profileId) {
      return undefined;
    }

    const specialistId = normalizeOptionalAgentId(descriptor.specialistId)?.toLowerCase();
    if (!specialistId) {
      return undefined;
    }

    const roster = await this.host.resolveSpecialistRosterForProfile(descriptor.profileId);
    const specialist = roster.find((entry) => entry.specialistId === specialistId);
    if (!specialist?.fallbackModelId) {
      return undefined;
    }

    const inferredFallbackProvider = inferProviderFromModelId(specialist.fallbackModelId);
    if (!inferredFallbackProvider) {
      return undefined;
    }

    let fallbackModel: AgentModelDescriptor = {
      provider: inferredFallbackProvider,
      modelId: specialist.fallbackModelId,
      thinkingLevel: specialist.fallbackReasoningLevel ?? descriptor.model.thinkingLevel
    };
    fallbackModel.thinkingLevel = normalizeThinkingLevelForProvider(
      fallbackModel.provider,
      fallbackModel.thinkingLevel
    );
    return this.host.resolveSpawnModelWithCapacityFallback(fallbackModel);
  }

  private async maybeRecoverWorkerWithSpecialistFallback(
    agentId: string,
    errorMessage: string,
    sourcePhase: "prompt_dispatch" | "prompt_start",
    runtimeToken?: number
  ): Promise<boolean> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return false;
    }

    if (!shouldRetrySpecialistSpawnWithFallback(new Error(errorMessage), descriptor.model)) {
      return false;
    }

    const currentRuntime = this.runtimes.get(agentId);
    const suppressedRuntimeToken = runtimeToken ?? this.runtimeTokensByAgentId.get(agentId);
    if (!currentRuntime) {
      return false;
    }

    const previousModel = { ...descriptor.model };
    const previousStatus = descriptor.status;
    const previousUpdatedAt = descriptor.updatedAt;
    const previousStreamingStartedAt = descriptor.streamingStartedAt;
    const previousContextUsage = descriptor.contextUsage ? { ...descriptor.contextUsage } : undefined;
    const previousRuntimeSystemPrompt = currentRuntime.getSystemPrompt?.();

    let fallbackModel: AgentModelDescriptor | undefined;
    let replaySnapshot: SpecialistFallbackReplaySnapshot | undefined;
    let replacementRuntime: SwarmAgentRuntime | undefined;
    let replacementRuntimeToken: number | undefined;
    let runtimeSystemPrompt = "";
    let recovered = false;
    let handoffStarted = false;
    let deferredSettled = false;
    const fallbackRuntimeDeferred = createDeferred<SwarmAgentRuntime>();
    fallbackRuntimeDeferred.promise.catch(() => {});
    const resolveWaiters = (runtime: SwarmAgentRuntime): void => {
      if (deferredSettled) {
        return;
      }
      deferredSettled = true;
      fallbackRuntimeDeferred.resolve(runtime);
    };
    const rejectWaiters = (reason: unknown): void => {
      if (deferredSettled) {
        return;
      }
      deferredSettled = true;
      fallbackRuntimeDeferred.reject(reason);
    };

    this.runtimeCreationPromisesByAgentId.set(agentId, fallbackRuntimeDeferred.promise);

    if (suppressedRuntimeToken !== undefined) {
      this.beginSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
      handoffStarted = true;
    }

    try {
      fallbackModel = await this.host.resolveSpecialistFallbackModelForDescriptor(descriptor);
      if (!fallbackModel) {
        await this.reconcileBufferedSpecialistFallbackCallbacksOnAbort(agentId, suppressedRuntimeToken);
        resolveWaiters(currentRuntime);
        return false;
      }

      if (
        fallbackModel.provider === descriptor.model.provider &&
        fallbackModel.modelId === descriptor.model.modelId &&
        fallbackModel.thinkingLevel === descriptor.model.thinkingLevel
      ) {
        await this.reconcileBufferedSpecialistFallbackCallbacksOnAbort(agentId, suppressedRuntimeToken);
        resolveWaiters(currentRuntime);
        return false;
      }

      replaySnapshot = await currentRuntime.prepareForSpecialistFallbackReplay?.();
      if (!replaySnapshot) {
        await this.reconcileBufferedSpecialistFallbackCallbacksOnAbort(agentId, suppressedRuntimeToken);
        resolveWaiters(currentRuntime);
        return false;
      }

      const fallbackDescriptor: AgentDescriptor = {
        ...descriptor,
        model: { ...fallbackModel },
        status: "idle",
        updatedAt: this.now(),
        contextUsage: undefined
      };
      delete fallbackDescriptor.streamingStartedAt;

      const baseSystemPrompt = await this.host.resolveSystemPromptForDescriptor(fallbackDescriptor);
      runtimeSystemPrompt = this.host.injectWorkerIdentityContext(fallbackDescriptor, baseSystemPrompt);
      replacementRuntime = await this.host.createRuntimeForDescriptor(fallbackDescriptor, runtimeSystemPrompt);
      replacementRuntimeToken = this.runtimeTokensByAgentId.get(agentId);

      if (!this.isSpecialistFallbackHandoffStillValid(agentId, currentRuntime)) {
        await this.discardSpecialistFallbackReplacementRuntime(agentId, replacementRuntime, replacementRuntimeToken);
        rejectWaiters(new Error(`Specialist fallback handoff was cancelled for ${agentId}`));
        if (suppressedRuntimeToken !== undefined) {
          this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
        }
        recovered = true;
        return true;
      }

      descriptor.model = { ...fallbackDescriptor.model };
      descriptor.status = fallbackDescriptor.status;
      descriptor.updatedAt = fallbackDescriptor.updatedAt;
      descriptor.contextUsage = undefined;
      delete descriptor.streamingStartedAt;
      this.descriptors.set(agentId, descriptor);
      await this.saveStore();

      this.attachRuntime(agentId, replacementRuntime);

      const persistedSystemPrompt = replacementRuntime.getSystemPrompt?.() ?? runtimeSystemPrompt;
      await this.updateSessionMetaForWorkerDescriptor(descriptor, persistedSystemPrompt);
      await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);

      this.emitStatus(agentId, descriptor.status, replacementRuntime.getPendingCount(), replacementRuntime.getContextUsage());
      this.emitAgentsSnapshot();

      if (!this.isSpecialistFallbackHandoffStillValid(agentId, replacementRuntime)) {
        await this.discardSpecialistFallbackReplacementRuntime(agentId, replacementRuntime, replacementRuntimeToken);
        rejectWaiters(new Error(`Specialist fallback replay was cancelled for ${agentId}`));
        if (suppressedRuntimeToken !== undefined) {
          this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
        }
        recovered = true;
        return true;
      }

      this.logDebug("worker:specialist_fallback:rerouted", {
        agentId,
        specialistId: descriptor.specialistId,
        sourcePhase,
        previousModel,
        fallbackModel: descriptor.model,
        message: errorMessage,
        replayPreview: previewForLog(extractRuntimeMessageText(replaySnapshot.messages[0]), 160),
        replayMessageCount: replaySnapshot.messages.length
      });

      await this.replaySpecialistFallbackSnapshot(replacementRuntime, replaySnapshot);
      resolveWaiters(replacementRuntime);
      if (suppressedRuntimeToken !== undefined) {
        this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
      }

      void currentRuntime.terminate({ abort: true }).catch((shutdownError) => {
        this.logDebug("worker:specialist_fallback:previous_runtime_shutdown_error", {
          agentId,
          specialistId: descriptor.specialistId,
          message: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
        });
      });

      recovered = true;
      return true;
    } catch (fallbackError) {
      const failureDisposition = this.getSpecialistFallbackFailureDisposition(
        agentId,
        currentRuntime,
        replacementRuntime,
        suppressedRuntimeToken
      );
      await this.discardSpecialistFallbackReplacementRuntime(agentId, replacementRuntime, replacementRuntimeToken);
      let rollbackError: unknown;
      try {
        if (failureDisposition === "restore_original_runtime") {
          await currentRuntime.restorePreparedSpecialistFallbackReplay?.();
          await this.restoreWorkerAfterFailedSpecialistFallback(
            descriptor,
            currentRuntime,
            suppressedRuntimeToken,
            {
              previousModel,
              previousStatus,
              previousUpdatedAt,
              previousStreamingStartedAt,
              previousContextUsage,
              previousRuntimeSystemPrompt
            }
          );
          resolveWaiters(currentRuntime);
        } else {
          await this.terminateSuppressedSpecialistFallbackRuntime(agentId, currentRuntime);
          rejectWaiters(
            new Error(
              failureDisposition === "interrupted"
                ? `Specialist fallback replay was interrupted for ${agentId}`
                : `Specialist fallback replay failed and original runtime is unavailable for ${agentId}`
            )
          );
          if (suppressedRuntimeToken !== undefined) {
            this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
          }
          recovered = failureDisposition === "interrupted";
        }
      } catch (restoreError) {
        rollbackError = restoreError;
        rejectWaiters(restoreError);
      }

      this.logDebug("worker:specialist_fallback:failed", {
        agentId,
        specialistId: descriptor.specialistId,
        sourcePhase,
        previousModel,
        fallbackModel,
        message: errorMessage,
        replayPreview: replaySnapshot
          ? previewForLog(extractRuntimeMessageText(replaySnapshot.messages[0]), 160)
          : undefined,
        replayMessageCount: replaySnapshot?.messages.length ?? 0,
        failureDisposition,
        fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError ?? "")
      });
      return failureDisposition === "interrupted";
    } finally {
      if (handoffStarted && !recovered && suppressedRuntimeToken !== undefined) {
        this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
      }

      if (!deferredSettled) {
        rejectWaiters(new Error(`Specialist fallback handoff did not settle for ${agentId}`));
      }

      if (this.runtimeCreationPromisesByAgentId.get(agentId) === fallbackRuntimeDeferred.promise) {
        this.runtimeCreationPromisesByAgentId.delete(agentId);
      }
    }
  }

  private async replaySpecialistFallbackSnapshot(
    runtime: SwarmAgentRuntime,
    replaySnapshot: SpecialistFallbackReplaySnapshot
  ): Promise<void> {
    for (const [index, replayMessage] of replaySnapshot.messages.entries()) {
      await runtime.sendMessage(replayMessage, index === 0 ? "auto" : "steer");
    }
  }

  private isSpecialistFallbackHandoffStillValid(
    agentId: string,
    expectedRuntime: SwarmAgentRuntime
  ): boolean {
    const latestDescriptor = this.descriptors.get(agentId);
    if (!latestDescriptor || latestDescriptor.role !== "worker") {
      return false;
    }

    if (isNonRunningAgentStatus(latestDescriptor.status)) {
      return false;
    }

    return this.runtimes.get(agentId) === expectedRuntime;
  }

  private async discardSpecialistFallbackReplacementRuntime(
    agentId: string,
    replacementRuntime: SwarmAgentRuntime | undefined,
    replacementRuntimeToken: number | undefined
  ): Promise<void> {
    if (replacementRuntime) {
      try {
        await replacementRuntime.terminate({
          abort: true,
          shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
          drainTimeoutMs: RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
        });
      } catch (shutdownError) {
        this.logDebug("worker:specialist_fallback:replacement_runtime_shutdown_error", {
          agentId,
          message: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
        });
      }
    }

    if (replacementRuntimeToken !== undefined) {
      this.detachRuntime(agentId, replacementRuntimeToken);
    } else if (replacementRuntime && this.runtimes.get(agentId) === replacementRuntime) {
      this.runtimes.delete(agentId);
    }
  }

  private async terminateSuppressedSpecialistFallbackRuntime(
    agentId: string,
    runtime: SwarmAgentRuntime
  ): Promise<void> {
    try {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
        drainTimeoutMs: RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
      });
    } catch (shutdownError) {
      this.logDebug("worker:specialist_fallback:suppressed_runtime_shutdown_error", {
        agentId,
        message: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
      });
    }
  }

  private getSpecialistFallbackFailureDisposition(
    agentId: string,
    currentRuntime: SwarmAgentRuntime,
    replacementRuntime: SwarmAgentRuntime | undefined,
    suppressedRuntimeToken: number | undefined
  ): "restore_original_runtime" | "interrupted" | "original_runtime_unavailable" {
    const latestDescriptor = this.descriptors.get(agentId);
    if (!latestDescriptor || latestDescriptor.role !== "worker") {
      return "interrupted";
    }

    if (isNonRunningAgentStatus(latestDescriptor.status)) {
      return "interrupted";
    }

    if (replacementRuntime && this.runtimes.get(agentId) !== replacementRuntime) {
      return "interrupted";
    }

    const handoffState =
      suppressedRuntimeToken !== undefined
        ? this.getSuppressedSpecialistFallbackHandoff(agentId, suppressedRuntimeToken)
        : undefined;
    const originalRuntimeStatus = handoffState?.bufferedStatus?.status ?? currentRuntime.getStatus();
    if (isNonRunningAgentStatus(originalRuntimeStatus)) {
      return "original_runtime_unavailable";
    }

    return "restore_original_runtime";
  }

  private async restoreWorkerAfterFailedSpecialistFallback(
    descriptor: AgentDescriptor,
    currentRuntime: SwarmAgentRuntime,
    suppressedRuntimeToken: number | undefined,
    previousState: {
      previousModel: AgentModelDescriptor;
      previousStatus: AgentStatus;
      previousUpdatedAt: string;
      previousStreamingStartedAt?: number;
      previousContextUsage?: AgentContextUsage;
      previousRuntimeSystemPrompt?: string | null;
    }
  ): Promise<void> {
    const handoffState =
      suppressedRuntimeToken !== undefined
        ? this.getSuppressedSpecialistFallbackHandoff(descriptor.agentId, suppressedRuntimeToken)
        : undefined;
    const reconciledStatus = handoffState?.bufferedStatus?.status ?? currentRuntime.getStatus();
    const reconciledContextUsage =
      handoffState?.bufferedStatus?.contextUsage ?? currentRuntime.getContextUsage() ?? previousState.previousContextUsage;

    descriptor.model = previousState.previousModel;
    descriptor.status = reconciledStatus;
    descriptor.updatedAt = previousState.previousUpdatedAt;
    descriptor.contextUsage = isNonRunningAgentStatus(reconciledStatus) ? undefined : reconciledContextUsage;
    if (reconciledStatus === "streaming" && previousState.previousStreamingStartedAt !== undefined) {
      descriptor.streamingStartedAt = previousState.previousStreamingStartedAt;
    } else {
      delete descriptor.streamingStartedAt;
    }
    this.descriptors.set(descriptor.agentId, descriptor);
    this.attachRuntime(descriptor.agentId, currentRuntime);
    if (suppressedRuntimeToken !== undefined) {
      this.runtimeTokensByAgentId.set(descriptor.agentId, suppressedRuntimeToken);
    }

    this.reconcileWorkerRuntimeStateAfterFallbackRollback(descriptor.agentId, reconciledStatus, handoffState);

    try {
      await this.saveStore();
    } catch (saveError) {
      this.logDebug("worker:specialist_fallback:rollback_save_failed", {
        agentId: descriptor.agentId,
        specialistId: descriptor.specialistId,
        message: saveError instanceof Error ? saveError.message : String(saveError)
      });
    }

    await this.updateSessionMetaForWorkerDescriptor(
      descriptor,
      previousState.previousRuntimeSystemPrompt ?? undefined
    );
    await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);

    this.emitStatus(
      descriptor.agentId,
      descriptor.status,
      handoffState?.bufferedStatus?.pendingCount ?? currentRuntime.getPendingCount(),
      descriptor.contextUsage
    );
    this.emitAgentsSnapshot();
  }

  private reconcileWorkerRuntimeStateAfterFallbackRollback(
    agentId: string,
    restoredStatus: AgentStatus,
    handoffState?: SpecialistFallbackHandoffState
  ): void {
    if (restoredStatus === "streaming") {
      if (!this.workerStallState.has(agentId)) {
        this.workerStallState.set(agentId, {
          lastProgressAt: Date.now(),
          nudgeSent: false,
          nudgeSentAt: null,
          lastToolName: null,
          lastToolInput: null,
          lastToolOutput: null,
          lastDetailedReportAt: null
        });
      }
    } else {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
    }

    if (!handoffState?.receivedAgentEnd) {
      return;
    }

    this.trackedToolPathsByAgentId.delete(agentId);

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
  }
}
