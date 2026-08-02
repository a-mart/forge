import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  RuntimeGenerationCallMeta,
  RuntimeGenerationEvent,
  RuntimeModelCallMeta,
} from "../runtime-contracts.js";

export interface PiGenerationTelemetryClock {
  wallTimeMs(): number;
  monotonicTimeMs(): number;
}

export interface PiFirstModelRequest {
  model: unknown;
  context: unknown;
  streamOptions: unknown;
}

export interface PiGenerationTelemetryAdapterOptions {
  session: AgentSession;
  reasoningLevel: string | null;
  onGenerationEvent?: (event: RuntimeGenerationEvent) => void | Promise<void>;
  /** Local-only, one-shot request capture. It never enters generation telemetry. */
  onFirstModelRequest?: (request: PiFirstModelRequest) => void | Promise<void>;
  createMeasurementId?: () => string;
  clock?: PiGenerationTelemetryClock;
  /** Public Pi debug probe: cumulative sent Codex WebSocket response.create frames for this session. */
  readOpenAICodexWebSocketRequestCount?: () => number | undefined;
}

interface ActivePiGeneration {
  measurementId: string;
  responseStreamStarted: boolean;
  providerAttemptScope: Extract<RuntimeGenerationEvent, { phase: "request_started" }>["providerAttemptScope"];
  providerAttemptCountAtStart: number | undefined;
}

/**
 * Adapts Pi's provider hooks and assistant-message lifecycle to Forge's
 * count-only runtime generation contract. Generation events never retain or
 * forward payloads; the optional local one-shot observer receives only the
 * initial stream inputs for session-local capture.
 */
export class PiGenerationTelemetryAdapter {
  private readonly session: AgentSession;
  private readonly reasoningLevel: string | null;
  private readonly onGenerationEvent: ((event: RuntimeGenerationEvent) => void | Promise<void>) | undefined;
  private readonly onFirstModelRequest: ((request: PiFirstModelRequest) => void | Promise<void>) | undefined;
  private readonly createMeasurementId: () => string;
  private readonly clock: PiGenerationTelemetryClock;
  private readonly readOpenAICodexWebSocketRequestCount: (() => number | undefined) | undefined;
  private active: ActivePiGeneration | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private originalStreamFn: AgentSession["agent"]["streamFn"] | undefined;
  private instrumentedStreamFn: AgentSession["agent"]["streamFn"] | undefined;
  private installed = false;
  private firstModelRequestObserved = false;

  constructor(options: PiGenerationTelemetryAdapterOptions) {
    this.session = options.session;
    this.reasoningLevel = normalizeOptionalString(options.reasoningLevel);
    this.onGenerationEvent = options.onGenerationEvent;
    this.onFirstModelRequest = options.onFirstModelRequest;
    this.createMeasurementId = options.createMeasurementId ?? randomUUID;
    this.clock = options.clock ?? {
      wallTimeMs: () => Date.now(),
      monotonicTimeMs: () => performance.now(),
    };
    this.readOpenAICodexWebSocketRequestCount = options.readOpenAICodexWebSocketRequestCount;
  }

  /**
   * Instruments Pi's public Agent.streamFn seam. One invocation is one logical
   * model-call attempt; Pi agent retries invoke it again. Provider SDK retries
   * remain inside that invocation and are never presented as per-attempt TPS.
   */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    const agent = this.session.agent;
    const existingStreamFn = agent.streamFn;
    const existingOnResponse = agent.onResponse;
    this.originalStreamFn = existingStreamFn;
    this.instrumentedStreamFn = async (model, context, options) => {
      await this.enqueue(() => this.beginRequest(model, options));
      try {
        // Start provider dispatch before the local capture can synchronously
        // project or persist request content.
        const providerStream = existingStreamFn.call(agent, model, context, options);
        this.captureFirstModelRequest(model, context, options);
        return await providerStream;
      } catch (error) {
        // A synchronous provider throw is still a first model-call attempt,
        // but capture only after dispatch has been invoked.
        this.captureFirstModelRequest(model, context, options);
        await this.enqueue(() => this.completeActive("error"));
        throw error;
      }
    };

    // Pi calls these two public Agent methods for the initial loop and every
    // continuation (including retries). Restore immediately after each loop so
    // idle compaction retains Pi's streamSimple identity/auth behavior.
    const invokeAgentPrompt = agent.prompt.bind(agent) as (...args: unknown[]) => Promise<void>;
    agent.prompt = (async (...args: unknown[]) => {
      this.attachStreamInstrumentation();
      try {
        await invokeAgentPrompt(...args);
      } finally {
        this.restoreStreamFn();
      }
    }) as typeof agent.prompt;
    const invokeAgentContinue = agent.continue.bind(agent);
    agent.continue = async () => {
      this.attachStreamInstrumentation();
      try {
        await invokeAgentContinue();
      } finally {
        this.restoreStreamFn();
      }
    };

    agent.onResponse = async (response, model) => {
      if (existingOnResponse) {
        await existingOnResponse.call(agent, response, model);
      }
      await this.enqueue(() => this.markResponseStreamStarted());
    };

    // Register directly at installation time so lifecycle events are enqueued
    // before Pi can start a continuation/retry. External runtime event queues
    // may process the same events later, but cannot reorder attribution here.
    this.session.subscribe((event) => {
      // Fallback for custom/direct Agent integrations. Normal Pi session loops
      // are covered synchronously by the wrapped Agent methods above.
      if (event.type === "agent_start") {
        this.attachStreamInstrumentation();
      } else if (event.type === "agent_end" || event.type === "agent_settled") {
        this.restoreStreamFn();
      }
      void this.handleSessionEvent(event);
    });
  }

  /** Receives raw Pi lifecycle events before Forge's conversation mapping. */
  async handleSessionEvent(event: AgentSessionEvent, modelCallMeta?: RuntimeModelCallMeta): Promise<void> {
    await this.enqueue(async () => {
      switch (event.type) {
        case "message_start":
          if (isAssistantMessage(event.message)) {
            await this.markResponseStreamStarted();
          }
          return;
        case "message_update": {
          if (!isAssistantMessage(event.message)) return;
          const delta = extractOutputDeltaKind(event.assistantMessageEvent);
          if (!delta || !this.active) return;
          const timestamp = this.timestamp();
          await this.emit({
            phase: "output_delta",
            measurementId: this.active.measurementId,
            ...timestamp,
            deltaKind: delta,
          });
          return;
        }
        case "message_end":
          if (isAssistantMessage(event.message)) {
            const effectiveMeta = modelCallMeta ?? modelCallMetaFromAssistantMessage(event.message);
            await this.completeActive(outcomeFromMeta(effectiveMeta), effectiveMeta);
          }
          return;
        case "agent_settled":
          // A normal assistant message ends first. This only closes an orphan
          // created by a failed/aborted attempt that did not emit message_end.
          await this.completeActive("aborted");
          break;
        default:
          break;
      }
    });
  }

  /** Used by runtime replacement/termination paths to close an orphaned attempt and drain queued lifecycle work. */
  async abortActive(): Promise<void> {
    await this.enqueue(() => this.completeActive("aborted"));
  }

  private attachStreamInstrumentation(): void {
    if (this.instrumentedStreamFn) {
      this.session.agent.streamFn = this.instrumentedStreamFn;
    }
  }

  private restoreStreamFn(): void {
    if (this.originalStreamFn && this.session.agent.streamFn === this.instrumentedStreamFn) {
      this.session.agent.streamFn = this.originalStreamFn;
    }
  }

  private async beginRequest(model: unknown, streamOptions: unknown): Promise<void> {
    // The stable stream contract normally emits message_end before a new call.
    // Fail closed if a custom stream violates it rather than merging lifecycles.
    await this.completeActive("aborted");

    const measurementId = this.createMeasurementId();
    const modelRecord = readObject(model);
    const streamOptionsRecord = readObject(streamOptions);
    const providerAttemptScope = this.resolveProviderAttemptScope(modelRecord, streamOptionsRecord);
    const providerAttemptCountAtStart = providerAttemptScope === "openai_codex_websocket_request"
      ? this.readCodexWebSocketRequestCount()
      : undefined;
    this.active = {
      measurementId,
      responseStreamStarted: false,
      providerAttemptScope,
      providerAttemptCountAtStart,
    };
    const timestamp = this.timestamp();
    await this.emit({
      phase: "request_started",
      measurementId,
      ...timestamp,
      requestedProvider: normalizeRequiredString(modelRecord?.provider, "unknown"),
      requestedModelId: normalizeRequiredString(modelRecord?.id, "unknown"),
      reasoningLevel: this.reasoningLevel,
      measurementScope: "agent_model_call",
      agentRetryAttempt: readNonNegativeInteger(this.session.retryAttempt) ?? 0,
      providerAttemptScope,
    });
  }

  private captureFirstModelRequest(model: unknown, context: unknown, streamOptions: unknown): void {
    if (this.firstModelRequestObserved) return;
    this.firstModelRequestObserved = true;

    try {
      void Promise.resolve(this.onFirstModelRequest?.({ model, context, streamOptions })).catch(() => {
        // A local viewer capture must never interfere with model dispatch.
      });
    } catch {
      // A synchronous callback failure must not interfere with model dispatch.
    }
  }

  private async markResponseStreamStarted(): Promise<void> {
    if (!this.active || this.active.responseStreamStarted) return;
    this.active.responseStreamStarted = true;
    await this.emit({
      phase: "response_stream_started",
      measurementId: this.active.measurementId,
      ...this.timestamp(),
    });
  }

  private async completeActive(
    outcome: Extract<RuntimeGenerationEvent, { phase: "completed" }>["outcome"],
    meta?: RuntimeModelCallMeta,
  ): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    const generationMeta = toGenerationMeta(meta);
    const observedProviderAttemptCount = active.providerAttemptScope === "openai_codex_websocket_request"
      ? observedCountDelta(active.providerAttemptCountAtStart, this.readCodexWebSocketRequestCount())
      : null;
    await this.emit({
      phase: "completed",
      measurementId: active.measurementId,
      ...this.timestamp(),
      outcome,
      observedProviderAttemptCount,
      ...(generationMeta ? { meta: generationMeta } : {}),
    });
  }

  private resolveProviderAttemptScope(
    model: Record<string, unknown> | undefined,
    streamOptions: Record<string, unknown> | undefined,
  ): ActivePiGeneration["providerAttemptScope"] {
    const provider = normalizeOptionalString(model?.provider)?.toLowerCase();
    const api = normalizeOptionalString(model?.api)?.toLowerCase();
    const transport = normalizeOptionalString(streamOptions?.transport)?.toLowerCase();
    const mayUseWebSocket = transport === "websocket"
      || transport === "websocket-cached"
      || transport === "auto";
    return this.readOpenAICodexWebSocketRequestCount
      && (provider === "openai-codex" || api === "openai-codex-responses")
      && mayUseWebSocket
      ? "openai_codex_websocket_request"
      : "unavailable";
  }

  private readCodexWebSocketRequestCount(): number | undefined {
    try {
      return readNonNegativeInteger(this.readOpenAICodexWebSocketRequestCount?.());
    } catch {
      return undefined;
    }
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const next = this.operationQueue.then(operation);
    this.operationQueue = next.catch(() => undefined);
    return next;
  }

  private timestamp(): Pick<RuntimeGenerationEvent, "wallTimeMs" | "monotonicTimeMs"> {
    return {
      wallTimeMs: this.clock.wallTimeMs(),
      monotonicTimeMs: this.clock.monotonicTimeMs(),
    };
  }

  private async emit(event: RuntimeGenerationEvent): Promise<void> {
    try {
      await this.onGenerationEvent?.(event);
    } catch {
      // Telemetry is best-effort and must never alter a provider request or the
      // existing hook's errors/return value. Do not log raw event inputs here.
    }
  }
}

function extractOutputDeltaKind(value: unknown): "text" | "thinking" | "tool_call" | null {
  const event = readObject(value);
  const delta = typeof event?.delta === "string" ? event.delta : "";
  if (delta.length === 0) return null;

  switch (event?.type) {
    case "text_delta":
      return "text";
    case "thinking_delta":
      return "thinking";
    case "toolcall_delta":
      return "tool_call";
    default:
      return null;
  }
}

function modelCallMetaFromAssistantMessage(value: unknown): RuntimeModelCallMeta | undefined {
  const message = readObject(value);
  if (!message || message.role !== "assistant") return undefined;
  const usageRecord = readObject(message.usage);
  const usage = usageRecord
    ? Object.fromEntries(
        Object.entries(usageRecord).filter(([, entry]) => typeof entry === "number" && Number.isFinite(entry)),
      ) as RuntimeModelCallMeta["usage"]
    : undefined;
  return {
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
    provider: normalizeOptionalString(message.provider) ?? undefined,
    api: normalizeOptionalString(message.api) ?? undefined,
    modelId: normalizeOptionalString(message.model) ?? undefined,
    responseModelId: normalizeOptionalString(message.responseModel) ?? undefined,
    stopReason: normalizeOptionalString(message.stopReason) ?? undefined,
  };
}

function toGenerationMeta(meta: RuntimeModelCallMeta | undefined): RuntimeGenerationCallMeta | undefined {
  if (!meta) return undefined;
  const usage = meta.usage
    ? Object.fromEntries(
        Object.entries(meta.usage).filter(([, value]) => typeof value === "number"),
      ) as RuntimeGenerationCallMeta["usage"]
    : undefined;
  const result: RuntimeGenerationCallMeta = {
    ...(usage ? { usage } : {}),
    ...(normalizeOptionalString(meta.modelId) ? { modelId: meta.modelId!.trim() } : {}),
    ...(normalizeOptionalString(meta.responseModelId) ? { responseModelId: meta.responseModelId!.trim() } : {}),
    ...(normalizeOptionalString(meta.provider) ? { provider: meta.provider!.trim() } : {}),
    ...(normalizeOptionalString(meta.api) ? { api: meta.api!.trim() } : {}),
    ...(normalizeOptionalString(meta.stopReason) ? { stopReason: meta.stopReason!.trim() } : {}),
    ...(typeof meta.durationMs === "number" && Number.isFinite(meta.durationMs)
      ? { durationMs: meta.durationMs }
      : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function outcomeFromMeta(meta: RuntimeModelCallMeta | undefined): Extract<RuntimeGenerationEvent, { phase: "completed" }>["outcome"] {
  switch (meta?.stopReason?.trim().toLowerCase()) {
    case "stop":
    case "completed":
    case "end_turn":
      return "completed";
    case "length":
    case "max_tokens":
      return "length";
    case "tool_use":
    case "tooluse":
    case "tool_calls":
      return "tool_use";
    case "aborted":
    case "cancelled":
    case "canceled":
      return "aborted";
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

function isAssistantMessage(value: unknown): boolean {
  return readObject(value)?.role === "assistant";
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function observedCountDelta(start: number | undefined, end: number | undefined): number | null {
  if (end === undefined) return null;
  const baseline = start ?? 0;
  return end >= baseline ? end - baseline : null;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRequiredString(value: unknown, fallback: string): string {
  return normalizeOptionalString(value) ?? fallback;
}
