import type {
  GenerationBoundarySource,
  GenerationMeasurementQuality,
  GenerationMeasurementRecordV1,
  GenerationReasoningBoundaryCoverage,
  GenerationThroughputEvent,
  GenerationThroughputLiveMeasurement,
  GenerationThroughputSessionSummary,
  GenerationThroughputSnapshotEvent,
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

const LIVE_PROGRESS_INTERVAL_MS = 500;
const LIVE_RATE_MIN_ELAPSED_MS = 500;
const LIVE_RATE_MIN_ESTIMATED_TOKENS = 8;
const LIVE_RATE_WINDOW_MS = 3_000;
const LIVE_RATE_EWMA_ALPHA = 0.35;
const MAX_LIVE_RATE_SAMPLES = 128;
const SESSION_SAMPLE_LIMIT = 20;

interface ActiveGenerationMeasurement {
  runtimeToken: number;
  measurementId: string;
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
  sequence: number;
  lastProgressEmittedMonotonicTimeMs: number | undefined;
  emittedGenerating: boolean;
  liveRateSamples: EstimatedRateSample[];
  smoothedInstantaneousTokensPerSecond: number | undefined;
}

interface Timestamp {
  wallTimeMs: number;
  monotonicTimeMs: number;
}

interface EstimatedRateSample {
  monotonicTimeMs: number;
  estimatedOutputTokens: number;
}

interface TerminalSessionSample {
  measurementId: string;
  completedAt: string;
  role: "manager" | "worker";
  outputTokens: number | null;
  generationDurationMs: number | null;
  measured: boolean;
}

export interface GenerationMeasurementCoordinatorOptions {
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  getRuntime(agentId: string): SwarmAgentRuntime | undefined;
  getActiveTurnId?(agentId: string, runtimeToken: number): string | undefined;
  /** Ephemeral, count-only Builder delivery. It never enters conversation projection. */
  emitLiveEvent?(event: GenerationThroughputEvent): void;
  /** Reads manager and worker JSONL records for restart-correct bootstrap summaries. */
  loadTerminalRecords?(sessionAgentId: string): Promise<readonly GenerationMeasurementRecordV1[]>;
  /** Called only after appendCustomEntry accepted a terminal record. */
  onTerminalRecordPersisted?(record: GenerationMeasurementRecordV1): void;
  logDebug?(message: string, details?: Record<string, unknown>): void;
}

/**
 * Records compact started/terminal lifecycle entries independently from
 * conversation projection, and projects a bounded count-only live view for
 * the owning Builder session. The controller invokes this only after its
 * runtime-token gate accepts the callback.
 */
export class GenerationMeasurementCoordinator {
  private readonly activeByKey = new Map<string, ActiveGenerationMeasurement>();
  private readonly activeKeyByAgentId = new Map<string, string>();
  private readonly terminalSamplesBySessionId = new Map<string, TerminalSessionSample[]>();
  private readonly terminalSampleHydrationsBySessionId = new Map<string, Promise<void>>();
  private readonly hydratedTerminalSampleSessionIds = new Set<string>();

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
        this.recordLiveRateSample(active, timestamp);
        this.emitProgressIfDue(active, timestamp);
        return;
      }
      case "completed":
        await this.completeMeasurement(key, agentId, event);
        break;
    }
  }

  /** Bootstrap contains only current active measurements plus the durable bounded session ring. */
  async getSnapshot(sessionAgentId: string): Promise<GenerationThroughputSnapshotEvent> {
    const normalizedSessionAgentId = sessionAgentId.trim();
    await this.ensureTerminalSamplesHydrated(normalizedSessionAgentId);
    const measurements = [...this.activeByKey.values()]
      .filter((active) => active.descriptor.sessionId === normalizedSessionAgentId)
      .map((active) => this.buildLiveMeasurement(
        active,
        "generating",
        active.lastOutput ?? active.firstOutput ?? {
          wallTimeMs: active.startedWallTimeMs,
          monotonicTimeMs: active.startedMonotonicTimeMs,
        },
      ));

    return {
      type: "generation_throughput_snapshot",
      sessionAgentId: normalizedSessionAgentId,
      measurements,
      sessionSummary: this.buildSessionSummary(normalizedSessionAgentId),
    };
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

    const previousKey = this.activeKeyByAgentId.get(agentId);
    if (previousKey && previousKey !== key) {
      const previous = this.activeByKey.get(previousKey);
      if (previous) {
        const timestamp = timestampFromEvent(event);
        previous.sequence += 1;
        this.emitLive({
          type: "generation_throughput",
          measurement: this.buildLiveMeasurement(previous, "aborted", timestamp),
        });
        this.activeByKey.delete(previousKey);
      }
    }

    const startedAt = timestampFromEvent(event);
    const active: ActiveGenerationMeasurement = {
      runtimeToken,
      measurementId: event.measurementId,
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
      sequence: 1,
      lastProgressEmittedMonotonicTimeMs: undefined,
      emittedGenerating: false,
      liveRateSamples: [],
      smoothedInstantaneousTokensPerSecond: undefined,
    };
    this.activeByKey.set(key, active);
    this.activeKeyByAgentId.set(agentId, key);

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
    this.emitLive({
      type: "generation_throughput",
      measurement: this.buildLiveMeasurement(active, "starting", startedAt),
    });
  }

  private async completeMeasurement(
    key: string,
    agentId: string,
    event: Extract<RuntimeGenerationEvent, { phase: "completed" }>,
  ): Promise<void> {
    const active = this.activeByKey.get(key);
    if (!active) return;
    this.activeByKey.delete(key);
    if (this.activeKeyByAgentId.get(agentId) === key) {
      this.activeKeyByAgentId.delete(agentId);
    }

    const completed = timestampFromEvent(event);
    const outputTokens = nonNegativeFinite(event.meta?.usage?.output);
    const reasoningTokens = nonNegativeFinite(event.meta?.usage?.reasoning);
    const tokenSource = outputTokens === undefined ? "unavailable" : "provider_final";
    const boundarySource = deriveBoundarySource(active, completed);
    const generationDurationMs = active.firstOutput
      ? duration(active.firstOutput.monotonicTimeMs, completed.monotonicTimeMs)
      : null;
    const reasoningBoundaryCoverage = deriveReasoningBoundaryCoverage(
      reasoningTokens,
      active.observedThinkingDelta,
    );
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
        generationDurationMs,
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
      reasoningBoundaryCoverage,
      ...(active.estimatedOutputUtf16CodeUnits > 0
        ? {
            estimator: {
              method: "characters_div_4_v1" as const,
              estimatedOutputTokens: Math.ceil(active.estimatedOutputUtf16CodeUnits / 4),
            },
          }
        : {}),
    };
    const persisted = this.appendRecord(agentId, event.measurementId, "terminal", record);
    if (persisted) {
      try {
        this.options.onTerminalRecordPersisted?.(record);
      } catch (error) {
        this.options.logDebug?.("generation_measurement:terminal_persisted_hook:error", {
          measurementId: event.measurementId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    active.sequence += 1;
    const phase = event.outcome === "aborted" || event.outcome === "error" ? "aborted" : "completed";
    const sessionSummary = this.recordTerminalSessionSample(active, record);
    this.emitLive({
      type: "generation_throughput",
      measurement: this.buildLiveMeasurement(active, phase, completed, record),
      ...(sessionSummary ? { sessionSummary } : {}),
    });
  }

  private recordLiveRateSample(active: ActiveGenerationMeasurement, timestamp: Timestamp): void {
    const estimatedOutputTokens = estimatedTokens(active);
    active.liveRateSamples.push({
      monotonicTimeMs: timestamp.monotonicTimeMs,
      estimatedOutputTokens,
    });
    while (
      active.liveRateSamples.length > MAX_LIVE_RATE_SAMPLES
      || (active.liveRateSamples.length > 1
        && active.liveRateSamples[1]!.monotonicTimeMs < timestamp.monotonicTimeMs - LIVE_RATE_WINDOW_MS)
    ) {
      active.liveRateSamples.shift();
    }
  }

  private emitProgressIfDue(active: ActiveGenerationMeasurement, timestamp: Timestamp): void {
    const previous = active.lastProgressEmittedMonotonicTimeMs;
    if (active.emittedGenerating && previous !== undefined && timestamp.monotonicTimeMs - previous < LIVE_PROGRESS_INTERVAL_MS) {
      return;
    }

    active.sequence += 1;
    active.lastProgressEmittedMonotonicTimeMs = timestamp.monotonicTimeMs;
    active.emittedGenerating = true;
    this.emitLive({
      type: "generation_throughput",
      measurement: this.buildLiveMeasurement(active, "generating", timestamp),
    });
  }

  private buildLiveMeasurement(
    active: ActiveGenerationMeasurement,
    phase: GenerationThroughputLiveMeasurement["phase"],
    timestamp: Timestamp,
    terminalRecord?: GenerationMeasurementRecordV1,
  ): GenerationThroughputLiveMeasurement {
    const terminal = terminalRecord?.recordState === "terminal" ? terminalRecord : undefined;
    const estimatedOutputTokens = estimatedTokens(active);
    const elapsedGenerationMs = active.firstOutput
      ? duration(active.firstOutput.monotonicTimeMs, timestamp.monotonicTimeMs)
      : null;
    const finalOutputTokens = terminal?.usage.outputTokens ?? null;
    const finalDuration = terminal?.timing.generationDurationMs ?? null;
    const exactTokensPerSecond = finalOutputTokens !== null && finalDuration !== null && finalDuration > 0
      ? finalOutputTokens * 1_000 / finalDuration
      : null;
    const estimatedRate = phase === "generating"
      ? this.estimateLiveRates(active, timestamp, elapsedGenerationMs)
      : null;
    const valueKind = terminal
      ? terminal.usage.tokenSource === "provider_final" ? "provider_final" : "unavailable"
      : phase === "starting" || !active.firstOutput ? "unavailable" : "estimated";

    return {
      measurementId: active.measurementId,
      sequence: active.sequence,
      phase,
      profileId: active.descriptor.profileId,
      sessionId: active.descriptor.sessionId,
      agentId: active.descriptor.agentId,
      managerId: active.descriptor.managerId,
      role: active.descriptor.role,
      provider: terminal?.model.provider ?? active.model.provider,
      modelId: terminal?.model.responseModelId ?? terminal?.model.requestedModelId ?? active.model.requestedModelId,
      sampledAt: isoAt(timestamp.wallTimeMs),
      firstOutputAt: active.firstOutput ? isoAt(active.firstOutput.wallTimeMs) : null,
      elapsedGenerationMs: terminal ? finalDuration : elapsedGenerationMs,
      outputTokens: terminal ? finalOutputTokens : phase === "starting" ? null : estimatedOutputTokens,
      instantaneousTokensPerSecond: phase === "generating" ? estimatedRate?.instantaneous ?? null : null,
      generationAverageTokensPerSecond: terminal ? exactTokensPerSecond : estimatedRate?.average ?? null,
      valueKind,
      quality: terminal
        ? qualityFromTerminal(terminal)
        : activeQuality(active),
    };
  }

  private estimateLiveRates(
    active: ActiveGenerationMeasurement,
    timestamp: Timestamp,
    elapsedGenerationMs: number | null,
  ): { instantaneous: number; average: number } | null {
    const outputTokens = estimatedTokens(active);
    if (
      elapsedGenerationMs === null
      || elapsedGenerationMs < LIVE_RATE_MIN_ELAPSED_MS
      || outputTokens < LIVE_RATE_MIN_ESTIMATED_TOKENS
    ) {
      return null;
    }

    const windowStart = timestamp.monotonicTimeMs - LIVE_RATE_WINDOW_MS;
    const reference = active.liveRateSamples.find((sample) => sample.monotonicTimeMs >= windowStart)
      ?? active.liveRateSamples[0];
    if (!reference) return null;
    const windowMs = timestamp.monotonicTimeMs - reference.monotonicTimeMs;
    if (windowMs <= 0) return null;
    const rawInstantaneous = Math.max(0, outputTokens - reference.estimatedOutputTokens) * 1_000 / windowMs;
    active.smoothedInstantaneousTokensPerSecond = active.smoothedInstantaneousTokensPerSecond === undefined
      ? rawInstantaneous
      : LIVE_RATE_EWMA_ALPHA * rawInstantaneous
        + (1 - LIVE_RATE_EWMA_ALPHA) * active.smoothedInstantaneousTokensPerSecond;

    return {
      instantaneous: active.smoothedInstantaneousTokensPerSecond,
      average: outputTokens * 1_000 / elapsedGenerationMs,
    };
  }

  private recordTerminalSessionSample(
    active: ActiveGenerationMeasurement,
    record: GenerationMeasurementRecordV1,
  ): GenerationThroughputSessionSummary {
    this.mergeTerminalSamples(active.descriptor.sessionId, [toTerminalSessionSample(record)]);
    return this.buildSessionSummary(active.descriptor.sessionId);
  }

  private async ensureTerminalSamplesHydrated(sessionAgentId: string): Promise<void> {
    if (this.hydratedTerminalSampleSessionIds.has(sessionAgentId)) return;
    const existing = this.terminalSampleHydrationsBySessionId.get(sessionAgentId);
    if (existing) return existing;

    const hydration = Promise.resolve(this.options.loadTerminalRecords?.(sessionAgentId) ?? [])
      .then((records) => {
        this.mergeTerminalSamples(
          sessionAgentId,
          records.filter((record) => record.recordState === "terminal" && record.identity.sessionId === sessionAgentId)
            .map(toTerminalSessionSample),
        );
        this.hydratedTerminalSampleSessionIds.add(sessionAgentId);
      })
      .catch((error) => {
        this.options.logDebug?.("generation_measurement:terminal_history:error", {
          sessionAgentId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.terminalSampleHydrationsBySessionId.delete(sessionAgentId);
      });
    this.terminalSampleHydrationsBySessionId.set(sessionAgentId, hydration);
    return hydration;
  }

  private mergeTerminalSamples(sessionAgentId: string, additions: readonly TerminalSessionSample[]): void {
    const byMeasurementId = new Map(
      (this.terminalSamplesBySessionId.get(sessionAgentId) ?? []).map((sample) => [sample.measurementId, sample]),
    );
    for (const sample of additions) byMeasurementId.set(sample.measurementId, sample);
    const samples = [...byMeasurementId.values()]
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt)
        || left.measurementId.localeCompare(right.measurementId))
      .slice(-SESSION_SAMPLE_LIMIT);
    this.terminalSamplesBySessionId.set(sessionAgentId, samples);
  }

  private buildSessionSummary(sessionAgentId: string): GenerationThroughputSessionSummary {
    const terminalWindow = this.terminalSamplesBySessionId.get(sessionAgentId) ?? [];
    const samples = terminalWindow.filter((sample) => sample.measured);
    const totalTokens = samples.reduce((sum, sample) => sum + sample.outputTokens!, 0);
    const totalDurationMs = samples.reduce((sum, sample) => sum + sample.generationDurationMs!, 0);
    return {
      sessionAgentId,
      window: "last_20_terminal_generations",
      measuredGenerationCount: samples.length,
      weightedTokensPerSecond: totalDurationMs > 0 ? totalTokens * 1_000 / totalDurationMs : null,
      samples: samples.map((sample) => ({
        completedAt: sample.completedAt,
        role: sample.role,
        tokensPerSecond: sample.outputTokens! * 1_000 / sample.generationDurationMs!,
      })),
    };
  }

  private emitLive(event: GenerationThroughputEvent): void {
    try {
      this.options.emitLiveEvent?.(event);
    } catch (error) {
      this.options.logDebug?.("generation_measurement:live_emit:error", {
        measurementId: event.measurement.measurementId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private appendRecord(
    agentId: string,
    measurementId: string,
    recordState: "started" | "terminal",
    record: GenerationMeasurementRecordV1,
  ): boolean {
    try {
      const runtime = this.options.getRuntime(agentId);
      if (!runtime) return false;
      runtime.appendCustomEntry(GENERATION_MEASUREMENT_ENTRY_TYPE, record);
      return true;
    } catch (error) {
      this.options.logDebug?.("generation_measurement:persist:error", {
        measurementId,
        recordState,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

function toTerminalSessionSample(record: GenerationMeasurementRecordV1): TerminalSessionSample {
  const outputTokens = record.usage.outputTokens;
  const generationDurationMs = record.timing.generationDurationMs;
  const measured = record.usage.tokenSource === "provider_final"
    && record.timing.boundarySource === "content_delta_to_stream_end"
    && outputTokens !== null
    && generationDurationMs !== null
    && generationDurationMs > 0;
  return {
    measurementId: record.measurementId,
    completedAt: record.completedAt ?? record.startedAt,
    role: record.identity.role,
    outputTokens,
    generationDurationMs,
    measured,
  };
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

function qualityFromTerminal(record: GenerationMeasurementRecordV1): GenerationMeasurementQuality {
  return {
    tokenSource: record.usage.tokenSource,
    boundarySource: record.timing.boundarySource,
    reasoningBoundaryCoverage: record.reasoningBoundaryCoverage,
  };
}

function activeQuality(active: ActiveGenerationMeasurement): GenerationMeasurementQuality {
  return {
    tokenSource: active.firstOutput ? "estimated_local" : "unavailable",
    boundarySource: active.firstOutput
      ? "content_delta_to_stream_end"
      : active.responseStreamStarted ? "response_stream_proxy" : "unavailable",
    reasoningBoundaryCoverage: active.observedThinkingDelta ? "observed" : "not_reported",
  };
}

function estimatedTokens(active: ActiveGenerationMeasurement): number {
  return Math.ceil(active.estimatedOutputUtf16CodeUnits / 4);
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
