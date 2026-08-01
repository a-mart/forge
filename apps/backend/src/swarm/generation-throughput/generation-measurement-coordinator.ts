import type {
  GenerationBoundarySource,
  GenerationMeasurementRecordV1,
  GenerationReasoningBoundaryCoverage,
} from "@forge/protocol";
import {
  GENERATION_MEASUREMENT_ENTRY_TYPE,
} from "../../utils/generation-measurement-records.js";
import type {
  RuntimeGenerationCallMeta,
  RuntimeGenerationEvent,
  SwarmAgentRuntime,
} from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";

interface ActiveGenerationMeasurement {
  runtimeToken: number;
  descriptor: GenerationMeasurementRecordV1["identity"];
  model: GenerationMeasurementRecordV1["model"];
  turnId: string | null;
  startedWallTimeMs: number;
  startedMonotonicTimeMs: number;
  responseStreamStarted: Timestamp | undefined;
  firstOutput: Timestamp | undefined;
  lastOutput: Timestamp | undefined;
  estimatedOutputUtf16CodeUnits: number;
  observedThinkingDelta: boolean;
}

interface Timestamp {
  wallTimeMs: number;
  monotonicTimeMs: number;
}

export interface GenerationMeasurementCoordinatorOptions {
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  getRuntime(agentId: string): SwarmAgentRuntime | undefined;
  getActiveTurnId?(agentId: string, runtimeToken: number): string | undefined;
  logDebug?(message: string, details?: Record<string, unknown>): void;
}

/**
 * Records compact started/terminal lifecycle entries independently from
 * conversation projection. The controller invokes this only after its
 * runtime-token gate accepts the callback.
 */
export class GenerationMeasurementCoordinator {
  private readonly activeByKey = new Map<string, ActiveGenerationMeasurement>();

  constructor(private readonly options: GenerationMeasurementCoordinatorOptions) {}

  async handleRuntimeGenerationEvent(
    runtimeToken: number,
    agentId: string,
    event: RuntimeGenerationEvent,
  ): Promise<void> {
    const key = activeKey(agentId, runtimeToken, event.measurementId);

    switch (event.phase) {
      case "request_started":
        await this.startMeasurement(key, runtimeToken, agentId, event);
        return;
      case "response_stream_started": {
        const active = this.activeByKey.get(key);
        if (active && !active.responseStreamStarted) {
          active.responseStreamStarted = timestampFromEvent(event);
        }
        return;
      }
      case "output_delta": {
        const active = this.activeByKey.get(key);
        if (!active) return;
        const timestamp = timestampFromEvent(event);
        active.firstOutput ??= timestamp;
        active.lastOutput = timestamp;
        active.estimatedOutputUtf16CodeUnits += nonNegativeFinite(event.deltaUtf16CodeUnits) ?? 0;
        active.observedThinkingDelta ||= event.deltaKind === "thinking";
        return;
      }
      case "completed":
        await this.completeMeasurement(key, agentId, event);
        break;
    }
  }

  private async startMeasurement(
    key: string,
    runtimeToken: number,
    agentId: string,
    event: Extract<RuntimeGenerationEvent, { phase: "request_started" }>,
  ): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || (descriptor.role !== "manager" && descriptor.role !== "worker")) {
      return;
    }

    const startedAt = timestampFromEvent(event);
    const active: ActiveGenerationMeasurement = {
      runtimeToken,
      descriptor: captureIdentity(descriptor),
      model: {
        provider: nonEmptyString(event.requestedProvider) ?? "unknown",
        requestedModelId: nonEmptyString(event.requestedModelId) ?? "unknown",
        responseModelId: null,
        api: null,
        reasoningLevel: nonEmptyString(event.reasoningLevel),
      },
      turnId: this.options.getActiveTurnId?.(agentId, runtimeToken) ?? null,
      startedWallTimeMs: startedAt.wallTimeMs,
      startedMonotonicTimeMs: startedAt.monotonicTimeMs,
      responseStreamStarted: undefined,
      firstOutput: undefined,
      lastOutput: undefined,
      estimatedOutputUtf16CodeUnits: 0,
      observedThinkingDelta: false,
    };
    this.activeByKey.set(key, active);

    const record: GenerationMeasurementRecordV1 = {
      version: 1,
      measurementId: event.measurementId,
      recordState: "started",
      recordSequence: 1,
      startedAt: isoAt(startedAt.wallTimeMs),
      completedAt: null,
      identity: active.descriptor,
      model: active.model,
      correlation: { turnId: active.turnId },
      timing: emptyTiming(),
      usage: {
        outputTokens: null,
        reasoningTokens: null,
        tokenSource: "unavailable",
      },
      outcome: "unknown",
      reasoningBoundaryCoverage: "not_reported",
    };
    this.appendRecord(agentId, event.measurementId, "started", record);
  }

  private async completeMeasurement(
    key: string,
    agentId: string,
    event: Extract<RuntimeGenerationEvent, { phase: "completed" }>,
  ): Promise<void> {
    const active = this.activeByKey.get(key);
    if (!active) return;
    this.activeByKey.delete(key);

    const completed = timestampFromEvent(event);
    const outputTokens = nonNegativeFinite(event.meta?.usage?.output);
    const reasoningTokens = nonNegativeFinite(event.meta?.usage?.reasoning);
    const tokenSource = outputTokens === undefined ? "unavailable" : "provider_final";
    const boundarySource = deriveBoundarySource(active, completed);
    const record: GenerationMeasurementRecordV1 = {
      version: 1,
      measurementId: event.measurementId,
      recordState: "terminal",
      recordSequence: 2,
      startedAt: isoAt(active.startedWallTimeMs),
      completedAt: isoAt(completed.wallTimeMs),
      identity: active.descriptor,
      model: completeModel(active.model, event.meta),
      correlation: { turnId: active.turnId },
      timing: {
        responseStreamStartedAt: active.responseStreamStarted
          ? isoAt(active.responseStreamStarted.wallTimeMs)
          : null,
        firstOutputAt: active.firstOutput ? isoAt(active.firstOutput.wallTimeMs) : null,
        lastOutputAt: active.lastOutput ? isoAt(active.lastOutput.wallTimeMs) : null,
        requestWallMs: duration(active.startedMonotonicTimeMs, completed.monotonicTimeMs),
        timeToFirstOutputMs: active.firstOutput
          ? duration(active.startedMonotonicTimeMs, active.firstOutput.monotonicTimeMs)
          : null,
        responseStreamOpenMs: active.responseStreamStarted
          ? duration(active.responseStreamStarted.monotonicTimeMs, completed.monotonicTimeMs)
          : null,
        generationDurationMs: active.firstOutput
          ? duration(active.firstOutput.monotonicTimeMs, completed.monotonicTimeMs)
          : null,
        interOutputSpanMs: active.firstOutput && active.lastOutput
          ? duration(active.firstOutput.monotonicTimeMs, active.lastOutput.monotonicTimeMs)
          : null,
        boundarySource,
      },
      usage: {
        outputTokens: outputTokens ?? null,
        reasoningTokens: reasoningTokens ?? null,
        tokenSource,
      },
      outcome: event.outcome,
      reasoningBoundaryCoverage: deriveReasoningBoundaryCoverage(
        reasoningTokens,
        active.observedThinkingDelta,
      ),
      ...(active.estimatedOutputUtf16CodeUnits > 0
        ? {
            estimator: {
              method: "characters_div_4_v1" as const,
              estimatedOutputTokens: Math.ceil(active.estimatedOutputUtf16CodeUnits / 4),
            },
          }
        : {}),
    };
    this.appendRecord(agentId, event.measurementId, "terminal", record);
  }

  private appendRecord(
    agentId: string,
    measurementId: string,
    recordState: "started" | "terminal",
    record: GenerationMeasurementRecordV1,
  ): void {
    try {
      this.options.getRuntime(agentId)?.appendCustomEntry(GENERATION_MEASUREMENT_ENTRY_TYPE, record);
    } catch (error) {
      this.options.logDebug?.("generation_measurement:persist:error", {
        measurementId,
        recordState,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function captureIdentity(descriptor: AgentDescriptor): GenerationMeasurementRecordV1["identity"] {
  if (descriptor.role === "manager") {
    return {
      profileId: descriptor.profileId ?? descriptor.agentId,
      sessionId: descriptor.agentId,
      agentId: descriptor.agentId,
      managerId: descriptor.agentId,
      role: "manager",
      specialistId: null,
      specialistAttributionKnown: null,
    };
  }

  return {
    profileId: descriptor.profileId ?? descriptor.managerId,
    sessionId: descriptor.managerId,
    agentId: descriptor.agentId,
    managerId: descriptor.managerId,
    role: "worker",
    specialistId: nonEmptyString(descriptor.specialistId),
    // New worker descriptors set this explicitly; an older descriptor must
    // remain unknown rather than being guessed as ad-hoc attribution.
    specialistAttributionKnown: descriptor.specialistAttributionKnown ?? null,
  };
}

function completeModel(
  initial: GenerationMeasurementRecordV1["model"],
  meta: RuntimeGenerationCallMeta | undefined,
): GenerationMeasurementRecordV1["model"] {
  return {
    provider: nonEmptyString(meta?.provider) ?? initial.provider,
    requestedModelId: initial.requestedModelId,
    responseModelId: nonEmptyString(meta?.responseModelId) ?? nonEmptyString(meta?.modelId),
    api: nonEmptyString(meta?.api),
    reasoningLevel: initial.reasoningLevel,
  };
}

function emptyTiming(): GenerationMeasurementRecordV1["timing"] {
  return {
    responseStreamStartedAt: null,
    firstOutputAt: null,
    lastOutputAt: null,
    requestWallMs: null,
    timeToFirstOutputMs: null,
    responseStreamOpenMs: null,
    generationDurationMs: null,
    interOutputSpanMs: null,
    boundarySource: "unavailable",
  };
}

function deriveBoundarySource(
  active: ActiveGenerationMeasurement,
  completed: Timestamp,
): GenerationBoundarySource {
  if (active.firstOutput && duration(active.firstOutput.monotonicTimeMs, completed.monotonicTimeMs) !== null) {
    return "content_delta_to_stream_end";
  }
  if (active.responseStreamStarted && duration(active.responseStreamStarted.monotonicTimeMs, completed.monotonicTimeMs) !== null) {
    return "response_stream_proxy";
  }
  return "unavailable";
}

function deriveReasoningBoundaryCoverage(
  reasoningTokens: number | undefined,
  observedThinkingDelta: boolean,
): GenerationReasoningBoundaryCoverage {
  if (reasoningTokens === undefined) return "not_reported";
  return reasoningTokens === 0 || observedThinkingDelta ? "observed" : "hidden_or_unobserved";
}

function activeKey(agentId: string, runtimeToken: number, measurementId: string): string {
  return `${agentId}\u0000${runtimeToken}\u0000${measurementId}`;
}

function timestampFromEvent(event: Pick<RuntimeGenerationEvent, "wallTimeMs" | "monotonicTimeMs">): Timestamp {
  return {
    wallTimeMs: event.wallTimeMs,
    monotonicTimeMs: event.monotonicTimeMs,
  };
}

function duration(start: number, end: number): number | null {
  const value = end - start;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function isoAt(wallTimeMs: number): string {
  return new Date(wallTimeMs).toISOString();
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
