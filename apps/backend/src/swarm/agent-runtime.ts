import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import {
  buildRuntimeMessageKey,
  consumePendingDeliveryByMessageKey,
  extractMessageKeyFromRuntimeContent,
  normalizeRuntimeError,
  normalizeRuntimeUserMessage,
  previewForLog
} from "./runtime-utils.js";
import { transitionAgentStatus } from "./agent-state-machine.js";
import type {
  RuntimeImageAttachment,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
  SwarmAgentRuntime,
  SwarmRuntimeCallbacks
} from "./runtime-types.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt
} from "./types.js";

interface PendingDelivery {
  deliveryId: string;
  messageKey: string;
  mode: "steer";
}

const MAX_PROMPT_DISPATCH_ATTEMPTS = 2;
const STREAMING_STATUS_EMIT_THROTTLE_MS = 1_000;

export type { RuntimeImageAttachment, RuntimeUserMessage, RuntimeUserMessageInput } from "./runtime-types.js";

export class AgentRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;

  private readonly session: AgentSession;
  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly now: () => string;
  private pendingDeliveries: PendingDelivery[] = [];
  private status: AgentStatus;
  private unsubscribe: (() => void) | undefined;
  private readonly inFlightPrompts = new Set<Promise<void>>();
  private promptDispatchPending = false;
  private ignoreNextAgentStart = false;
  private lastStreamingStatusEmitAtMs = 0;

  constructor(options: {
    descriptor: AgentDescriptor;
    session: AgentSession;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
  }) {
    this.descriptor = options.descriptor;
    this.session = options.session;
    this.callbacks = options.callbacks;
    this.now = options.now ?? (() => new Date().toISOString());
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
    return normalizeAgentContextUsage(this.session.getContextUsage?.());
  }

  isStreaming(): boolean {
    return this.session.isStreaming;
  }

  async sendMessage(
    input: RuntimeUserMessageInput,
    _requestedMode: RequestedDeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    this.ensureNotTerminated();

    const deliveryId = randomUUID();
    const message = normalizeRuntimeUserMessage(input);

    if (this.session.isStreaming || this.promptDispatchPending) {
      const resolvedQueueMode = "steer";
      await this.enqueueMessage(deliveryId, message);
      await this.emitStatus();
      return {
        targetAgentId: this.descriptor.agentId,
        deliveryId,
        acceptedMode: resolvedQueueMode
      };
    }

    this.dispatchPrompt(message);

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId,
      acceptedMode: "prompt"
    };
  }

  async terminate(options?: { abort?: boolean }): Promise<void> {
    if (this.status === "terminated") return;

    const shouldAbort = options?.abort ?? true;
    if (shouldAbort) {
      await this.session.abort();
    }

    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session.dispose();
    this.pendingDeliveries = [];
    this.promptDispatchPending = false;
    this.ignoreNextAgentStart = false;
    this.inFlightPrompts.clear();
    this.status = transitionAgentStatus(this.status, "terminated");
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();
    await this.emitStatus();
  }

  async stopInFlight(options?: { abort?: boolean }): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    const shouldAbort = options?.abort ?? true;
    if (shouldAbort) {
      await this.session.abort();
    }

    this.pendingDeliveries = [];
    this.promptDispatchPending = false;
    this.ignoreNextAgentStart = false;
    this.inFlightPrompts.clear();

    await this.updateStatus("idle");
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.ensureNotTerminated();
    try {
      return await this.session.compact(customInstructions);
    } catch (error) {
      this.logRuntimeError("compaction", error, {
        customInstructionsPreview: previewForLog(customInstructions ?? "")
      });
      throw error;
    }
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

  appendCustomEntry(customType: string, data?: unknown): void {
    this.session.sessionManager.appendCustomEntry(customType, data);
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
      mode: "steer"
    });
  }

  private async handleEvent(event: AgentSessionEvent): Promise<void> {
    if (this.callbacks.onSessionEvent) {
      await this.callbacks.onSessionEvent(this.descriptor.agentId, event as unknown as RuntimeSessionEvent);
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
      if (this.status !== "terminated") {
        await this.updateStatus("idle");
      }
      if (this.callbacks.onAgentEnd) {
        await this.callbacks.onAgentEnd(this.descriptor.agentId);
      }
      return;
    }

    if (event.type === "message_update" && event.message.role !== "user") {
      await this.emitStreamingStatusUpdateThrottled();
      return;
    }

    if (event.type === "message_start" && event.message.role === "user") {
      const key = extractMessageKeyFromRuntimeContent(event.message.content);
      if (key !== undefined) {
        this.consumePendingMessage(key);
        await this.emitStatus();
      }
    }
  }

  private async handlePromptDispatchError(
    error: unknown,
    message: RuntimeUserMessage,
    dispatchMeta?: { attempt: number; maxAttempts: number }
  ): Promise<void> {
    const normalized = normalizeRuntimeError(error);
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

  private consumePendingMessage(messageKey: string): void {
    consumePendingDeliveryByMessageKey(this.pendingDeliveries, messageKey);
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
    await this.emitStatus();
  }

  private async emitStatus(): Promise<void> {
    await this.callbacks.onStatusChange(
      this.descriptor.agentId,
      this.status,
      this.pendingDeliveries.length,
      this.getContextUsage()
    );
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

function toImageContent(images: RuntimeImageAttachment[] | undefined): ImageContent[] {
  if (!images || images.length === 0) {
    return [];
  }

  return images.map((image) => ({
    type: "image",
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
