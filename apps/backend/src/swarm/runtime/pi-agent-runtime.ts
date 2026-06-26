import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent, AuthCredential } from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import {
  closeOpenAICodexWebSocketSessions,
  getOpenAICodexWebSocketDebugStats,
  type OpenAICodexWebSocketDebugStats
} from "@mariozechner/pi-ai/openai-codex-responses";
import {
  buildRuntimeMessageKey,
  classifyRuntimeCapacityError,
  consumePendingDeliveryByMessageKey,
  extractMessageKeyFromRuntimeContent,
  normalizeRuntimeError,
  normalizeRuntimeUserMessage,
  previewForLog
} from "../runtime-utils.js";
import {
  trimConversationForEmergencyRecovery,
  type EmergencyContextTrimMessage
} from "../emergency-context-trim.js";
import type { CredentialPoolService } from "../credential-pool.js";
import type {
  OpenAIAuthBrokerLeaseHandle,
  OpenAIAuthBrokerRuntimeService,
} from "../openai-auth/openai-auth-broker-runtime-service.js";
import { OpenAIAuthBrokerRuntimeController } from "./pi/openai-auth-broker-runtime-controller.js";
import { transitionAgentStatus } from "../agent-state-machine.js";
import type {
  RuntimeCodexTransportDebugDiagnostics,
  RuntimeCodexTransportDebugStats,
  RuntimeImageAttachment,
  RuntimeErrorEvent,
  RuntimeModelCallMeta,
  RuntimeSessionEvent,
  RuntimeSessionMessage,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
  SmartCompactOptions,
  SmartCompactResult,
  SpecialistFallbackReplaySnapshot,
  SwarmAgentRuntime,
  SwarmRuntimeCallbacks
} from "../runtime-contracts.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt
} from "../types.js";
import { resizeImageIfNeeded } from "../image-utils.js";
import {
  createDefaultCompactionRuntimeSettingsProvider,
  type CompactionRuntimeSettingsProvider,
} from "../compaction-runtime-settings-provider.js";
import {
  collectCompactionEntryKeys,
  findNewCompactionEntries,
} from "../compaction-session-entries.js";
import {
  clearForgePiCompactionFailure,
  consumeForgePiCompactionFailure,
} from "../compaction/forge-pi-compaction-extension.js";
import { runtimeInputAssistantOutputPolicyFacts, type AssistantOutputPolicyFacts } from "./manager-assistant-output-target-metadata.js";

interface PendingDelivery {
  deliveryId: string;
  messageKey: string;
  message: RuntimeUserMessage;
  mode: "steer" | "recovery_buffer";
}

interface PromptDispatchRestoreOptions {
  restoreSessionMessagesOnFailure: unknown[];
  restoreStage?: string;
}

type PromptDispatchResult = "sent" | "retry_scheduled" | "failed";

const MAX_PROMPT_DISPATCH_ATTEMPTS = 2;
const MAX_TERMINAL_REPORT_RESAMPLES = 2;
const DIRECT_USER_SOURCE_CONTEXT_PATTERN = /^\[sourceContext\]\s+(\{[^\n]*\})(?:\n|$)/u;
const TERMINAL_WORKER_REPORT_PATTERNS = [
  /^WORKER REPORT:\s*status:\s*(?:done|partial|blocked|completed)\b/i,
  /^SYSTEM:\s*status:\s*(?:done|partial|blocked|completed)\b/i,
  /^SYSTEM:\s*Worker\s+\S+\s+completed its turn\b/i,
  /^SYSTEM:\s*Worker\s+\S+\s+ended its turn with an error\b/i,
];
// Appended when re-delivering terminal worker reports after a manager turn with
// no visible side effect. Exported for tests.
export const TERMINAL_REPORT_REDELIVERY_DIRECTIVE =
  "Worker/internal reports require explicit same-turn handling. For direct web/session-transcript closeouts, answer normally with final assistant text. Use speak_to_user only for routed/protected/non-web user delivery; otherwise use present_choices, peer reply, delegation/follow-up, or an intentional non-user-visible coordination action now.";
export const DIRECT_USER_INPUT_REDELIVERY_DIRECTIVE =
  "Handle this user message with the appropriate output path now. For direct web/session-transcript replies, answer normally or continue with brief assistant progress followed by same-turn work. Use speak_to_user.target only for non-web/routed delivery; otherwise use present_choices, delegate/use an appropriate tool, or take a visible coordination action now.";
const STREAMING_STATUS_EMIT_THROTTLE_MS = 1_000;
const MID_TURN_CONTEXT_GUARD_ENABLED = true;
const HANDOFF_TURN_TOKEN_BUDGET = 2_048;
const ESTIMATION_ERROR_MARGIN_PERCENT = 0.05;
const ESTIMATION_ERROR_MARGIN_MIN_TOKENS = 4_096;
const COMPACTION_RESERVE_TOKENS = 16_384;
const CONTEXT_BUDGET_CHECK_THROTTLE_MS = 3_000;
const CONTEXT_GUARD_ABORT_TIMEOUT_MS = 15_000;
const AUTO_COMPACTION_FAILURE_COOLDOWN_MS = 60_000;
const CONTEXT_RECOVERY_GRACE_MS = 2_000;
const HANDOFF_TURN_TIMEOUT_MS = 45_000;
const MAX_HANDOFF_CONTENT_CHARS = 3_000;
const MAX_RECOVERY_BUFFERED_MESSAGES = 25;
const DEFAULT_ABORT_TIMEOUT_MS = 5_000;
const POOLED_AUTH_RECONCILE_IDLE_MS = 60_000;

type PiSessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

interface PiSessionShutdownMetadata {
  reason: PiSessionShutdownReason;
  targetSessionFile?: string;
}

function fingerprintAuthCredential(credential: AuthCredential | undefined): string | undefined {
  if (!credential) {
    return undefined;
  }

  return stableStringify(credential);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeOpenAICodexWebSocketDebugStats(
  stats: OpenAICodexWebSocketDebugStats
): RuntimeCodexTransportDebugStats {
  return {
    requests: readNumber(stats.requests) ?? 0,
    connectionsCreated: readNumber(stats.connectionsCreated) ?? 0,
    connectionsReused: readNumber(stats.connectionsReused) ?? 0,
    cachedContextRequests: readNumber(stats.cachedContextRequests) ?? 0,
    storeTrueRequests: readNumber(stats.storeTrueRequests) ?? 0,
    fullContextRequests: readNumber(stats.fullContextRequests) ?? 0,
    deltaRequests: readNumber(stats.deltaRequests) ?? 0,
    lastInputItems: readNumber(stats.lastInputItems) ?? 0,
    ...(typeof stats.lastDeltaInputItems === "number" && Number.isFinite(stats.lastDeltaInputItems)
      ? { lastDeltaInputItems: stats.lastDeltaInputItems }
      : {})
  };
}

export type { RuntimeImageAttachment, RuntimeUserMessage, RuntimeUserMessageInput } from "../runtime-contracts.js";

export class AgentRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;
  readonly runtimeType = "pi" as const;

  /** Credential pool fields for multi-account failover */
  pooledCredentialId: string | undefined;
  pooledCredentialProvider: string | undefined;
  credentialPoolService: CredentialPoolService | undefined;

  private openAIAuthBrokerController: OpenAIAuthBrokerRuntimeController | undefined;

  private pooledCredentialFingerprint: string | undefined;

  private readonly session: AgentSession;
  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly now: () => string;
  private readonly systemPrompt: string;
  private readonly compactionRuntimeSettingsProvider: CompactionRuntimeSettingsProvider;
  private readonly compactionFailureScopeKey: string;
  private pendingDeliveries: PendingDelivery[] = [];
  private readonly recoveryBufferedMessages: Array<{ deliveryId: string; message: RuntimeUserMessage }> = [];
  private status: AgentStatus;
  private unsubscribe: (() => void) | undefined;
  private readonly inFlightPrompts = new Set<Promise<void>>();
  private promptDispatchPending = false;
  private ignoreNextAgentStart = false;
  private lastStreamingStatusEmitAtMs = 0;
  private lastContextUsage: AgentContextUsage | undefined;
  private currentTurnReplayMessages: RuntimeUserMessage[] = [];
  private preparedSpecialistFallbackSessionMessages: EmergencyContextTrimMessage[] | undefined;
  private contextRecoveryInProgress = false;
  private contextRecoveryGraceUntilMs = 0;
  private manualCompactionInProgress = false;
  private autoCompactionRecoveryInProgress = false;
  private guardAbortController: AbortController | undefined;
  private lastContextBudgetCheckAtMs = 0;
  private latestAutoCompactionReason: "threshold" | "overflow" | undefined;
  private autoCompactionEntryKeysBefore: Set<string> | undefined;
  private autoCompactionFailureCooldownUntilMs = 0;
  private suppressSessionEventsUntilIdle = false;
  private lastActivityAtMs = Date.now();
  private hiddenOutputResampleState: { triggerKey: string; attempts: number } | undefined;
  private readonly promptDispatchRestoreOptions = new WeakMap<RuntimeUserMessage, PromptDispatchRestoreOptions>();

  constructor(options: {
    descriptor: AgentDescriptor;
    session: AgentSession;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    systemPrompt?: string;
    compactionRuntimeSettingsProvider?: CompactionRuntimeSettingsProvider;
    compactionFailureScopeKey?: string;
  }) {
    this.descriptor = options.descriptor;
    this.session = options.session;
    this.callbacks = options.callbacks;
    this.now = options.now ?? (() => new Date().toISOString());
    this.systemPrompt = options.systemPrompt ?? options.session.systemPrompt ?? "";
    this.compactionRuntimeSettingsProvider =
      options.compactionRuntimeSettingsProvider ?? createDefaultCompactionRuntimeSettingsProvider();
    this.compactionFailureScopeKey = options.compactionFailureScopeKey ?? options.descriptor.agentId;
    this.status = options.descriptor.status;

    clearForgePiCompactionFailure(this.compactionFailureScopeKey);
    this.unsubscribe = this.session.subscribe((event) => {
      void this.handleEvent(event);
    });
  }

  configureOpenAIAuthBrokerController(
    service: OpenAIAuthBrokerRuntimeService,
    handle?: OpenAIAuthBrokerLeaseHandle,
  ): void {
    this.openAIAuthBrokerController = new OpenAIAuthBrokerRuntimeController({
      service,
      handle,
      getAuthStorage: () => this.getRuntimeAuthStorage(),
      getProvider: () => this.session.model?.provider ?? this.descriptor.model.provider,
      retryPromptLater: (message) => {
        setTimeout(() => {
          if (this.status !== "terminated") {
            this.dispatchPrompt(message);
          }
        }, 0);
      },
      closeStaleOpenAICodexWebSocketSession: (stage) => this.closeStaleOpenAICodexWebSocketSession(stage),
      logRuntimeError: (phase, error, details) => this.logRuntimeError(phase, error, details),
      reportRuntimeError: (error) => this.reportRuntimeError(error),
    });
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getPendingCount(): number {
    return this.pendingDeliveries.length;
  }

  getContextUsage(): AgentContextUsage | undefined {
    return this.refreshContextUsage();
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getCodexTransportDebugDiagnostics(): RuntimeCodexTransportDebugDiagnostics {
    const sessionId = typeof this.session.sessionId === "string" && this.session.sessionId.length > 0
      ? this.session.sessionId
      : undefined;
    const model = this.session.model;
    const transport = readString((this.session.agent as { transport?: unknown }).transport);
    const result: RuntimeCodexTransportDebugDiagnostics = {
      transport,
      modelProvider: readString(model?.provider),
      modelApi: readString(model?.api),
      piSessionIdPresent: Boolean(sessionId),
      websocketStatsStatus: sessionId ? "no_stats" : "no_session",
      directPiSessionStatsStatus: sessionId ? "no_stats" : "no_session"
    };

    if (!sessionId) {
      return result;
    }

    try {
      const stats = getOpenAICodexWebSocketDebugStats(sessionId);
      if (stats) {
        result.websocketStatsStatus = "available";
        result.directPiSessionStatsStatus = "available";
        result.websocketStats = sanitizeOpenAICodexWebSocketDebugStats(stats);
      }
    } catch {
      result.websocketStatsStatus = "error";
      result.directPiSessionStatsStatus = "error";
    }

    return result;
  }

  isStreaming(): boolean {
    return this.session.isStreaming;
  }

  isContextRecoveryInProgress(): boolean {
    return Boolean(
      this.contextRecoveryInProgress || this.manualCompactionInProgress || this.session.isCompacting,
    );
  }

  async prepareForSpecialistFallbackReplay(): Promise<SpecialistFallbackReplaySnapshot | undefined> {
    const replayMessages = [
      ...this.currentTurnReplayMessages
        .map((message) => cloneRuntimeUserMessage(message))
        .filter((message): message is RuntimeUserMessage => message !== undefined),
      ...this.pendingDeliveries
        .map((delivery) => cloneRuntimeUserMessage(delivery.message))
        .filter((message): message is RuntimeUserMessage => message !== undefined)
    ];

    if (replayMessages.length === 0) {
      return undefined;
    }

    const stateMessages = structuredClone(this.getSessionAgentMessages()) as EmergencyContextTrimMessage[];
    this.preparedSpecialistFallbackSessionMessages = stateMessages;

    this.pruneFailedTurnForReplay(replayMessages);
    return {
      messages: replayMessages
    };
  }

  async restorePreparedSpecialistFallbackReplay(): Promise<void> {
    if (!this.preparedSpecialistFallbackSessionMessages) {
      return;
    }

    this.rebuildSessionContextFromTrimmedMessages(this.preparedSpecialistFallbackSessionMessages);
    this.preparedSpecialistFallbackSessionMessages = undefined;
  }

  async sendMessage(
    input: RuntimeUserMessageInput,
    _requestedMode: RequestedDeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    this.ensureNotTerminated();
    this.suppressSessionEventsUntilIdle = false;

    const deliveryId = randomUUID();
    const message = await prepareRuntimeUserMessageForDispatch(input);

    if (this.isContextRecoveryActive()) {
      if (this.isContextRecoveryInProgress()) {
        this.bufferMessageDuringRecovery(deliveryId, message);
      } else {
        await this.enqueueMessage(deliveryId, message);
      }

      this.noteActivity();
      await this.emitStatus();
      return {
        targetAgentId: this.descriptor.agentId,
        deliveryId,
        acceptedMode: "steer"
      };
    }

    if (this.session.isStreaming || this.promptDispatchPending) {
      await this.enqueueMessage(deliveryId, message);
      this.noteActivity();
      await this.emitStatus();
      return {
        targetAgentId: this.descriptor.agentId,
        deliveryId,
        acceptedMode: "steer"
      };
    }

    this.currentTurnReplayMessages = [cloneRuntimeUserMessage(message) ?? message];
    this.dispatchPrompt(message);

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId,
      acceptedMode: "prompt"
    };
  }

  async terminate(options?: { abort?: boolean; shutdownTimeoutMs?: number }): Promise<void> {
    if (this.status === "terminated") return;

    this.endContextRecovery();
    this.guardAbortController?.abort();
    this.guardAbortController = undefined;
    this.lastContextBudgetCheckAtMs = 0;

    const shouldAbort = options?.abort ?? true;
    if (shouldAbort) {
      try {
        await withTimeout(
          this.session.abort(),
          options?.shutdownTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS,
          "terminate_abort"
        );
      } catch (error) {
        this.logRuntimeError("interrupt", error, {
          stage: "terminate_abort_failed"
        });
      }
    }

    await this.disposeSessionResources({ reason: "quit" });
    this.status = transitionAgentStatus(this.status, "terminated");
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();
    await this.emitStatus();
  }

  async shutdownForReplacement(): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    this.assertIdleForReplacementShutdown();
    this.endContextRecovery();
    this.guardAbortController?.abort();
    this.guardAbortController = undefined;
    this.lastContextBudgetCheckAtMs = 0;
    await this.disposeSessionResources({ reason: "reload" });
  }

  async recycle(): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    this.assertIdleForReplacementShutdown();
    this.endContextRecovery();
    this.guardAbortController?.abort();
    this.guardAbortController = undefined;
    this.lastContextBudgetCheckAtMs = 0;
    await this.disposeSessionResources({ reason: "reload" });
  }

  async stopInFlight(options?: { abort?: boolean; shutdownTimeoutMs?: number }): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    this.endContextRecovery();
    this.guardAbortController?.abort();
    this.guardAbortController = undefined;
    this.lastContextBudgetCheckAtMs = 0;

    const shouldAbort = options?.abort ?? true;
    if (shouldAbort) {
      try {
        await withTimeout(
          this.session.abort(),
          options?.shutdownTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS,
          "stop_in_flight_abort"
        );
      } catch (error) {
        this.suppressSessionEventsUntilIdle = true;
        this.logRuntimeError("interrupt", error, {
          stage: "stop_in_flight_abort_failed"
        });
      }
    }

    clearForgePiCompactionFailure(this.compactionFailureScopeKey);
    this.pendingDeliveries = [];
    this.recoveryBufferedMessages.length = 0;
    this.promptDispatchPending = false;
    this.currentTurnReplayMessages = [];
    this.preparedSpecialistFallbackSessionMessages = undefined;
    this.ignoreNextAgentStart = false;
    this.latestAutoCompactionReason = undefined;
    this.autoCompactionRecoveryInProgress = false;
    this.inFlightPrompts.clear();

    await this.updateStatus("idle");
  }

  private assertIdleForReplacementShutdown(): void {
    if (
      this.status !== "idle" ||
      this.session.isStreaming ||
      this.promptDispatchPending ||
      this.pendingDeliveries.length > 0 ||
      this.recoveryBufferedMessages.length > 0 ||
      this.isContextRecoveryActive()
    ) {
      throw new Error(`Agent ${this.descriptor.agentId} runtime is not idle and cannot be recycled`);
    }
  }

  private async disposeSessionResources(shutdown: PiSessionShutdownMetadata): Promise<void> {
    try {
      // NOTE: Uses the public AgentSession.extensionRunner API
      // (verified against @mariozechner/pi-coding-agent@0.71.1).
      // The try/catch ensures this remains safe against Pi version changes.
      const runner = this.session.extensionRunner;
      if (runner?.hasHandlers("session_shutdown")) {
        await runner.emit({
          type: "session_shutdown",
          reason: shutdown.reason,
          ...(shutdown.targetSessionFile ? { targetSessionFile: shutdown.targetSessionFile } : {})
        });
      }
    } catch (error) {
      this.logRuntimeError("interrupt", error, {
        stage: "dispose_session_shutdown_emit_failed"
      });
    }

    clearForgePiCompactionFailure(this.compactionFailureScopeKey);
    this.closeStaleOpenAICodexWebSocketSession("dispose_session_resources");
    await this.openAIAuthBrokerController?.release(shutdown.reason);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session.dispose();
    this.pendingDeliveries = [];
    this.recoveryBufferedMessages.length = 0;
    this.promptDispatchPending = false;
    this.currentTurnReplayMessages = [];
    this.preparedSpecialistFallbackSessionMessages = undefined;
    this.ignoreNextAgentStart = false;
    this.latestAutoCompactionReason = undefined;
    this.autoCompactionRecoveryInProgress = false;
    this.suppressSessionEventsUntilIdle = false;
    this.inFlightPrompts.clear();
  }

  async smartCompact(customInstructions?: string, options?: SmartCompactOptions): Promise<SmartCompactResult> {
    this.ensureNotTerminated();

    if (this.isContextRecoveryActive()) {
      throw new Error("Context recovery is already in progress");
    }

    const resumeAfterCompaction =
      options?.resumeAfterCompaction ?? (options?.skipResumeIfIdle ? this.shouldResumeAfterManualSmartCompact() : true);

    this.beginContextRecovery();
    this.guardAbortController = new AbortController();
    const signal = this.guardAbortController.signal;

    const handoffFilePath = buildHandoffFilePath(this.descriptor);

    this.logContextGuard("smart_compact_started", {
      handoffFilePath,
      wasStreaming: this.session.isStreaming,
      resumeAfterCompaction
    });

    let handoffContent: string | undefined;
    let completed = false;
    let compacted = false;
    let reason: string | undefined;

    try {
      // If streaming, abort current turn first
      if (this.session.isStreaming) {
        try {
          await withTimeout(this.session.abort(), CONTEXT_GUARD_ABORT_TIMEOUT_MS, "smart_compact_abort");
        } catch (error) {
          await this.reportContextGuardError(error, { stage: "smart_compact_abort_failed" });
          return { compacted: false, reason: "Failed to abort current turn" };
        }
      }

      if (signal.aborted) return { compacted: false, reason: "Aborted" };

      // Run handoff turn
      handoffContent = await this.runHandoffTurn(handoffFilePath, signal);

      if (signal.aborted) return { compacted: false, reason: "Aborted" };

      // Compact
      try {
        const beforeCompactionEntries = this.getCompactionEntryKeys();
        await withTimeout(this.compact(customInstructions), this.getCompactionTimeoutMs(), "smart_compact_compact", {
          onTimeout: () => this.abortCompactionSafely("smart_compact_compact_timeout_abort")
        });
        compacted = this.getNewCompactionEntries(beforeCompactionEntries).length > 0;
        if (!compacted) {
          reason = "Compaction completed without writing a compaction record";
          await this.reportContextGuardError(new Error(reason), {
            stage: "smart_compact_compaction_failed",
            handoffWritten: handoffContent !== undefined
          });
        }
      } catch (error) {
        const normalized = normalizeRuntimeError(error);
        if (isAlreadyCompactedError(normalized.message)) {
          reason = "runtime_already_compacted";
        } else {
          reason = normalized.message;
          await this.reportContextGuardError(error, {
            stage: "smart_compact_compaction_failed",
            handoffWritten: handoffContent !== undefined,
            ...getForgeCompactionFailureDetails(error)
          });
        }
        // Continue through cleanup even if compaction failed or was skipped.
      }

      if (signal.aborted) return { compacted: false, reason: "Aborted" };

      if (resumeAfterCompaction && compacted) {
        try {
          const resumePrompt = buildResumePrompt(handoffContent);
          await this.session.prompt(resumePrompt);
        } catch (error) {
          await this.reportContextGuardError(error, { stage: "smart_compact_resume_failed" });
        }
      }

      completed = true;
    } finally {
      await this.cleanupGuard(handoffFilePath, {
        retainHandoff: handoffContent !== undefined && !compacted
      });
      if (completed) {
        this.logContextGuard("smart_compact_completed", {
          compacted,
          handoffWritten: handoffContent !== undefined,
          handoffContentLength: handoffContent?.length ?? 0
        });
      }
    }

    return compacted ? { compacted: true } : { compacted: false, reason: reason ?? "compaction_not_performed" };
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.ensureNotTerminated();
    this.manualCompactionInProgress = true;
    try {
      await this.emitCompactionStatusSafely("compact_start_status_emit");
      clearForgePiCompactionFailure(this.compactionFailureScopeKey);
      const result = await this.session.compact(customInstructions);
      await this.emitCompactionStatusSafely("compact_complete_status_emit");
      return result;
    } catch (error) {
      const enhancedError = this.enhanceCompactionCancellationError(error);
      this.logRuntimeError("compaction", enhancedError, {
        customInstructionsPreview: previewForLog(customInstructions ?? ""),
        ...getForgeCompactionFailureDetails(enhancedError)
      });
      throw enhancedError;
    } finally {
      this.manualCompactionInProgress = false;
      await this.emitCompactionStatusSafely("compact_end_status_emit");
    }
  }

  private enhanceCompactionCancellationError(error: unknown): unknown {
    const normalized = normalizeRuntimeError(error);
    if (normalized.message !== "Compaction cancelled") {
      return error;
    }

    const failure = consumeForgePiCompactionFailure(this.compactionFailureScopeKey);
    if (!failure) {
      return error;
    }

    const enhanced = new Error(failure.message);
    enhanced.name = "ForgePiCompactionFailure";
    (enhanced as Error & { details?: Record<string, unknown> }).details = failure.details;
    return enhanced;
  }

  private shouldResumeAfterManualSmartCompact(): boolean {
    return (
      this.session.isStreaming ||
      this.promptDispatchPending ||
      this.status === "streaming" ||
      this.pendingDeliveries.length > 0 ||
      this.recoveryBufferedMessages.length > 0 ||
      this.currentTurnReplayMessages.length > 0
    );
  }

  private abortCompactionSafely(stage: string): void {
    try {
      this.session.abortCompaction?.();
    } catch (error) {
      this.logRuntimeError("compaction", error, { stage });
    }
  }

  isContextRecoveryActive(): boolean {
    return this.contextRecoveryInProgress || Date.now() < this.contextRecoveryGraceUntilMs;
  }

  private getCompactionTimeoutMs(): number {
    return this.compactionRuntimeSettingsProvider.getCompactionRuntimeSettings().timeoutMs;
  }

  private isAutoCompactionCooldownActive(): boolean {
    return Date.now() < this.autoCompactionFailureCooldownUntilMs;
  }

  private noteAutoCompactionFailureCooldown(): void {
    this.autoCompactionFailureCooldownUntilMs = Date.now() + AUTO_COMPACTION_FAILURE_COOLDOWN_MS;
  }

  private beginContextRecovery(): void {
    this.contextRecoveryInProgress = true;
    this.contextRecoveryGraceUntilMs = 0;
    void this.emitStatus();
  }

  private beginAutoCompactionRecovery(): void {
    if (this.autoCompactionRecoveryInProgress) {
      return;
    }

    this.autoCompactionRecoveryInProgress = true;
    this.beginContextRecovery();
  }

  private endAutoCompactionRecovery(): void {
    if (!this.autoCompactionRecoveryInProgress) {
      return;
    }

    this.autoCompactionRecoveryInProgress = false;
    this.endContextRecovery(CONTEXT_RECOVERY_GRACE_MS);
  }

  private endContextRecovery(graceMs = 0): void {
    this.contextRecoveryInProgress = false;
    this.contextRecoveryGraceUntilMs = graceMs > 0 ? Date.now() + graceMs : 0;
    void this.emitStatus();
  }

  getCustomEntries(customType: string): unknown[] {
    const entries = this.session.sessionManager.getEntries();
    const matches: unknown[] = [];

    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === customType) {
        matches.push(entry.data);
      }
    }

    return matches;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.session.sessionManager.appendCustomEntry(customType, data);
  }

  private dispatchPrompt(
    message: RuntimeUserMessage,
    options?: PromptDispatchRestoreOptions
  ): void {
    this.promptDispatchPending = true;
    this.ignoreNextAgentStart = false;
    if (options) {
      this.promptDispatchRestoreOptions.set(message, options);
    }

    const run = this.dispatchPromptWithRetry(message)
      .catch((error) => {
        this.logRuntimeError("prompt_dispatch", error, {
          stage: "dispatch_prompt_retry"
        });
        return "failed" as const;
      })
      .then((result) => {
        if (result === "retry_scheduled") {
          return;
        }

        const restoreOptions = this.promptDispatchRestoreOptions.get(message);
        this.promptDispatchRestoreOptions.delete(message);
        if (result === "failed" && restoreOptions) {
          this.replaceSessionAgentMessages(restoreOptions.restoreSessionMessagesOnFailure);
          this.logRuntimeError("prompt_dispatch", new Error("Restored pruned session context after prompt dispatch failure"), {
            stage: restoreOptions.restoreStage ?? "restore_session_messages_on_dispatch_failure"
          });
        }
      })
      .finally(() => {
        this.promptDispatchPending = false;
        this.inFlightPrompts.delete(run);
      });

    this.inFlightPrompts.add(run);
  }

  private async dispatchPromptWithRetry(message: RuntimeUserMessage): Promise<PromptDispatchResult> {
    try {
      await this.openAIAuthBrokerController?.beforeDispatch();
      await this.reconcilePooledAuthBeforeDispatch();
    } catch (error) {
      return await this.handlePromptDispatchError(error, message, {
        attempt: 0,
        maxAttempts: MAX_PROMPT_DISPATCH_ATTEMPTS,
      });
    }

    this.noteActivity();
    const images = toImageContent(message.images);

    for (let attempt = 1; attempt <= MAX_PROMPT_DISPATCH_ATTEMPTS; attempt += 1) {
      try {
        await this.sendToSession(message.text, images);
        return "sent";
      } catch (error) {
        const canRetry =
          attempt < MAX_PROMPT_DISPATCH_ATTEMPTS &&
          this.status !== "terminated" &&
          this.status !== "streaming" &&
          !this.session.isStreaming;

        if (this.openAIAuthBrokerController?.shouldHandleErrorBeforeGenericRetry(error)) {
          return await this.handlePromptDispatchError(error, message, {
            attempt,
            maxAttempts: MAX_PROMPT_DISPATCH_ATTEMPTS
          });
        }

        if (canRetry) {
          this.logRuntimeError("prompt_dispatch", error, {
            attempt,
            maxAttempts: MAX_PROMPT_DISPATCH_ATTEMPTS,
            willRetry: true,
            textPreview: previewForLog(message.text),
            imageCount: message.images?.length ?? 0
          });
          continue;
        }

        return await this.handlePromptDispatchError(error, message, {
          attempt,
          maxAttempts: MAX_PROMPT_DISPATCH_ATTEMPTS
        });
      }
    }

    return "failed";
  }

  private async sendToSession(text: string, images: ImageContent[]): Promise<void> {
    if (text.trim().length === 0 && images.length > 0) {
      await this.session.sendUserMessage(buildUserMessageContent(text, images));
      return;
    }

    if (images.length > 0) {
      await this.session.prompt(text, { images });
      return;
    }

    await this.session.prompt(text);
  }

  private async enqueueMessage(deliveryId: string, message: RuntimeUserMessage): Promise<void> {
    const images = toImageContent(message.images);
    await this.session.steer(message.text, images.length > 0 ? images : undefined);

    this.pendingDeliveries.push({
      deliveryId,
      messageKey: buildRuntimeMessageKey(message),
      message: cloneRuntimeUserMessage(message) ?? message,
      mode: "steer"
    });
  }

  private bufferMessageDuringRecovery(deliveryId: string, message: RuntimeUserMessage): void {
    if (this.recoveryBufferedMessages.length >= MAX_RECOVERY_BUFFERED_MESSAGES) {
      const dropped = this.recoveryBufferedMessages.shift();
      if (dropped) {
        this.removePendingDeliveryById(dropped.deliveryId);
        this.logRuntimeError("steer_delivery", new Error("Dropped oldest recovery-buffered message"), {
          stage: "recovery_buffer_overflow",
          droppedDeliveryId: dropped.deliveryId,
          maxBufferedMessages: MAX_RECOVERY_BUFFERED_MESSAGES
        });
      }
    }

    this.recoveryBufferedMessages.push({ deliveryId, message });
    this.pendingDeliveries.push({
      deliveryId,
      messageKey: buildRuntimeMessageKey(message),
      message: cloneRuntimeUserMessage(message) ?? message,
      mode: "recovery_buffer"
    });
  }

  private async flushRecoveryBufferedMessages(): Promise<void> {
    if (this.status === "terminated" || this.contextRecoveryInProgress || this.recoveryBufferedMessages.length === 0) {
      return;
    }

    const buffered = this.recoveryBufferedMessages.splice(0, this.recoveryBufferedMessages.length);

    for (const entry of buffered) {
      try {
        const images = toImageContent(entry.message.images);
        await this.session.steer(entry.message.text, images.length > 0 ? images : undefined);
      } catch (error) {
        this.removePendingDeliveryById(entry.deliveryId);
        this.logRuntimeError("steer_delivery", error, {
          stage: "flush_recovery_buffer",
          deliveryId: entry.deliveryId
        });
      }
    }

    await this.emitStatus();
  }

  private async handleEvent(event: AgentSessionEvent): Promise<void> {
    this.noteActivity();

    if (this.suppressSessionEventsUntilIdle) {
      if (event.type === "agent_end") {
        this.suppressSessionEventsUntilIdle = false;
        if (this.status !== "terminated") {
          await this.updateStatus("idle");
        }
      }
      return;
    }

    const normalizedEvent = normalizeRuntimeSessionEvent(event, this.session);
    if (this.callbacks.onSessionEvent && normalizedEvent) {
      await this.callbacks.onSessionEvent(this.descriptor.agentId, normalizedEvent);
    }

    if (event.type === "agent_start") {
      this.promptDispatchPending = false;
      if (this.ignoreNextAgentStart) {
        this.ignoreNextAgentStart = false;
        if (this.status !== "terminated") {
          await this.updateStatus("idle");
        }
        return;
      }
      await this.updateStatus("streaming");
      return;
    }

    if (event.type === "agent_end") {
      this.currentTurnReplayMessages = [];
      if (await this.maybeResampleUnhandledHiddenOutputTurn()) {
        return;
      }
      this.hiddenOutputResampleState = undefined;
      await this.openAIAuthBrokerController?.reportSuccess();
      if (this.status !== "terminated") {
        await this.updateStatus("idle");
      }
      if (this.callbacks.onAgentEnd) {
        await this.callbacks.onAgentEnd(this.descriptor.agentId);
      }
      return;
    }

    if (event.type === "compaction_start" && event.reason !== "manual") {
      clearForgePiCompactionFailure(this.compactionFailureScopeKey);
      this.latestAutoCompactionReason = event.reason;
      this.autoCompactionEntryKeysBefore = this.getCompactionEntryKeys();
      if (!this.isContextRecoveryActive()) {
        this.beginAutoCompactionRecovery();
      }
      await this.reportRuntimeError({
        phase: "compaction",
        message: "Automatic compaction started",
        details: {
          recoveryStage: "auto_compaction_started",
          compactionReason: event.reason,
          userFacingMessage: "Context is getting full — compacting automatically."
        }
      });
      return;
    }

    if (event.type === "compaction_end") {
      if (event.reason !== "manual") {
        await this.handleAutoCompactionEndEvent(event);
      }
      return;
    }

    if (event.type === "turn_start" || event.type === "turn_end" || event.type === "tool_execution_end") {
      this.refreshContextUsage();
    }

    if (event.type === "message_update" && event.message.role !== "user") {
      await this.emitStreamingStatusUpdateThrottled();
      return;
    }

    if (event.type === "message_end") {
      this.checkContextBudget();
      return;
    }

    if (event.type === "message_start" && event.message.role === "user") {
      const key = extractMessageKeyFromRuntimeContent(event.message.content);
      if (key !== undefined) {
        const pendingMessage = this.consumePendingMessage(key);
        if (pendingMessage) {
          this.currentTurnReplayMessages.push(cloneRuntimeUserMessage(pendingMessage.message) ?? pendingMessage.message);
        }
        await this.emitStatus();
      }
    }
  }

  private checkContextBudget(): void {
    if (!MID_TURN_CONTEXT_GUARD_ENABLED) {
      return;
    }

    if (this.isContextRecoveryActive() || this.status === "terminated" || !this.session.isStreaming) {
      return;
    }

    if (this.isAutoCompactionCooldownActive()) {
      return;
    }

    const nowMs = Date.now();
    if (nowMs - this.lastContextBudgetCheckAtMs < CONTEXT_BUDGET_CHECK_THROTTLE_MS) {
      return;
    }

    this.lastContextBudgetCheckAtMs = nowMs;

    const usage = this.getContextUsage();
    if (!usage) {
      return;
    }

    const { softThresholdTokens } = computeGuardThresholds(usage.contextWindow);
    if (usage.tokens < softThresholdTokens) {
      return;
    }

    void this.runContextGuard(usage).catch(async (error) => {
      await this.reportContextGuardError(error, {
        stage: "guard_top_level_catch",
        contextTokens: usage.tokens,
        contextWindow: usage.contextWindow
      });
      this.endContextRecovery();
      this.guardAbortController = undefined;
    });
  }

  private async runContextGuard(triggeringUsage: AgentContextUsage): Promise<void> {
    if (this.status === "terminated" || this.isContextRecoveryActive()) {
      return;
    }

    this.beginContextRecovery();
    this.guardAbortController = new AbortController();
    const signal = this.guardAbortController.signal;

    const { softThresholdTokens, hardThresholdTokens } = computeGuardThresholds(triggeringUsage.contextWindow);
    const handoffFilePath = buildHandoffFilePath(this.descriptor);

    this.logContextGuard("triggered", {
      contextTokens: triggeringUsage.tokens,
      contextWindow: triggeringUsage.contextWindow,
      contextPercent: triggeringUsage.percent,
      softThresholdTokens,
      hardThresholdTokens,
      handoffFilePath
    });

    const willPrepareHandoff = triggeringUsage.tokens < hardThresholdTokens;

    await this.reportRuntimeError({
      phase: "context_guard",
      message: "Context limit approaching — running intelligent handoff before compaction",
      details: {
        recoveryStage: "guard_started",
        contextTokens: triggeringUsage.tokens,
        contextWindow: triggeringUsage.contextWindow,
        contextPercent: triggeringUsage.percent,
        userFacingMessage: willPrepareHandoff
          ? "Context is getting full — preparing handoff for automatic smart compaction."
          : "Context limit reached — running recovery compaction now."
      }
    });

    let handoffContent: string | undefined;
    let completed = false;
    let compactionAttempted = false;
    let compactionSucceeded = false;

    try {
      try {
        await withTimeout(this.session.abort(), CONTEXT_GUARD_ABORT_TIMEOUT_MS, "context_guard_abort");
      } catch (error) {
        await this.reportContextGuardError(error, { stage: "abort_failed" });
        return;
      }

      if (signal.aborted) {
        return;
      }

      if (triggeringUsage.tokens < hardThresholdTokens) {
        handoffContent = await this.runHandoffTurn(handoffFilePath, signal);
      } else {
        this.logContextGuard("handoff_skipped_hard_threshold", {
          contextTokens: triggeringUsage.tokens,
          hardThresholdTokens
        });
      }

      if (signal.aborted) {
        return;
      }

      const postHandoffUsage = this.getContextUsage();
      const needsCompaction =
        postHandoffUsage &&
        postHandoffUsage.tokens !== null &&
        postHandoffUsage.tokens !== undefined &&
        postHandoffUsage.tokens >= softThresholdTokens;

      if (needsCompaction) {
        compactionAttempted = true;
        try {
          const beforeCompactionEntries = this.getCompactionEntryKeys();
          await withTimeout(this.compact(), this.getCompactionTimeoutMs(), "context_guard_compact", {
            onTimeout: () => this.abortCompactionSafely("context_guard_compact_timeout_abort")
          });
          const newCompactionEntries = this.getNewCompactionEntries(beforeCompactionEntries);
          if (newCompactionEntries.length > 0) {
            await this.reportContextGuardCompactionSuccesses(beforeCompactionEntries, {
              handoffWritten: handoffContent !== undefined,
              contextTokens: postHandoffUsage.tokens,
              contextWindow: postHandoffUsage.contextWindow
            });
            compactionSucceeded = true;
          } else {
            await this.reportContextGuardError(
              new Error("Compaction completed without writing a compaction record"),
              {
                stage: "compaction_failed",
                handoffWritten: handoffContent !== undefined
              }
            );
          }
        } catch (error) {
          const normalized = normalizeRuntimeError(error);
          if (isAlreadyCompactedError(normalized.message)) {
            compactionSucceeded = true;
          } else {
            await this.reportContextGuardError(error, {
              stage: "compaction_failed",
              handoffWritten: handoffContent !== undefined
            });
          }
        }
      } else {
        this.logContextGuard("compaction_skipped", {
          reason: postHandoffUsage ? "below_threshold" : "usage_unknown_post_compaction",
          postHandoffTokens: postHandoffUsage?.tokens
        });
      }

      if (signal.aborted) {
        return;
      }

      const shouldResume = !compactionAttempted || compactionSucceeded;
      if (shouldResume) {
        try {
          const resumePrompt = buildResumePrompt(handoffContent);
          await this.session.prompt(resumePrompt);
        } catch (error) {
          await this.reportContextGuardError(error, { stage: "resume_prompt_failed" });
        }
      }

      completed = true;
    } finally {
      await this.cleanupGuard(handoffFilePath, {
        retainHandoff: compactionAttempted && !compactionSucceeded && handoffContent !== undefined
      });
      if (completed) {
        this.logContextGuard("completed", {
          handoffWritten: handoffContent !== undefined,
          handoffContentLength: handoffContent?.length ?? 0
        });
      }
    }
  }

  private getCompactionEntryKeys(): Set<string> {
    return collectCompactionEntryKeys(this.session.sessionManager.getEntries());
  }

  private getNewCompactionEntries(previousKeys: Set<string>): Array<{ key: string; id?: string }> {
    return findNewCompactionEntries(this.session.sessionManager.getEntries(), previousKeys);
  }

  private async reportContextGuardCompactionSuccesses(
    previousKeys: Set<string>,
    details: {
      handoffWritten: boolean;
      contextTokens: number | null;
      contextWindow: number;
    }
  ): Promise<void> {
    const newEntries = this.getNewCompactionEntries(previousKeys);
    for (const entry of newEntries) {
      await this.reportRuntimeError({
        phase: "compaction",
        message: "Context compacted by context guard",
        details: {
          recoveryStage: "context_guard_compaction_succeeded",
          source: "pi_context_guard",
          handoffWritten: details.handoffWritten,
          contextTokens: details.contextTokens,
          contextWindow: details.contextWindow,
          compactionEntryId: entry.id ?? entry.key,
          userFacingMessage: details.handoffWritten
            ? "Automatic smart compaction complete."
            : "Recovery compaction complete."
        }
      });
    }
  }

  private async runHandoffTurn(handoffFilePath: string, signal: AbortSignal): Promise<string | undefined> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      const handoffPrompt = buildHandoffPrompt(handoffFilePath);
      const turnPromise = this.session.prompt(handoffPrompt);

      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), HANDOFF_TURN_TIMEOUT_MS);
      });

      const result = await Promise.race([turnPromise, timeoutPromise]);

      if (result === "timeout") {
        this.logContextGuard("handoff_timeout", { timeoutMs: HANDOFF_TURN_TIMEOUT_MS });
        try {
          await withTimeout(this.session.abort(), CONTEXT_GUARD_ABORT_TIMEOUT_MS, "context_guard_handoff_abort");
        } catch (error) {
          await this.reportContextGuardError(error, { stage: "handoff_timeout_abort_failed" });
        }
      }
    } catch (error) {
      await this.reportContextGuardError(error, { stage: "handoff_prompt_failed" });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    if (signal.aborted) {
      return undefined;
    }

    try {
      const content = await readFile(handoffFilePath, "utf8");
      const trimmed = content.trim();
      if (trimmed.length === 0) {
        return undefined;
      }

      if (trimmed.length > MAX_HANDOFF_CONTENT_CHARS) {
        this.logContextGuard("handoff_truncated", {
          originalLength: trimmed.length,
          truncatedTo: MAX_HANDOFF_CONTENT_CHARS
        });
        return `${trimmed.slice(0, MAX_HANDOFF_CONTENT_CHARS)}\n\n[... truncated for context budget ...]`;
      }

      return trimmed;
    } catch {
      this.logContextGuard("handoff_file_not_found", { handoffFilePath });
      return undefined;
    }
  }

  private async cleanupGuard(
    handoffFilePath?: string,
    options?: { retainHandoff?: boolean }
  ): Promise<void> {
    this.endContextRecovery(CONTEXT_RECOVERY_GRACE_MS);
    this.guardAbortController = undefined;

    if (handoffFilePath && !options?.retainHandoff) {
      await rm(handoffFilePath, { force: true }).catch(() => {});
    }

    await this.flushRecoveryBufferedMessages();
  }

  private logContextGuard(stage: string, details?: Record<string, unknown>): void {
    console.log(`[swarm][${this.now()}] context_guard:${stage}`, {
      agentId: this.descriptor.agentId,
      ...details
    });
  }

  private async reportContextGuardError(error: unknown, details?: Record<string, unknown>): Promise<void> {
    const normalized = normalizeRuntimeError(error);
    const mergedDetails = {
      ...details,
      ...getForgeCompactionFailureDetails(error),
    };
    this.logRuntimeError("context_guard", error, mergedDetails);
    await this.reportRuntimeError({
      phase: "context_guard",
      message: normalized.message,
      stack: normalized.stack,
      details: {
        ...mergedDetails,
        userFacingMessage:
          typeof mergedDetails.userFacingMessage === "string"
            ? mergedDetails.userFacingMessage
            : buildAutomaticCompactionFailureMessage(normalized.message)
      }
    });
  }

  private async handlePromptDispatchError(
    error: unknown,
    message: RuntimeUserMessage,
    dispatchMeta?: { attempt: number; maxAttempts: number }
  ): Promise<PromptDispatchResult> {
    const normalized = normalizeRuntimeError(error);

    // ── Credential pool failover for rate-limit / quota errors ──
    if (this.openAIAuthBrokerController?.hasLease()) {
      const handled = await this.openAIAuthBrokerController.attemptRecovery(error, normalized.message, message);
      if (handled) return "retry_scheduled";
    } else if (this.pooledCredentialId && this.credentialPoolService) {
      const rotated = await this.attemptCredentialRotation(error, normalized.message, message);
      if (rotated) return "retry_scheduled"; // retry dispatched with new credential
    }

    const phase: RuntimeErrorEvent["phase"] = isLikelyCompactionError(normalized.message)
      ? "compaction"
      : "prompt_dispatch";
    const droppedPendingCount = this.pendingDeliveries.length;
    if (droppedPendingCount > 0) {
      this.pendingDeliveries = [];
    }
    const details = {
      textPreview: previewForLog(message.text),
      imageCount: message.images?.length ?? 0,
      pendingCount: droppedPendingCount,
      droppedPendingCount,
      attempt: dispatchMeta?.attempt,
      maxAttempts: dispatchMeta?.maxAttempts
    };

    this.logRuntimeError(phase, error, details);

    await this.reportRuntimeError({
      phase,
      message: normalized.message,
      stack: normalized.stack,
      details
    });

    this.ignoreNextAgentStart = true;

    if (droppedPendingCount > 0) {
      await this.emitStatus();
    }

    if (this.status !== "terminated") {
      await this.updateStatus("idle");
    }

    if (this.status !== "terminated" && this.callbacks.onAgentEnd) {
      try {
        await this.callbacks.onAgentEnd(this.descriptor.agentId);
      } catch (callbackError) {
        this.logRuntimeError(phase, callbackError, {
          callback: "onAgentEnd"
        });
      }
    }

    return "failed";
  }

  private noteActivity(): void {
    this.lastActivityAtMs = Date.now();
  }

  private shouldReconcilePooledAuthBeforeDispatch(): boolean {
    return Date.now() - this.lastActivityAtMs >= POOLED_AUTH_RECONCILE_IDLE_MS;
  }

  private getRuntimeAuthStorage():
    | { get?: (key: string) => AuthCredential | undefined; set: (key: string, value: AuthCredential) => void }
    | undefined {
    const modelRegistry = this.session.modelRegistry as
      | { authStorage?: { get?: (key: string) => AuthCredential | undefined; set: (key: string, value: AuthCredential) => void } }
      | undefined;
    return modelRegistry?.authStorage;
  }

  private async applyPooledRuntimeAuth(
    provider: string,
    credentialId: string,
    authData: Record<string, AuthCredential>,
    options?: { markUsed?: boolean }
  ): Promise<void> {
    const authStorage = this.getRuntimeAuthStorage();
    const credential = authData[provider];
    if (!authStorage || !credential) {
      throw new Error(`Missing runtime auth storage for pooled provider: ${provider}`);
    }

    const previousCredentialId = this.pooledCredentialId;
    const previousCredential = authStorage.get?.(provider);
    const previousFingerprint = this.pooledCredentialFingerprint ?? fingerprintAuthCredential(previousCredential);
    const nextFingerprint = fingerprintAuthCredential(credential);

    authStorage.set(provider, credential);
    if (options?.markUsed) {
      await this.credentialPoolService?.markUsed(provider, credentialId);
    }

    this.pooledCredentialId = credentialId;
    this.pooledCredentialProvider = provider;
    this.pooledCredentialFingerprint = nextFingerprint;
    if (
      provider === "openai-codex" &&
      previousCredentialId &&
      (previousCredentialId !== credentialId ||
        (previousFingerprint !== undefined && previousFingerprint !== nextFingerprint))
    ) {
      this.closeStaleOpenAICodexWebSocketSession("pooled_auth_changed");
    }
  }

  private closeStaleOpenAICodexWebSocketSession(stage: string): void {
    const provider = normalizeProviderId(this.pooledCredentialProvider ?? this.session.model?.provider ?? this.descriptor.model.provider);
    if (provider !== "openai-codex") {
      return;
    }

    try {
      closeOpenAICodexWebSocketSessions(this.session.sessionId);
    } catch (error) {
      this.logRuntimeError("interrupt", error, {
        stage: `${stage}:close_openai_codex_websocket_failed`,
        sessionId: this.session.sessionId,
        provider
      });
    }
  }

  private async rotateToNextHealthyCredential(
    provider: string,
    currentCredentialId: string,
    error: unknown,
    options: {
      errorPhase: RuntimeErrorEvent["phase"];
      failingProvider: string;
      noAlternativeStage: string;
      rotatedStage: string;
      reportMessage?: string;
    }
  ): Promise<boolean> {
    const pool = this.credentialPoolService;
    if (!pool) {
      return false;
    }

    let nextSelection: { credentialId: string; authStorageKey: string } | null;
    try {
      nextSelection = await pool.select(provider, {
        excludeCredentialId: currentCredentialId
      });
    } catch (selectionError) {
      this.logRuntimeError(options.errorPhase, selectionError, {
        stage: `${options.rotatedStage}:select_failed`,
        credentialId: currentCredentialId,
        provider,
        failingProvider: options.failingProvider
      });
      return false;
    }

    if (!nextSelection) {
      this.logRuntimeError(options.errorPhase, error, {
        stage: options.noAlternativeStage,
        credentialId: currentCredentialId,
        provider,
        failingProvider: options.failingProvider
      });
      return false;
    }

    try {
      const authData = await pool.buildRuntimeAuthData(provider, nextSelection.credentialId);
      await this.applyPooledRuntimeAuth(provider, nextSelection.credentialId, authData, {
        markUsed: true
      });

      this.logRuntimeError(options.errorPhase, error, {
        stage: options.rotatedStage,
        fromCredentialId: currentCredentialId,
        toCredentialId: nextSelection.credentialId,
        provider,
        failingProvider: options.failingProvider
      });

      if (options.reportMessage) {
        await this.reportRuntimeError({
          phase: options.errorPhase,
          message: options.reportMessage,
          details: {
            stage: options.rotatedStage,
            fromCredentialId: currentCredentialId,
            toCredentialId: nextSelection.credentialId,
            provider,
            failingProvider: options.failingProvider
          }
        });
      }

      return true;
    } catch (rotationError) {
      this.logRuntimeError(options.errorPhase, rotationError, {
        stage: `${options.rotatedStage}:build_auth_failed`,
        fromCredentialId: currentCredentialId,
        toCredentialId: nextSelection.credentialId,
        provider,
        failingProvider: options.failingProvider
      });
      return false;
    }
  }

  private async reconcilePooledAuthBeforeDispatch(): Promise<void> {
    const pool = this.credentialPoolService;
    const currentCredentialId = this.pooledCredentialId;
    const provider = normalizeProviderId(this.pooledCredentialProvider);
    const authStorage = this.getRuntimeAuthStorage();
    if (!pool || !currentCredentialId || !provider || !authStorage || !this.shouldReconcilePooledAuthBeforeDispatch()) {
      return;
    }

    try {
      const authData = await pool.buildRuntimeAuthData(provider, currentCredentialId);
      await this.applyPooledRuntimeAuth(provider, currentCredentialId, authData);
    } catch (error) {
      const normalized = normalizeRuntimeError(error);
      const rotated = await this.rotateToNextHealthyCredential(provider, currentCredentialId, error, {
        errorPhase: "prompt_dispatch",
        failingProvider: provider,
        noAlternativeStage: "credential_pool:reconcile_no_alternative",
        rotatedStage: "credential_pool:reconcile_rotated"
      });
      if (!rotated) {
        this.logRuntimeError("prompt_dispatch", error, {
          stage: "credential_pool:reconcile_failed",
          credentialId: currentCredentialId,
          provider,
          message: normalized.message
        });
      }
    }
  }

  /**
   * Attempt to rotate to a different pooled provider credential on auth, rate-limit, or quota errors.
   * Returns true if a retry was dispatched with a new credential, false otherwise.
   */
  private async attemptCredentialRotation(
    error: unknown,
    errorMessage: string,
    message: RuntimeUserMessage
  ): Promise<boolean> {
    const pool = this.credentialPoolService;
    const currentCredId = this.pooledCredentialId;
    const pooledProvider = normalizeProviderId(this.pooledCredentialProvider);
    const failingProvider = normalizeProviderId(this.session.model?.provider ?? this.descriptor.model.provider);
    if (!pool || !currentCredId || !pooledProvider || failingProvider !== pooledProvider) {
      return false;
    }

    // Check for auth errors first — mark auth_error, then rotate if another healthy credential exists.
    const isAuthFailure = isLikelyCredentialPoolAuthError(errorMessage);
    if (isAuthFailure) {
      try {
        await pool.markAuthError(pooledProvider, currentCredId);
      } catch (markError) {
        this.logRuntimeError("prompt_dispatch", markError, {
          stage: "credential_pool:mark_auth_error_failed",
          credentialId: currentCredId,
          provider: pooledProvider,
          failingProvider
        });
        return false;
      }

      const providerLabel = getPooledProviderLabel(pooledProvider);
      const rotated = await this.rotateToNextHealthyCredential(pooledProvider, currentCredId, error, {
        errorPhase: "prompt_dispatch",
        failingProvider,
        noAlternativeStage: "credential_pool:auth_error_no_alternative",
        rotatedStage: "credential_pool:auth_error_rotated",
        reportMessage: `${providerLabel} auth error hit — rotating to another account and retrying.`
      });
      if (!rotated) {
        return false;
      }

      setTimeout(() => {
        if (this.status !== "terminated") {
          this.dispatchPrompt(message);
        }
      }, 0);
      return true;
    }

    // Check for rate-limit / quota errors
    const classification = classifyRuntimeCapacityError(errorMessage);
    if (!classification.isQuotaOrRateLimit) return false;

    // Determine cooldown duration
    const is402 = /\b402\b/.test(errorMessage) || /\bpayment required\b/i.test(errorMessage);
    const defaultCooldownMs = is402 ? 3_600_000 : 60_000; // 1hr for 402, 1min for 429
    const cooldownUntil = Date.now() + (classification.retryAfterMs ?? defaultCooldownMs);

    try {
      await pool.markExhausted(pooledProvider, currentCredId, { cooldownUntil });
    } catch (markError) {
      this.logRuntimeError("prompt_dispatch", markError, {
        stage: "credential_pool:mark_exhausted_failed",
        credentialId: currentCredId,
        provider: pooledProvider,
        failingProvider
      });
      return false;
    }

    const earliestExpiry = await pool.getEarliestCooldownExpiry(pooledProvider);
    const resetInfo = earliestExpiry
      ? ` Estimated reset: ${new Date(earliestExpiry).toLocaleTimeString()}.`
      : "";
    const providerLabel = getPooledProviderLabel(pooledProvider);
    const rotated = await this.rotateToNextHealthyCredential(pooledProvider, currentCredId, error, {
      errorPhase: "prompt_dispatch",
      failingProvider,
      noAlternativeStage: "credential_pool:all_exhausted",
      rotatedStage: "credential_pool:rotating",
      reportMessage: `${providerLabel} rate limit hit — rotating to another account and retrying.`
    });
    if (!rotated) {
      await this.reportRuntimeError({
        phase: "prompt_dispatch",
        message: `All ${providerLabel} accounts are rate-limited.${resetInfo}`,
        details: {
          stage: "credential_pool:all_exhausted",
          exhaustedCredentialId: currentCredId,
          provider: pooledProvider,
          failingProvider
        }
      });
      return false;
    }

    // Retry after the current dispatch promise unwinds so promptDispatchPending stays accurate.
    setTimeout(() => {
      if (this.status !== "terminated") {
        this.dispatchPrompt(message);
      }
    }, 0);
    return true;
  }

  private async handleAutoCompactionEndEvent(
    event: Extract<AgentSessionEvent, { type: "compaction_end" }>
  ): Promise<void> {
    const compactionReason = this.latestAutoCompactionReason;

    const autoCompactionError = typeof event.errorMessage === "string" ? event.errorMessage.trim() : "";
    if (this.status === "terminated") {
      return;
    }

    if (!autoCompactionError) {
      if (event.aborted) {
        const forgeFailure = consumeForgePiCompactionFailure(this.compactionFailureScopeKey);
        await this.reportRuntimeError({
          phase: "compaction",
          message: forgeFailure?.message ?? "Automatic compaction was cancelled",
          details: {
            ...(forgeFailure?.details ?? {}),
            recoveryStage: forgeFailure ? "forge_compaction_failed" : "auto_compaction_aborted",
            compactionReason,
            autoCompactionAborted: true,
            autoCompactionWillRetry: event.willRetry,
            compactionRetryPlanned: false,
            userCancelled: !forgeFailure,
            userFacingMessage: forgeFailure?.userFacingMessage ?? "Automatic compaction was cancelled."
          }
        });
        this.latestAutoCompactionReason = undefined;
        this.autoCompactionEntryKeysBefore = undefined;
        this.endAutoCompactionRecovery();
        this.noteAutoCompactionFailureCooldown();
        await this.flushRecoveryBufferedMessages();
        return;
      }

      const compactionStartSnapshot = this.autoCompactionEntryKeysBefore;
      if (compactionStartSnapshot === undefined) {
        await this.reportRuntimeError({
          phase: "compaction",
          message: "Automatic compaction ended without a compaction_start snapshot",
          details: {
            recoveryStage: "auto_compaction_failed",
            compactionReason,
            source: "auto_compaction_end",
            autoCompactionAborted: event.aborted,
            autoCompactionWillRetry: event.willRetry,
            missingCompactionStartSnapshot: true
          }
        });
        this.latestAutoCompactionReason = undefined;
        this.autoCompactionEntryKeysBefore = undefined;
        this.endAutoCompactionRecovery();
        this.noteAutoCompactionFailureCooldown();
        await this.flushRecoveryBufferedMessages();
        return;
      }

      const newCompactionEntries = this.getNewCompactionEntries(compactionStartSnapshot);
      if (newCompactionEntries.length === 0) {
        await this.reportRuntimeError({
          phase: "compaction",
          message: "Automatic compaction ended without writing a compaction record",
          details: {
            recoveryStage: "auto_compaction_failed",
            compactionReason,
            source: "auto_compaction_end",
            autoCompactionAborted: event.aborted,
            autoCompactionWillRetry: event.willRetry
          }
        });
        this.latestAutoCompactionReason = undefined;
        this.autoCompactionEntryKeysBefore = undefined;
        this.endAutoCompactionRecovery();
        this.noteAutoCompactionFailureCooldown();
        await this.flushRecoveryBufferedMessages();
        return;
      }

      await this.reportRuntimeError({
        phase: "compaction",
        message: "Context automatically compacted",
        details: {
          recoveryStage: "auto_compaction_succeeded",
          compactionReason,
          userFacingMessage: "Automatic compaction completed."
        }
      });
      this.latestAutoCompactionReason = undefined;
      this.autoCompactionEntryKeysBefore = undefined;
      this.endAutoCompactionRecovery();
      await this.flushRecoveryBufferedMessages();
      return;
    }

    const ownsAutoCompactionRecovery = this.autoCompactionRecoveryInProgress;
    if (this.isContextRecoveryActive() && !ownsAutoCompactionRecovery) {
      this.logRuntimeError("compaction", new Error(autoCompactionError), {
        recoveryStage: "auto_compaction_skipped",
        reason: this.contextRecoveryInProgress ? "recovery_already_in_progress" : "recovery_grace_period"
      });
      this.latestAutoCompactionReason = undefined;
      this.endAutoCompactionRecovery();
      return;
    }

    if (!ownsAutoCompactionRecovery) {
      this.beginAutoCompactionRecovery();
    }

    try {
      const baseDetails = {
        source: "auto_compaction_end",
        compactionReason,
        autoCompactionAborted: event.aborted,
        autoCompactionWillRetry: event.willRetry
      };

      this.logRuntimeError("compaction", new Error(autoCompactionError), {
        ...baseDetails,
        recoveryStage: "auto_compaction_failed"
      });

      await this.reportRuntimeError({
        phase: "compaction",
        message: autoCompactionError,
        details: {
          ...baseDetails,
          recoveryStage: "auto_compaction_failed",
          userFacingMessage: buildAutomaticCompactionFailureMessage(autoCompactionError)
        }
      });

      const manualRetry = await this.retryCompactionOnceAfterAutoFailure(autoCompactionError, baseDetails);
      if (manualRetry.recovered) {
        this.dropTrailingOverflowErrorIfPresent(compactionReason);
        return;
      }

      const emergencyTrim = await this.runEmergencyContextTrim({
        autoCompactionError,
        manualRetryError: manualRetry.errorMessage
      });
      if (emergencyTrim.recovered) {
        this.dropTrailingOverflowErrorIfPresent(compactionReason);
        return;
      }

      await this.reportRuntimeError({
        phase: "compaction",
        message:
          "Context recovery failed after auto-compaction retry and emergency trim. Start a new session or manually trim conversation history.",
        details: {
          ...baseDetails,
          recoveryStage: "recovery_failed",
          autoCompactionError,
          manualRetryError: manualRetry.errorMessage,
          emergencyTrimError: emergencyTrim.errorMessage
        }
      });
      this.noteAutoCompactionFailureCooldown();
    } finally {
      this.latestAutoCompactionReason = undefined;
      this.autoCompactionEntryKeysBefore = undefined;
      this.endAutoCompactionRecovery();
      await this.flushRecoveryBufferedMessages();
    }
  }

  private async retryCompactionOnceAfterAutoFailure(
    autoCompactionError: string,
    details: Record<string, unknown>
  ): Promise<{ recovered: boolean; errorMessage?: string }> {
    try {
      const beforeCompactionEntries = this.getCompactionEntryKeys();
      await withTimeout(this.compact(), this.getCompactionTimeoutMs(), "reactive_compaction_retry", {
        onTimeout: () => this.abortCompactionSafely("reactive_compaction_retry_timeout_abort")
      });
      const recovered = this.getNewCompactionEntries(beforeCompactionEntries).length > 0;
      if (!recovered) {
        return {
          recovered: false,
          errorMessage: "Reactive compaction retry completed without writing a compaction record"
        };
      }
      return { recovered: true };
    } catch (error) {
      const normalized = normalizeRuntimeError(error);
      this.logRuntimeError("compaction", error, {
        ...details,
        recoveryStage: "manual_retry_failed",
        autoCompactionError
      });
      return {
        recovered: false,
        errorMessage: normalized.message
      };
    }
  }

  private async runEmergencyContextTrim(options: {
    autoCompactionError: string;
    manualRetryError?: string;
  }): Promise<{ recovered: boolean; errorMessage?: string }> {
    try {
      const sessionContext = this.session.sessionManager.buildSessionContext();
      const trimResult = trimConversationForEmergencyRecovery(
        sessionContext.messages as EmergencyContextTrimMessage[]
      );

      if (!trimResult.wasTrimmed) {
        return {
          recovered: false,
          errorMessage: "Emergency trim had no removable middle messages"
        };
      }

      this.rebuildSessionContextFromTrimmedMessages(trimResult.trimmedMessages);
      await this.emitStatus();

      this.logRuntimeError("compaction", new Error("Emergency context trim applied"), {
        recoveryStage: "emergency_trim_applied",
        autoCompactionError: options.autoCompactionError,
        manualRetryError: options.manualRetryError,
        originalMessageCount: trimResult.originalCount,
        removedMiddleCount: trimResult.removedMiddleCount,
        removedToolLikeCount: trimResult.removedToolLikeCount,
        keptHeadCount: trimResult.keptHeadCount,
        keptTailCount: trimResult.keptTailCount
      });

      return { recovered: true };
    } catch (error) {
      const normalized = normalizeRuntimeError(error);
      this.logRuntimeError("compaction", error, {
        recoveryStage: "emergency_trim_failed",
        autoCompactionError: options.autoCompactionError,
        manualRetryError: options.manualRetryError
      });
      return {
        recovered: false,
        errorMessage: normalized.message
      };
    }
  }

  private rebuildSessionContextFromTrimmedMessages(messages: EmergencyContextTrimMessage[]): void {
    this.session.sessionManager.resetLeaf();

    const currentModel = this.session.model;
    if (currentModel) {
      this.session.sessionManager.appendModelChange(currentModel.provider, currentModel.id);
    }
    this.session.sessionManager.appendThinkingLevelChange(this.session.thinkingLevel);

    for (const message of messages) {
      this.session.sessionManager.appendMessage(structuredClone(message) as any);
    }

    const rebuiltContext = this.session.sessionManager.buildSessionContext();
    this.replaceSessionAgentMessages(rebuiltContext.messages);
  }

  private dropTrailingOverflowErrorIfPresent(
    compactionReason: "threshold" | "overflow" | undefined
  ): void {
    if (compactionReason !== "overflow") {
      return;
    }

    const messages = this.getSessionAgentMessages();
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "assistant" && lastMessage.stopReason === "error") {
      this.replaceSessionAgentMessages(messages.slice(0, -1));
    }
  }

  /**
   * gpt-5.x managers intermittently answer a worker's terminal report or a
   * direct user-visible input with a side-effect-free assistant turn (no tool
   * calls, stopReason "stop"). Whitespace-only output is always invisible;
   * non-empty direct web session-transcript text is projected only when the
   * backend dispatch marker says assistant_output is allowed. Explicit-routed
   * sources such as Cortex, collaboration, Telegram, and non-inherited worker
   * reports still need a tool/side effect. Drop the trigger and unhandled assistant from
   * in-memory context, then re-dispatch the trigger with a bounded retry budget
   * keyed to the directive-stripped trigger text.
   */
  private async maybeResampleUnhandledHiddenOutputTurn(): Promise<boolean> {
    if (this.descriptor.role !== "manager" || this.status === "terminated") {
      return false;
    }
    if (this.isContextRecoveryActive() || this.session.isCompacting || this.pendingDeliveries.length > 0) {
      return false;
    }

    const messages = this.getSessionAgentMessages();
    const assistantMessage = messages[messages.length - 1];
    const triggerMessage = messages[messages.length - 2];
    if (!assistantMessage || !triggerMessage || assistantMessage.role !== "assistant" || triggerMessage.role !== "user") {
      return false;
    }

    const unhandledKind = classifyUnhandledAssistantMessage(assistantMessage);
    if (!unhandledKind) {
      return false;
    }

    const trigger = classifyHiddenOutputTrigger(extractTextFromMessageRecord(triggerMessage));
    if (!trigger) {
      return false;
    }

    if (!trigger.policyFacts.requiresVisibleCompletion) {
      return false;
    }

    if (trigger.policyFacts.allowsProjection && unhandledKind === "hidden_text") {
      return false;
    }

    const previousAttempts =
      this.hiddenOutputResampleState?.triggerKey === trigger.key ? this.hiddenOutputResampleState.attempts : 0;
    if (previousAttempts >= MAX_TERMINAL_REPORT_RESAMPLES) {
      console.error(`[swarm][${this.now()}] ${trigger.unhandledEvent}`, {
        runtime: "pi",
        agentId: this.descriptor.agentId,
        triggerKind: trigger.kind,
        reason: unhandledKind,
        resampleAttempts: previousAttempts,
        triggerPreview: previewForLog(trigger.text)
      });
      await this.reportRuntimeError({
        phase: "silent_turn",
        message: trigger.exhaustedMessage,
        details: {
          triggerKind: trigger.kind,
          reason: unhandledKind,
          resampleAttempts: previousAttempts,
          triggerPreview: previewForLog(trigger.text),
          userFacingMessage: trigger.userFacingExhaustedMessage
        }
      });
      return false;
    }

    const attempt = previousAttempts + 1;
    const directiveAdded =
      trigger.kind === "terminal_report" ? unhandledKind === "hidden_text" || attempt >= MAX_TERMINAL_REPORT_RESAMPLES : true;
    const redeliveryDirective =
      trigger.kind === "terminal_report" ? TERMINAL_REPORT_REDELIVERY_DIRECTIVE : DIRECT_USER_INPUT_REDELIVERY_DIRECTIVE;
    const redeliveryText = directiveAdded ? `${trigger.text}\n\n${redeliveryDirective}` : trigger.text;
    this.hiddenOutputResampleState = { triggerKey: trigger.key, attempts: attempt };
    const restoreMessagesOnFailure = messages.map((message) => structuredClone(message));
    this.replaceSessionAgentMessages(messages.slice(0, -2));
    this.closeStaleOpenAICodexWebSocketSession(trigger.resampleStage);
    console.warn(`[swarm][${this.now()}] ${trigger.resampleEvent}`, {
      runtime: "pi",
      agentId: this.descriptor.agentId,
      triggerKind: trigger.kind,
      reason: unhandledKind,
      attempt,
      maxAttempts: MAX_TERMINAL_REPORT_RESAMPLES,
      directiveAdded,
      triggerPreview: previewForLog(trigger.text)
    });
    this.dispatchPrompt(
      {
        text: redeliveryText
      },
      {
        restoreSessionMessagesOnFailure: restoreMessagesOnFailure,
        restoreStage: `${trigger.resampleStage}_dispatch_failed`
      }
    );
    return true;
  }

  private getSessionAgentMessages(): Array<Record<string, any>> {
    const state = this.session.state as { messages?: unknown[] } | undefined;
    if (Array.isArray(state?.messages)) {
      return state.messages.filter(isRecordLikeMessage);
    }

    const sessionMessages = (this.session as { messages?: unknown[] }).messages;
    if (Array.isArray(sessionMessages)) {
      return sessionMessages.filter(isRecordLikeMessage);
    }

    return [];
  }

  private replaceSessionAgentMessages(messages: unknown[]): void {
    const nextMessages = [...messages];
    const state = this.session.state as { messages?: unknown[] } | undefined;
    if (state && "messages" in state) {
      state.messages = nextMessages;
      return;
    }

    this.logRuntimeError("compaction", new Error("Unable to replace Pi session messages: writable session.state.messages is unavailable"), {
      stage: "replace_session_agent_messages_unavailable",
      messageCount: nextMessages.length
    });
  }

  private consumePendingMessage(messageKey: string): PendingDelivery | undefined {
    return consumePendingDeliveryByMessageKey(this.pendingDeliveries, messageKey);
  }

  private removePendingDeliveryById(deliveryId: string): void {
    const index = this.pendingDeliveries.findIndex((delivery) => delivery.deliveryId === deliveryId);
    if (index >= 0) {
      this.pendingDeliveries.splice(index, 1);
    }
  }

  private ensureNotTerminated(): void {
    if (this.status === "terminated") {
      throw new Error(`Agent ${this.descriptor.agentId} is terminated`);
    }
  }

  private async updateStatus(status: AgentStatus): Promise<void> {
    if (this.status === status) {
      await this.emitStatus();
      return;
    }

    const nextStatus = transitionAgentStatus(this.status, status);
    this.status = nextStatus;
    this.descriptor.status = nextStatus;
    this.descriptor.updatedAt = this.now();
    this.lastStreamingStatusEmitAtMs = nextStatus === "streaming" ? Date.now() : 0;
    await this.emitStatus();
  }

  private async emitStreamingStatusUpdateThrottled(): Promise<void> {
    if (this.status !== "streaming") {
      return;
    }

    const nowMs = Date.now();
    if (nowMs - this.lastStreamingStatusEmitAtMs < STREAMING_STATUS_EMIT_THROTTLE_MS) {
      return;
    }

    this.lastStreamingStatusEmitAtMs = nowMs;
    await this.emitStatus({ refreshContextUsage: false });
  }

  private async emitStatus(options?: { refreshContextUsage?: boolean }): Promise<void> {
    const contextUsage =
      options?.refreshContextUsage === false ? this.lastContextUsage : this.refreshContextUsage();

    await this.callbacks.onStatusChange(
      this.descriptor.agentId,
      this.status,
      this.pendingDeliveries.length,
      contextUsage
    );
  }

  private async emitCompactionStatusSafely(stage: string): Promise<void> {
    try {
      await this.emitStatus();
    } catch (error) {
      this.logRuntimeError("compaction", error, { stage });
    }
  }

  private refreshContextUsage(): AgentContextUsage | undefined {
    this.lastContextUsage = normalizeAgentContextUsage(this.session.getContextUsage?.());
    return this.lastContextUsage;
  }

  private pruneFailedTurnForReplay(replayMessages: RuntimeUserMessage[]): void {
    const stateMessages = this.getSessionAgentMessages();
    if (stateMessages.length === 0 || replayMessages.length === 0) {
      return;
    }

    let trimmedMessages = [...stateMessages];
    let changed = false;

    const lastMessage = trimmedMessages.at(-1);
    if (isAssistantErrorLike(lastMessage)) {
      trimmedMessages = trimmedMessages.slice(0, -1);
      changed = true;
    }

    let replayIndex = replayMessages.length - 1;
    let matchedAcceptedSuffix = false;
    while (replayIndex >= 0 && trimmedMessages.length > 0) {
      const trailingUserKey = extractRuntimeMessageKeyFromSessionMessage(trimmedMessages.at(-1));
      if (trailingUserKey === undefined) {
        break;
      }

      const replayMessageKey = buildRuntimeMessageKey(replayMessages[replayIndex]);
      if (trailingUserKey === replayMessageKey) {
        trimmedMessages = trimmedMessages.slice(0, -1);
        replayIndex -= 1;
        changed = true;
        matchedAcceptedSuffix = true;
        continue;
      }

      if (!matchedAcceptedSuffix) {
        replayIndex -= 1;
        continue;
      }

      break;
    }

    if (!changed) {
      return;
    }

    this.rebuildSessionContextFromTrimmedMessages(trimmedMessages as EmergencyContextTrimMessage[]);
  }

  private async reportRuntimeError(error: RuntimeErrorEvent): Promise<void> {
    if (!this.callbacks.onRuntimeError) {
      return;
    }

    try {
      await this.callbacks.onRuntimeError(this.descriptor.agentId, error);
    } catch (callbackError) {
      this.logRuntimeError(error.phase, callbackError, {
        callback: "onRuntimeError"
      });
    }
  }

  private logRuntimeError(
    phase: RuntimeErrorEvent["phase"],
    error: unknown,
    details?: Record<string, unknown>
  ): void {
    const normalized = normalizeRuntimeError(error);
    console.error(`[swarm][${this.now()}] runtime:error`, {
      runtime: "pi",
      agentId: this.descriptor.agentId,
      phase,
      message: normalized.message,
      stack: normalized.stack,
      ...details
    });
  }
}

function getForgeCompactionFailureDetails(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return {};
  }
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return {};
  }
  return details as Record<string, unknown>;
}

function buildAutomaticCompactionFailureMessage(message: string): string {
  return /\btimeout\b|\btimed out\b/i.test(message)
    ? "Automatic compaction timed out; context was not reduced."
    : `Automatic compaction failed: ${message}`;
}

type TimeoutOptions = {
  onTimeout?: () => void | Promise<void>;
};

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  options?: TimeoutOptions
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  let didTimeout = false;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        didTimeout = true;
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    });

    return await Promise.race([promise, timeoutPromise]);
  } catch (error) {
    if (didTimeout && options?.onTimeout) {
      await options.onTimeout();
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function normalizeAgentContextUsage(
  usage:
    | {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      }
    | undefined
): AgentContextUsage | undefined {
  if (!usage) {
    return undefined;
  }

  if (typeof usage.contextWindow !== "number" || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
    return undefined;
  }

  // pi can report `{ tokens: null, contextWindow, percent: null }` immediately after compaction
  // (before the next assistant response is generated). We normalize that to `undefined` so callers
  // treat usage as unknown. `runContextGuard()` handles this explicitly by skipping manual compaction
  // when usage is unknown and proceeding to the resume prompt.
  if (typeof usage.tokens !== "number" || !Number.isFinite(usage.tokens) || usage.tokens < 0) {
    return undefined;
  }

  const contextWindow = Math.max(1, Math.round(usage.contextWindow));
  const tokens = Math.round(usage.tokens);
  const percentFromTokens = (tokens / contextWindow) * 100;
  const rawPercent = typeof usage.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : percentFromTokens;
  const percent = Math.max(0, Math.min(100, rawPercent));

  return {
    tokens,
    contextWindow,
    percent
  };
}

export function computeGuardThresholds(contextWindow: number): {
  softThresholdTokens: number;
  hardThresholdTokens: number;
} {
  const estimationMargin = Math.max(
    ESTIMATION_ERROR_MARGIN_MIN_TOKENS,
    Math.floor(contextWindow * ESTIMATION_ERROR_MARGIN_PERCENT)
  );

  let hardThresholdTokens = contextWindow - COMPACTION_RESERVE_TOKENS;
  let softThresholdTokens =
    contextWindow - COMPACTION_RESERVE_TOKENS - HANDOFF_TURN_TOKEN_BUDGET - estimationMargin;

  if (hardThresholdTokens <= 0) {
    hardThresholdTokens = Math.max(1, Math.floor(contextWindow * 0.85));
    softThresholdTokens = Math.max(0, Math.min(Math.floor(contextWindow * 0.75), hardThresholdTokens - 1));
  } else if (softThresholdTokens <= 0) {
    softThresholdTokens = Math.max(0, Math.min(Math.floor(contextWindow * 0.75), hardThresholdTokens - 1));
  }

  if (softThresholdTokens >= hardThresholdTokens) {
    softThresholdTokens = Math.max(0, hardThresholdTokens - 1);
  }

  return {
    softThresholdTokens,
    hardThresholdTokens
  };
}

export function buildHandoffPrompt(handoffFilePath: string): string {
  return `URGENT — CONTEXT LIMIT: Your context window is nearly full. A compaction will run after this message. You must write a handoff document NOW so you can resume seamlessly.

INSTRUCTIONS:
1. Use the write tool to create this file: \`${handoffFilePath}\`
2. Do NOT use any other tool. Do NOT read files. Do NOT run commands. Do not use bash, read, or edit tools — ONLY the write tool.
3. Do NOT continue your previous task. ONLY write this handoff file.

FILE CONTENTS — use these exact headings:

## Current Task
What is the specific task/objective you're working on? (1-2 sentences)

## Progress
What concrete actions have you completed? (bullet list, max 5 items)

## Active Files
Which files are you working in? Include paths and line numbers if relevant. (bullet list)

## Next Steps
What were you about to do next? Be precise — name the file, function, and action. (bullet list, max 3 items)

## Open Issues
Any blockers, uncertainties, or things to verify? (bullet list, or "None")

CONSTRAINTS:
- Maximum 300 words total
- Focus on specifics that would be lost in a summary: file paths, function names, line numbers, variable names
- Write the file immediately with a single write tool call`;
}

export function buildResumePrompt(handoffContent: string | undefined): string {
  if (!handoffContent) {
    return `Your context was compacted to free up space. Some earlier conversation details have been summarized.

Before continuing:
1. Review the compaction summary above to orient yourself.
2. Check your working directory for recent file modifications (\`git status\` is preferred; use your shell's directory listing command if needed) to verify current state.
3. If you're unsure what you were doing, look for recently modified files.

Then continue where you left off.`;
  }

  return `Your context was compacted to free up space. Before compaction, you wrote a handoff document with your working state:

---
${handoffContent}
---

Before continuing:
1. Review the compaction summary above for broad context.
2. Use the handoff document above for your specific working state.
3. Verify the workspace is consistent — run \`git status\` or check the files listed in "Active Files" to confirm your edits are intact.
4. Follow the "Next Steps" to continue where you left off.
5. Note any "Open Issues" that need attention.

Continue your work now.`;
}

export function buildHandoffFilePath(descriptor: Pick<AgentDescriptor, "agentId"> & { cwd?: string }): string {
  const safeId = descriptor.agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(descriptor.cwd ?? ".", `.forge-handoff-${safeId}.md`);
}

export function isAlreadyCompactedError(message: string): boolean {
  return /already\s+compact(?:ed)?/i.test(message) || /nothing\s+to\s+compact/i.test(message);
}

function cloneRuntimeUserMessage(message: RuntimeUserMessage | undefined): RuntimeUserMessage | undefined {
  if (!message) {
    return undefined;
  }

  return {
    text: message.text,
    images: message.images?.map((image) => ({ ...image })) ?? []
  };
}

type UnhandledAssistantKind = "empty" | "hidden_text";

type HiddenOutputTriggerKind = "terminal_report" | "direct_user_input";

interface HiddenOutputTrigger {
  kind: HiddenOutputTriggerKind;
  key: string;
  text: string;
  resampleEvent: string;
  unhandledEvent: string;
  resampleStage: string;
  exhaustedMessage: string;
  userFacingExhaustedMessage: string;
  policyFacts: AssistantOutputPolicyFacts;
}

function classifyUnhandledAssistantMessage(
  message: Record<string, any>
): UnhandledAssistantKind | undefined {
  if (message.stopReason !== "stop") {
    return undefined;
  }

  const content = message.content;
  if (typeof content === "string") {
    return content.trim().length === 0 ? "empty" : "hidden_text";
  }
  if (!Array.isArray(content)) {
    return content === undefined || content === null ? "empty" : undefined;
  }

  let sawNonEmptyText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (isAssistantToolOrSideEffectBlockType(type)) {
      return undefined;
    }
    if (type !== "text") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      sawNonEmptyText = true;
    }
  }

  return sawNonEmptyText ? "hidden_text" : "empty";
}

function isAssistantToolOrSideEffectBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "tool_use" || type === "toolResult" || type === "tool_result";
}

function classifyHiddenOutputTrigger(text: string): HiddenOutputTrigger | undefined {
  const reportText = stripTerminalReportRedeliveryDirective(text);
  if (isTerminalWorkerReport(reportText)) {
    return {
      kind: "terminal_report",
      key: `terminal_report:${reportText}`,
      text: reportText,
      resampleEvent: "manager:terminal_report_resample",
      unhandledEvent: "manager:terminal_report_unhandled",
      resampleStage: "terminal_report_resample",
      exhaustedMessage: "Manager produced no visible response to a worker's final report",
      userFacingExhaustedMessage:
        "⚠️ The manager processed a worker's final report but did not produce a visible response after automatic retries. Send a message (e.g. \"update?\") to surface the outcome.",
      policyFacts: runtimeInputAssistantOutputPolicyFacts(reportText)
    };
  }

  const directUserText = stripDirectUserInputRedeliveryDirective(text);
  const sourceMetadata = parseDirectUserSourceMetadata(directUserText);
  if (!sourceMetadata) {
    return undefined;
  }

  return {
    kind: "direct_user_input",
    key: `direct_user_input:${directUserText}`,
    text: directUserText,
    resampleEvent: "manager:user_input_resample",
    unhandledEvent: "manager:user_input_unhandled",
    resampleStage: "user_input_resample",
    exhaustedMessage: "Manager produced no visible response to a direct user message",
    userFacingExhaustedMessage:
      "⚠️ The manager received your message but did not produce a visible response after automatic retries. Send a follow-up message to continue.",
    policyFacts: runtimeInputAssistantOutputPolicyFacts(directUserText)
  };
}

function isTerminalWorkerReport(text: string): boolean {
  const normalized = text.trimStart();
  return TERMINAL_WORKER_REPORT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function stripTerminalReportRedeliveryDirective(text: string): string {
  const suffix = `\n\n${TERMINAL_REPORT_REDELIVERY_DIRECTIVE}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

function stripDirectUserInputRedeliveryDirective(text: string): string {
  const suffix = `\n\n${DIRECT_USER_INPUT_REDELIVERY_DIRECTIVE}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

function parseDirectUserSourceMetadata(text: string): { channel: string } | undefined {
  const match = text.match(DIRECT_USER_SOURCE_CONTEXT_PATTERN);
  if (!match) {
    return undefined;
  }

  try {
    const sourceContext = JSON.parse(match[1]) as { channel?: unknown };
    if (typeof sourceContext.channel !== "string") {
      return undefined;
    }
    const channel = sourceContext.channel.trim();
    if (channel.length === 0) {
      return undefined;
    }
    return { channel };
  } catch {
    return undefined;
  }
}

function extractTextFromMessageRecord(message: Record<string, any>): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") {
        return "";
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function isRecordLikeMessage(message: unknown): message is Record<string, any> {
  return !!message && typeof message === "object";
}

function isAssistantErrorLike(message: unknown): boolean {
  if (!isRecordLikeMessage(message)) {
    return false;
  }

  if (message.role !== "assistant") {
    return false;
  }

  return message.stopReason === "error" || typeof message.errorMessage === "string";
}

function extractRuntimeMessageKeyFromSessionMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "user") {
    return undefined;
  }

  return extractMessageKeyFromRuntimeContent(candidate.content);
}

async function prepareRuntimeUserMessageForDispatch(
  input: RuntimeUserMessageInput
): Promise<RuntimeUserMessage> {
  const normalized = normalizeRuntimeUserMessage(input);
  if (!normalized.images || normalized.images.length === 0) {
    return normalized;
  }

  const images = await Promise.all(
    normalized.images.map(async (image) => {
      const resized = await resizeImageIfNeeded(image.data, image.mimeType);
      return {
        mimeType: resized.mimeType,
        data: resized.data
      };
    })
  );

  return {
    text: normalized.text,
    images
  };
}

function toImageContent(images: RuntimeImageAttachment[] | undefined): ImageContent[] {
  if (!images || images.length === 0) {
    return [];
  }

  return images.map((image) => ({
    type: "image" as const,
    mimeType: image.mimeType,
    data: image.data
  }));
}

function buildUserMessageContent(text: string, images: ImageContent[]): string | (TextContent | ImageContent)[] {
  if (images.length === 0) {
    return text;
  }

  const parts: (TextContent | ImageContent)[] = [];
  if (text.length > 0) {
    parts.push({
      type: "text",
      text
    });
  }

  parts.push(...images);
  return parts;
}

function isLikelyCompactionError(message: string): boolean {
  return /\bcompact(?:ion)?\b/i.test(message);
}

function normalizeProviderId(provider: string | undefined): string | undefined {
  const normalized = provider?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function isLikelyCredentialPoolAuthError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  const authIndicators = [
    "401",
    "403",
    "unauthorized",
    "forbidden",
    "authentication",
    "invalid api key",
    "no api key",
    "missing api key",
    "invalid token",
    "missing auth",
    "no auth",
    "access denied",
    "permission denied",
    "oauth",
    "token expired",
    "expired token",
    "expired credential",
    "login required"
  ];

  return authIndicators.some((indicator) => normalized.includes(indicator));
}

function getPooledProviderLabel(provider: string | undefined): string {
  switch (normalizeProviderId(provider)) {
    case "openai-codex":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    default:
      return provider?.trim() || "Provider";
  }
}

function extractPiModelCallMeta(message: unknown, session?: AgentSession): { meta: RuntimeModelCallMeta } | Record<string, never> {
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") {
    return {};
  }

  const record = message as {
    provider?: unknown;
    api?: unknown;
    model?: unknown;
    responseModel?: unknown;
    responseId?: unknown;
    stopReason?: unknown;
    usage?: unknown;
    timestamp?: unknown;
  };
  const usage = normalizePiUsage(record.usage);
  const meta: RuntimeModelCallMeta = {
    ...(usage ? { usage: usage.usage, costUsd: usage.costUsd } : {}),
    provider: readString(record.provider),
    api: readString(record.api),
    modelId: readString(record.model),
    responseModelId: readString(record.responseModel),
    providerRequestId: readString(record.responseId),
    stopReason: readString(record.stopReason),
    requestPayloadFidelity: session?.messages ? "partial" : "unavailable",
    requestMessages: session?.messages ? session.messages.slice(-24) : undefined,
    metadata: typeof record.timestamp === "number" ? { providerTimestamp: record.timestamp } : undefined,
  };
  return { meta };
}

function normalizePiUsage(value: unknown): { usage: RuntimeModelCallMeta["usage"]; costUsd?: RuntimeModelCallMeta["costUsd"] } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const cost = value && typeof record.cost === "object" && record.cost !== null ? record.cost as Record<string, unknown> : undefined;
  return {
    usage: {
      input: readNumber(record.input),
      output: readNumber(record.output),
      cacheRead: readNumber(record.cacheRead),
      cacheWrite: readNumber(record.cacheWrite),
      total: readNumber(record.totalTokens),
    },
    costUsd: cost ? {
      input: readNumber(cost.input),
      output: readNumber(cost.output),
      cacheRead: readNumber(cost.cacheRead),
      cacheWrite: readNumber(cost.cacheWrite),
      total: readNumber(cost.total),
    } : undefined,
  };
}

function normalizeRuntimeSessionEvent(event: AgentSessionEvent, session?: AgentSession): RuntimeSessionEvent | null {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
    case "turn_start":
      return { type: event.type };

    case "turn_end":
      return {
        type: "turn_end",
        toolResults: event.toolResults
      };

    case "message_start":
    case "message_update":
      return {
        type: event.type,
        message: event.message as RuntimeSessionMessage
      };

    case "message_end":
      return {
        type: "message_end",
        message: event.message as RuntimeSessionMessage,
        ...extractPiModelCallMeta(event.message, session)
      };

    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args
      };

    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        partialResult: event.partialResult
      };

    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        result: event.result,
        isError: event.isError
      };

    case "compaction_start":
      if (event.reason === "manual") {
        return null;
      }
      return {
        type: "auto_compaction_start",
        reason: event.reason
      };

    case "compaction_end":
      if (event.reason === "manual") {
        return null;
      }
      return {
        type: "auto_compaction_end",
        result: event.result,
        aborted: event.aborted,
        willRetry: event.willRetry,
        ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {})
      };

    case "auto_retry_start":
      return {
        type: "auto_retry_start",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage
      };

    case "auto_retry_end":
      return {
        type: "auto_retry_end",
        success: event.success,
        attempt: event.attempt,
        ...(typeof event.finalError === "string" ? { finalError: event.finalError } : {})
      };

    case "queue_update":
    case "session_info_changed":
    case "thinking_level_changed":
      return null;

    default:
      return null;
  }
}
