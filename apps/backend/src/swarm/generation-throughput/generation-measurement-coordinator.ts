import type {
  GenerationBoundarySource,
  GenerationMeasurementAttempt,
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

const SESSION_SAMPLE_LIMIT = 20;

interface ActiveGenerationMeasurement {
  runtimeToken: number;
  measurementId: string;
  descriptor: GenerationMeasurementRecordV1["identity"];
  model: GenerationMeasurementRecordV1["model"];
  turnId: string | null;
  attempt: GenerationMeasurementAttempt;
  startedWallTimeMs: number;
  startedMonotonicTimeMs: number;
  responseStreamStarted: Timestamp | undefined;
  firstOutput: Timestamp | undefined;
  lastOutput: Timestamp | undefined;
  observedThinkingDelta: boolean;
  sequence: number;
  emittedGenerating: boolean;
}

interface Timestamp {
  wallTimeMs: number;
  monotonicTimeMs: number;
}

interface TerminalSessionSample {
  measurementId: string;
  completedAt: string;
  role: "manager" | "worker";
  outputTokens: number | null;
  /** Complete request-start → terminal duration, never the output-tail diagnostic. */
  responseDurationMs: number | null;
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
        active.observedThinkingDelta ||= event.deltaKind === "thinking";
        this.emitGeneratingOnFirstOutput(active, timestamp);
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
      attempt: {
        measurementScope: event.measurementScope,
        agentRetryAttempt: event.agentRetryAttempt,
        providerAttemptScope: event.providerAttemptScope,
        observedProviderAttemptCount: null,
      },
      startedWallTimeMs: startedAt.wallTimeMs,
      startedMonotonicTimeMs: startedAt.monotonicTimeMs,
      responseStreamStarted: undefined,
      firstOutput: undefined,
      lastOutput: undefined,
      observedThinkingDelta: false,
      sequence: 1,
      emittedGenerating: false,
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
      attempt: active.attempt,
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
    const attempt: GenerationMeasurementAttempt = {
      ...active.attempt,
      observedProviderAttemptCount: nonNegativeInteger(event.observedProviderAttemptCount) ?? null,
    };
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
      attempt,
      timing: {
        responseStreamStartedAt: active.responseStreamStarted
          ? isoAt(active.responseStreamStarted.wallTimeMs)
          : null,
        firstOutputAt: active.firstOutput ? isoAt(active.firstOutput.wallTimeMs) : null,
        lastOutputAt: active.lastOutput ? isoAt(active.lastOutput.wallTimeMs) : null,
        requestWallMs: duration(active.startedMonotonicTimeMs, completed.monotonicTimeMs),
        responseThroughputDurationBasis: "request_wall_monotonic",
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

  /**
   * One active transition is enough for the UI's restrained activity pulse.
   * Do not derive tokens or rates from streamed text: only provider-final
   * usage can produce a numeric throughput value.
   */
  private emitGeneratingOnFirstOutput(active: ActiveGenerationMeasurement, timestamp: Timestamp): void {
    if (active.emittedGenerating) return;

    active.sequence += 1;
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
    const generationTailDurationMs = active.firstOutput
      ? duration(active.firstOutput.monotonicTimeMs, timestamp.monotonicTimeMs)
      : null;
    const finalOutputTokens = terminal?.usage.outputTokens ?? null;
    const responseDurationMs = terminal?.timing.requestWallMs
      ?? duration(active.startedMonotonicTimeMs, timestamp.monotonicTimeMs);
    const exactTokensPerSecond = finalOutputTokens !== null && responseDurationMs !== null && responseDurationMs > 0
      ? finalOutputTokens * 1_000 / responseDurationMs
      : null;
    const valueKind = terminal?.usage.tokenSource === "provider_final"
      ? "provider_final"
      : "unavailable";

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
      requestStartedAt: isoAt(active.startedWallTimeMs),
      completedAt: terminal?.completedAt ?? null,
      firstOutputAt: active.firstOutput ? isoAt(active.firstOutput.wallTimeMs) : null,
      lastOutputAt: active.lastOutput ? isoAt(active.lastOutput.wallTimeMs) : null,
      timeToFirstOutputMs: active.firstOutput
        ? duration(active.startedMonotonicTimeMs, active.firstOutput.monotonicTimeMs)
        : null,
      responseDurationMs,
      responseThroughputDurationBasis: "request_wall_monotonic",
      outputSpanMs: terminal?.timing.interOutputSpanMs
        ?? (active.firstOutput && active.lastOutput
          ? duration(active.firstOutput.monotonicTimeMs, active.lastOutput.monotonicTimeMs)
          : null),
      generationTailDurationMs: terminal?.timing.generationDurationMs ?? generationTailDurationMs,
      elapsedGenerationMs: terminal?.timing.generationDurationMs ?? generationTailDurationMs,
      outputTokens: terminal ? finalOutputTokens : null,
      instantaneousTokensPerSecond: null,
      responseThroughputTokensPerSecond: terminal ? exactTokensPerSecond : null,
      // Preserve the historical key for older UIs, but never derive it from
      // first-output timing again.
      generationAverageTokensPerSecond: terminal ? exactTokensPerSecond : null,
      valueKind,
      quality: terminal
        ? qualityFromTerminal(terminal)
        : activeQuality(active),
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
    const totalDurationMs = samples.reduce((sum, sample) => sum + sample.responseDurationMs!, 0);
    const weightedResponseTokensPerSecond = totalDurationMs > 0 ? totalTokens * 1_000 / totalDurationMs : null;
    return {
      sessionAgentId,
      window: "last_20_terminal_generations",
      measuredGenerationCount: samples.length,
      weightedResponseTokensPerSecond,
      // Compatibility alias; current value has request-wall semantics.
      weightedTokensPerSecond: weightedResponseTokensPerSecond,
      samples: samples.map((sample) => {
        const responseTokensPerSecond = sample.outputTokens! * 1_000 / sample.responseDurationMs!;
        return {
          completedAt: sample.completedAt,
          role: sample.role,
          responseTokensPerSecond,
          tokensPerSecond: responseTokensPerSecond,
        };
      }),
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
  const responseDurationMs = record.timing.requestWallMs;
  // Durable history contains only source timing and usage, not persisted TPS.
  // This deliberately re-derives legacy v1 records from request-wall timing.
  const measured = record.usage.tokenSource === "provider_final"
    && outputTokens !== null
    && responseDurationMs !== null
    && responseDurationMs > 0;
  return {
    measurementId: record.measurementId,
    completedAt: record.completedAt ?? record.startedAt,
    role: record.identity.role,
    outputTokens,
    responseDurationMs,
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
    responseThroughputDurationBasis: "request_wall_monotonic",
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
    ...attemptQuality(record.attempt),
    tokenSource: record.usage.tokenSource,
    boundarySource: record.timing.boundarySource,
    reasoningBoundaryCoverage: record.reasoningBoundaryCoverage,
  };
}

function activeQuality(active: ActiveGenerationMeasurement): GenerationMeasurementQuality {
  return {
    ...active.attempt,
    tokenSource: "unavailable",
    boundarySource: active.firstOutput
      ? "content_delta_to_stream_end"
      : active.responseStreamStarted ? "response_stream_proxy" : "unavailable",
    reasoningBoundaryCoverage: active.observedThinkingDelta ? "observed" : "not_reported",
  };
}

function attemptQuality(attempt: GenerationMeasurementAttempt | undefined): GenerationMeasurementAttempt {
  return attempt ?? {
    measurementScope: "agent_model_call",
    agentRetryAttempt: null,
    providerAttemptScope: "unavailable",
    observedProviderAttemptCount: null,
  };
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

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
