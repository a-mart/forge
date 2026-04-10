import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
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
import { transitionAgentStatus } from "../agent-state-machine.js";
import type {
  RuntimeImageAttachment,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
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

interface PendingDelivery {
  deliveryId: string;
  messageKey: string;
  message: RuntimeUserMessage;
  mode: "steer" | "recovery_buffer";
}

const MAX_PROMPT_DISPATCH_ATTEMPTS = 2;
const STREAMING_STATUS_EMIT_THROTTLE_MS = 1_000;
const MID_TURN_CONTEXT_GUARD_ENABLED = true;
const HANDOFF_TURN_TOKEN_BUDGET = 2_048;
const ESTIMATION_ERROR_MARGIN_PERCENT = 0.05;
const ESTIMATION_ERROR_MARGIN_MIN_TOKENS = 4_096;
const COMPACTION_RESERVE_TOKENS = 16_384;
const CONTEXT_BUDGET_CHECK_THROTTLE_MS = 3_000;
const CONTEXT_GUARD_ABORT_TIMEOUT_MS = 15_000;
const CONTEXT_GUARD_COMPACT_TIMEOUT_MS = 180_000;
const CONTEXT_RECOVERY_GRACE_MS = 2_000;
const HANDOFF_TURN_TIMEOUT_MS = 45_000;
const MAX_HANDOFF_CONTENT_CHARS = 3_000;
const MAX_RECOVERY_BUFFERED_MESSAGES = 25;
const DEFAULT_ABORT_TIMEOUT_MS = 5_000;

export type { RuntimeImageAttachment, RuntimeUserMessage, RuntimeUserMessageInput } from "../runtime-contracts.js";

export class AgentRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;
  readonly runtimeType = "pi" as const;

  /** Credential pool fields for multi-account failover */
  pooledCredentialId: string | undefined;
  pooledCredentialProvider: string | undefined;
  credentialPoolService: CredentialPoolService | undefined;

  private readonly session: AgentSession;
  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly now: () => string;
  private readonly systemPrompt: string;
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
  private autoCompactionRecoveryInProgress = false;
  private guardAbortController: AbortController | undefined;
  private lastContextBudgetCheckAtMs = 0;
  private latestAutoCompactionReason: "threshold" | "overflow" | undefined;
  private suppressSessionEventsUntilIdle = false;

  constructor(options: {
    descriptor: AgentDescriptor;
    session: AgentSession;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    systemPrompt?: string;
  }) {
    this.descriptor = options.descriptor;
    this.session = options.session;
    this.callbacks = options.callbacks;
    this.now = options.now ?? (() => new Date().toISOString());
    this.systemPrompt = options.systemPrompt ?? options.session.systemPrompt ?? "";
    this.status = options.descriptor.status;

    this.unsubscribe = this.session.subscribe((event) => {
      void this.handleEvent(event);
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

  isStreaming(): boolean {
    return this.session.isStreaming;
  }

  isContextRecoveryInProgress(): boolean {
    return this.contextRecoveryInProgress;
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

    const state = this.session.state as { messages?: unknown[] } | undefined;
    const stateMessages = Array.isArray(state?.messages) ? (structuredClone(state.messages) as EmergencyContextTrimMessage[]) : [];
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

      await this.emitStatus();
      return {
        targetAgentId: this.descriptor.agentId,
        deliveryId,
        acceptedMode: "steer"
      };
    }

    if (this.session.isStreaming || this.promptDispatchPending) {
      await this.enqueueMessage(deliveryId, message);
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

    await this.disposeSessionResources();
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
    await this.disposeSessionResources();
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
    await this.disposeSessionResources();
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

  private async disposeSessionResources(): Promise<void> {
    try {
      // NOTE: Uses the public AgentSession.extensionRunner API
      // (verified against @mariozechner/pi-coding-agent@0.55.0).
      // The try/catch ensures this remains safe against Pi version changes.
      const runner = this.session.extensionRunner;
      if (runner?.hasHandlers("session_shutdown")) {
        await runner.emit({ type: "session_shutdown" });
      }
    } catch (error) {
      this.logRuntimeError("interrupt", error, {
        stage: "dispose_session_shutdown_emit_failed"
      });
    }

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

  async smartCompact(customInstructions?: string): Promise<SmartCompactResult> {
    this.ensureNotTerminated();

    if (this.isContextRecoveryActive()) {
      throw new Error("Context recovery is already in progress");
    }

    this.beginContextRecovery();
    this.guardAbortController = new AbortController();
    const signal = this.guardAbortController.signal;

    const handoffFilePath = buildHandoffFilePath(this.descriptor);

    this.logContextGuard("smart_compact_started", {
      handoffFilePath,
      wasStreaming: this.session.isStreaming
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
        await withTimeout(this.compact(customInstructions), CONTEXT_GUARD_COMPACT_TIMEOUT_MS, "smart_compact_compact", {
          onTimeout: () => this.abortCompactionSafely("smart_compact_compact_timeout_abort")
        });
        compacted = true;
      } catch (error) {
        const normalized = normalizeRuntimeError(error);
        if (isAlreadyCompactedError(normalized.message)) {
          reason = "runtime_already_compacted";
        } else {
          reason = normalized.message;
          await this.reportContextGuardError(error, {
            stage: "smart_compact_compaction_failed",
            handoffWritten: handoffContent !== undefined
          });
        }
        // Continue to resume prompt even if compaction failed/skipped
      }

      if (signal.aborted) return { compacted: false, reason: "Aborted" };

      // Resume prompt
      try {
        const resumePrompt = buildResumePrompt(handoffContent);
        await this.session.prompt(resumePrompt);
      } catch (error) {
        await this.reportContextGuardError(error, { stage: "smart_compact_resume_failed" });
      }

      completed = true;
    } finally {
      await this.cleanupGuard(handoffFilePath);
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
    try {
      const result = await this.session.compact(customInstructions);
      await this.emitStatus();
      return result;
    } catch (error) {
      this.logRuntimeError("compaction", error, {
        customInstructionsPreview: previewForLog(customInstructions ?? "")
      });
      throw error;
    }
  }

  private abortCompactionSafely(stage: string): void {
    try {
      this.session.abortCompaction?.();
    } catch (error) {
      this.logRuntimeError("compaction", error, { stage });
    }
  }

  private isContextRecoveryActive(): boolean {
    return this.contextRecoveryInProgress || Date.now() < this.contextRecoveryGraceUntilMs;
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

  private dispatchPrompt(message: RuntimeUserMessage): void {
    this.promptDispatchPending = true;
    this.ignoreNextAgentStart = false;

    const run = this.dispatchPromptWithRetry(message)
      .catch((error) => {
        this.logRuntimeError("prompt_dispatch", error, {
          stage: "dispatch_prompt_retry"
        });
      })
      .finally(() => {
        this.promptDispatchPending = false;
        this.inFlightPrompts.delete(run);
      });

    this.inFlightPrompts.add(run);
  }

  private async dispatchPromptWithRetry(message: RuntimeUserMessage): Promise<void> {
    const images = toImageContent(message.images);

    for (let attempt = 1; attempt <= MAX_PROMPT_DISPATCH_ATTEMPTS; attempt += 1) {
      try {
        await this.sendToSession(message.text, images);
        return;
      } catch (error) {
        const canRetry =
          attempt < MAX_PROMPT_DISPATCH_ATTEMPTS &&
          this.status !== "terminated" &&
          this.status !== "streaming" &&
          !this.session.isStreaming;

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

        await this.handlePromptDispatchError(error, message, {
          attempt,
          maxAttempts: MAX_PROMPT_DISPATCH_ATTEMPTS
        });
        return;
      }
    }
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
    if (this.suppressSessionEventsUntilIdle) {
      if (event.type === "agent_end") {
        this.suppressSessionEventsUntilIdle = false;
        if (this.status !== "terminated") {
          await this.updateStatus("idle");
        }
      }
      return;
    }

    const normalizedEvent = normalizeRuntimeSessionEvent(event);
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
      if (this.status !== "terminated") {
        await this.updateStatus("idle");
      }
      if (this.callbacks.onAgentEnd) {
        await this.callbacks.onAgentEnd(this.descriptor.agentId);
      }
      return;
    }

    if (event.type === "compaction_start" && event.reason !== "manual") {
      this.latestAutoCompactionReason = event.reason;
      if (!this.isContextRecoveryActive()) {
        this.beginAutoCompactionRecovery();
      }
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

    await this.reportRuntimeError({
      phase: "context_guard",
      message: "Context limit approaching — running intelligent handoff before compaction",
      details: {
        recoveryStage: "guard_started",
        contextTokens: triggeringUsage.tokens,
        contextWindow: triggeringUsage.contextWindow,
        contextPercent: triggeringUsage.percent
      }
    });

    let handoffContent: string | undefined;
    let completed = false;

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
        try {
          await withTimeout(this.compact(), CONTEXT_GUARD_COMPACT_TIMEOUT_MS, "context_guard_compact", {
            onTimeout: () => this.abortCompactionSafely("context_guard_compact_timeout_abort")
          });
        } catch (error) {
          const normalized = normalizeRuntimeError(error);
          if (!isAlreadyCompactedError(normalized.message)) {
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

      try {
        const resumePrompt = buildResumePrompt(handoffContent);
        await this.session.prompt(resumePrompt);
      } catch (error) {
        await this.reportContextGuardError(error, { stage: "resume_prompt_failed" });
      }

      completed = true;
    } finally {
      await this.cleanupGuard(handoffFilePath);
      if (completed) {
        this.logContextGuard("completed", {
          handoffWritten: handoffContent !== undefined,
          handoffContentLength: handoffContent?.length ?? 0
        });
      }
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

  private async cleanupGuard(handoffFilePath?: string): Promise<void> {
    this.endContextRecovery(CONTEXT_RECOVERY_GRACE_MS);
    this.guardAbortController = undefined;

    if (handoffFilePath) {
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
    this.logRuntimeError("context_guard", error, details);
    await this.reportRuntimeError({
      phase: "context_guard",
      message: normalized.message,
      stack: normalized.stack,
      details
    });
  }

  private async handlePromptDispatchError(
    error: unknown,
    message: RuntimeUserMessage,
    dispatchMeta?: { attempt: number; maxAttempts: number }
  ): Promise<void> {
    const normalized = normalizeRuntimeError(error);

    // ── Credential pool failover for rate-limit / quota errors ──
    if (this.pooledCredentialId && this.credentialPoolService) {
      const rotated = await this.attemptCredentialRotation(error, normalized.message, message);
      if (rotated) return; // retry dispatched with new credential
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
  }

  /**
   * Attempt to rotate to a different pooled provider credential on rate-limit/quota errors.
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

    // Check for auth errors first — mark auth_error, no rotation
    const isAuthFailure = isLikelyCredentialPoolAuthError(errorMessage);
    if (isAuthFailure) {
      try {
        await pool.markAuthError(pooledProvider, currentCredId);
        this.logRuntimeError("prompt_dispatch", error, {
          stage: "credential_pool:auth_error",
          credentialId: currentCredId,
          provider: pooledProvider,
          failingProvider
        });
      } catch (markError) {
        this.logRuntimeError("prompt_dispatch", markError, {
          stage: "credential_pool:mark_auth_error_failed",
          credentialId: currentCredId,
          provider: pooledProvider,
          failingProvider
        });
      }
      return false;
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

    // Try to select next healthy credential
    const nextSelection = await pool.select(pooledProvider);
    if (!nextSelection) {
      const earliestExpiry = await pool.getEarliestCooldownExpiry(pooledProvider);
      const resetInfo = earliestExpiry
        ? ` Estimated reset: ${new Date(earliestExpiry).toLocaleTimeString()}.`
        : "";
      const providerLabel = getPooledProviderLabel(pooledProvider);

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

    // Build new auth data and inject into the session
    try {
      const authData = await pool.buildRuntimeAuthData(pooledProvider, nextSelection.credentialId);
      await pool.markUsed(pooledProvider, nextSelection.credentialId);
      const authStorage = this.session.modelRegistry?.authStorage;

      if (authStorage) {
        const newCredential = authData[pooledProvider];
        if (newCredential) {
          authStorage.set(pooledProvider, newCredential);
        }
      }

      this.pooledCredentialId = nextSelection.credentialId;

      this.logRuntimeError("prompt_dispatch", error, {
        stage: "credential_pool:rotated",
        fromCredentialId: currentCredId,
        toCredentialId: nextSelection.credentialId,
        provider: pooledProvider,
        failingProvider
      });

      const providerLabel = getPooledProviderLabel(pooledProvider);

      await this.reportRuntimeError({
        phase: "prompt_dispatch",
        message: `${providerLabel} rate limit hit — rotating to another account and retrying.`,
        details: {
          stage: "credential_pool:rotating",
          fromCredentialId: currentCredId,
          toCredentialId: nextSelection.credentialId,
          provider: pooledProvider,
          failingProvider
        }
      });

      // Retry after the current dispatch promise unwinds so promptDispatchPending stays accurate.
      setTimeout(() => {
        if (this.status !== "terminated") {
          this.dispatchPrompt(message);
        }
      }, 0);
      return true;
    } catch (rotationError) {
      this.logRuntimeError("prompt_dispatch", rotationError, {
        stage: "credential_pool:rotation_failed",
        fromCredentialId: currentCredId,
        toCredentialId: nextSelection.credentialId,
        provider: pooledProvider,
        failingProvider
      });
      return false;
    }
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
      await this.reportRuntimeError({
        phase: "compaction",
        message: "Context automatically compacted",
        details: {
          recoveryStage: "auto_compaction_succeeded",
          compactionReason
        }
      });
      this.latestAutoCompactionReason = undefined;
      this.endAutoCompactionRecovery();
      await this.flushRecoveryBufferedMessages();
      return;
    }

    if (this.isContextRecoveryActive()) {
      this.logRuntimeError("compaction", new Error(autoCompactionError), {
        recoveryStage: "auto_compaction_skipped",
        reason: this.contextRecoveryInProgress ? "recovery_already_in_progress" : "recovery_grace_period"
      });
      this.latestAutoCompactionReason = undefined;
      this.endAutoCompactionRecovery();
      return;
    }

    this.beginAutoCompactionRecovery();

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
          recoveryStage: "auto_compaction_failed"
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
    } finally {
      this.endAutoCompactionRecovery();
      await this.flushRecoveryBufferedMessages();
    }
  }

  private async retryCompactionOnceAfterAutoFailure(
    autoCompactionError: string,
    details: Record<string, unknown>
  ): Promise<{ recovered: boolean; errorMessage?: string }> {
    try {
      await withTimeout(this.compact(), CONTEXT_GUARD_COMPACT_TIMEOUT_MS, "reactive_compaction_retry", {
        onTimeout: () => this.abortCompactionSafely("reactive_compaction_retry_timeout_abort")
      });
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

    const messages = this.session.state.messages;
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "assistant" && lastMessage.stopReason === "error") {
      this.replaceSessionAgentMessages(messages.slice(0, -1));
    }
  }

  private replaceSessionAgentMessages(messages: unknown[]): void {
    (this.session.state as { messages: unknown[] }).messages = messages;
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

  private refreshContextUsage(): AgentContextUsage | undefined {
    this.lastContextUsage = normalizeAgentContextUsage(this.session.getContextUsage?.());
    return this.lastContextUsage;
  }

  private pruneFailedTurnForReplay(replayMessages: RuntimeUserMessage[]): void {
    const state = this.session.state as { messages?: unknown[] } | undefined;
    const stateMessages = Array.isArray(state?.messages) ? [...state.messages] : [];
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

function isAssistantErrorLike(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (candidate.role !== "assistant") {
    return false;
  }

  return candidate.stopReason === "error" || typeof candidate.errorMessage === "string";
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

function normalizeRuntimeSessionEvent(event: AgentSessionEvent): RuntimeSessionEvent | null {
  switch (event.type) {
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

    default:
      return event as RuntimeSessionEvent;
  }
}
