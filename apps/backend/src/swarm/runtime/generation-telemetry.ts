import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
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

export interface PiGenerationTelemetryAdapterOptions {
  session: AgentSession;
  reasoningLevel: string | null;
  onGenerationEvent?: (event: RuntimeGenerationEvent) => void | Promise<void>;
  createMeasurementId?: () => string;
  clock?: PiGenerationTelemetryClock;
}

interface ActivePiGeneration {
  measurementId: string;
  responseStreamStarted: boolean;
}

/**
 * Adapts Pi's provider hooks and assistant-message lifecycle to Forge's
 * count-only runtime generation contract. It deliberately never retains or
 * forwards a payload, response body, streamed delta, prompt, or tool args.
 */
export class PiGenerationTelemetryAdapter {
  private readonly session: AgentSession;
  private readonly reasoningLevel: string | null;
  private readonly onGenerationEvent: ((event: RuntimeGenerationEvent) => void | Promise<void>) | undefined;
  private readonly createMeasurementId: () => string;
  private readonly clock: PiGenerationTelemetryClock;
  private active: ActivePiGeneration | undefined;
  private installed = false;

  constructor(options: PiGenerationTelemetryAdapterOptions) {
    this.session = options.session;
    this.reasoningLevel = normalizeOptionalString(options.reasoningLevel);
    this.onGenerationEvent = options.onGenerationEvent;
    this.createMeasurementId = options.createMeasurementId ?? randomUUID;
    this.clock = options.clock ?? {
      wallTimeMs: () => Date.now(),
      monotonicTimeMs: () => performance.now(),
    };
  }

  /** Chains Pi's public request hooks without changing prior return/error behavior. */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    const agent = this.session.agent;
    const existingOnPayload = agent.onPayload;
    const existingOnResponse = agent.onResponse;

    agent.onPayload = async (payload, model) => {
      // Invoke existing transformations first: the generation boundary is after
      // payload transforms and immediately before Pi dispatches the request.
      const transformed = existingOnPayload
        ? await existingOnPayload.call(agent, payload, model)
        : undefined;
      await this.beginRequest(model);
      return transformed;
    };

    agent.onResponse = async (response, model) => {
      if (existingOnResponse) {
        await existingOnResponse.call(agent, response, model);
      }
      await this.markResponseStreamStarted();
    };
  }

  /** Receives raw Pi lifecycle events before Forge's conversation mapping. */
  async handleSessionEvent(event: AgentSessionEvent, modelCallMeta?: RuntimeModelCallMeta): Promise<void> {
    switch (event.type) {
      case "message_start":
        if (isAssistantMessage(event.message)) {
          await this.markResponseStreamStarted();
        }
        return;
      case "message_update": {
        if (!isAssistantMessage(event.message)) return;
        const delta = extractCountableDelta(event.assistantMessageEvent);
        if (!delta || !this.active) return;
        const timestamp = this.timestamp();
        await this.emit({
          phase: "output_delta",
          measurementId: this.active.measurementId,
          ...timestamp,
          deltaKind: delta.kind,
          deltaUtf16CodeUnits: delta.value.length,
          deltaUtf8Bytes: Buffer.byteLength(delta.value, "utf8"),
        });
        return;
      }
      case "message_end":
        if (isAssistantMessage(event.message)) {
          await this.completeActive(outcomeFromMeta(modelCallMeta), modelCallMeta);
        }
        return;
      case "agent_settled":
        // A normal assistant message ends first. This only closes an orphan
        // created by a failed/aborted attempt that did not emit message_end.
        await this.abortActive();
        break;
      default:
        break;
    }
  }

  /** Used by runtime replacement/termination paths to close an orphaned attempt. */
  async abortActive(): Promise<void> {
    await this.completeActive("aborted");
  }

  private async beginRequest(model: unknown): Promise<void> {
    // Agent-level retries re-enter onPayload without a message_end for the
    // prior failed stream. Keep attempts independent rather than merging delay.
    await this.abortActive();

    const measurementId = this.createMeasurementId();
    this.active = { measurementId, responseStreamStarted: false };
    const timestamp = this.timestamp();
    const modelRecord = readObject(model);
    await this.emit({
      phase: "request_started",
      measurementId,
      ...timestamp,
      requestedProvider: normalizeRequiredString(modelRecord?.provider, "unknown"),
      requestedModelId: normalizeRequiredString(modelRecord?.id, "unknown"),
      reasoningLevel: this.reasoningLevel,
    });
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
    await this.emit({
      phase: "completed",
      measurementId: active.measurementId,
      ...this.timestamp(),
      outcome,
      ...(generationMeta ? { meta: generationMeta } : {}),
    });
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

function extractCountableDelta(value: unknown): { kind: "text" | "thinking" | "tool_call"; value: string } | null {
  const event = readObject(value);
  const delta = typeof event?.delta === "string" ? event.delta : "";
  if (delta.length === 0) return null;

  switch (event?.type) {
    case "text_delta":
      return { kind: "text", value: delta };
    case "thinking_delta":
      return { kind: "thinking", value: delta };
    case "toolcall_delta":
      return { kind: "tool_call", value: delta };
    default:
      return null;
  }
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

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRequiredString(value: unknown, fallback: string): string {
  return normalizeOptionalString(value) ?? fallback;
}
