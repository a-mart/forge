import type {
  FeedbackSubmitEvent,
  PhoenixObservabilityCounters,
  PhoenixObservabilitySettings,
  PhoenixObservabilitySettingsPatch,
  PhoenixObservabilityStatus,
  PhoenixObservabilityTestResponse,
} from "@forge/protocol";
import { isBuilderRuntimeTarget } from "../runtime-target.js";
import { PhoenixOtlpExporter } from "./phoenix-otlp-exporter.js";
import { ObservabilityCorrelator } from "./observability-correlator.js";
import {
  PhoenixObservabilitySettingsService,
  normalizePhoenixObservabilitySettings,
  sanitizePhoenixProjectName,
  validatePhoenixEndpoint,
} from "./observability-settings.js";
import type {
  ObservabilityFacade,
  ObservabilityPromptResolvedInput,
  ObservabilityRuntimeCreatedInput,
  ObservabilityRuntimeInputCompletion,
  ObservabilityRuntimeInputHandle,
  ObservabilityRuntimeInputInput,
  ObservabilityRuntimeSessionEventInput,
  ObservabilityRuntimeTarget,
  ObservabilityToolSideEffectInput,
  ObservabilityAgentDeliveryInput,
} from "./observability-types.js";

export interface ObservabilityServiceOptions {
  dataDir: string;
  runtimeTarget: ObservabilityRuntimeTarget;
  version?: string;
  exporterFactory?: (settings: PhoenixObservabilitySettings) => PhoenixOtlpExporter;
}

export class ObservabilityService implements ObservabilityFacade {
  private readonly settingsService: PhoenixObservabilitySettingsService;
  private readonly correlator = new ObservabilityCorrelator();
  private exporter: PhoenixOtlpExporter | null = null;
  private settings: PhoenixObservabilitySettings | null = null;
  private lastErrorAt: string | null = null;
  private lastErrorMessage: string | null = null;

  constructor(private readonly options: ObservabilityServiceOptions) {
    this.settingsService = new PhoenixObservabilitySettingsService(options.dataDir);
  }

  async initialize(): Promise<void> {
    if (!this.isBuilderRuntime()) {
      this.settings = this.getDefaultStatusSettings();
      return;
    }

    try {
      this.settings = await this.settingsService.load();
      await this.configureExporter(this.settings, { throwOnFailure: false });
    } catch (error) {
      this.recordError(error);
    }
  }

  async getSettings(): Promise<PhoenixObservabilitySettings> {
    if (!this.isBuilderRuntime()) {
      return cloneSettings(this.getDefaultStatusSettings());
    }

    if (!this.settings) {
      this.settings = await this.settingsService.getSettings();
    }

    return cloneSettings(this.settings);
  }

  async updateSettings(patch: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilitySettings> {
    if (!this.isBuilderRuntime()) {
      throw new Error("Phoenix observability is only available in Builder runtime.");
    }

    const current = await this.getSettings();
    const candidate = normalizePhoenixObservabilitySettings(patch, current);
    validatePhoenixEndpoint(candidate.endpoint);

    let nextExporter: PhoenixOtlpExporter | null = null;
    try {
      if (candidate.enabled) {
        nextExporter = this.createExporter(candidate);
      }

      const next = await this.settingsService.updateSettings(candidate);
      const oldExporter = this.exporter;
      this.exporter = nextExporter;
      this.settings = next;
      this.lastErrorAt = null;
      this.lastErrorMessage = null;
      await oldExporter?.shutdown().catch((error) => this.recordError(error));
      return cloneSettings(next);
    } catch (error) {
      await nextExporter?.shutdown().catch((shutdownError) => this.recordError(shutdownError));
      this.recordError(error);
      throw error;
    }
  }

  getStatus(): PhoenixObservabilityStatus {
    const settings = this.settings ?? this.getDefaultStatusSettings();
    const exporterStatus = this.exporter?.getStatus();
    const processorCounters = exporterStatus?.counters;
    const correlationCounters = this.correlator.getCounters();
    const counters: PhoenixObservabilityCounters = {
      spansStarted: correlationCounters.spansStarted,
      spansEnded: correlationCounters.spansEnded,
      accepted: processorCounters?.accepted ?? 0,
      droppedQueueFull: processorCounters?.droppedQueueFull ?? 0,
      exportSucceeded: processorCounters?.exportSucceeded ?? 0,
      exportFailed: processorCounters?.exportFailed ?? 0,
      contentTruncations: correlationCounters.contentTruncations + (exporterStatus?.redactionStats.contentTruncations ?? 0),
      redactionMatches: correlationCounters.redactionMatches + (exporterStatus?.redactionStats.redactionMatches ?? 0),
      correlationMisses: correlationCounters.correlationMisses,
      correlationEvictions: correlationCounters.correlationEvictions + (exporterStatus?.correlationEvictions ?? 0),
    };

    return {
      enabled: settings.enabled,
      runtimeTarget: this.options.runtimeTarget,
      contentMode: settings.contentMode,
      exporter: {
        configured: Boolean(this.exporter),
        active: exporterStatus?.active ?? false,
        endpoint: settings.endpoint,
        projectName: sanitizePhoenixProjectName(settings.projectName),
        lastSuccessfulExportAt: processorCounters?.lastSuccessfulExportAt ?? null,
        lastErrorAt: processorCounters?.lastErrorAt ?? this.lastErrorAt,
        lastErrorMessage: processorCounters?.lastErrorMessage ?? this.lastErrorMessage,
      },
      counters,
    };
  }

  async testConnection(patch?: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilityTestResponse> {
    if (!this.isBuilderRuntime()) {
      return {
        ok: false,
        status: this.getStatus(),
        error: "Phoenix observability is only available in Builder runtime.",
      };
    }

    const base = await this.getSettings();
    const candidate = patch ? normalizePhoenixObservabilitySettings(patch, base) : base;

    try {
      validatePhoenixEndpoint(candidate.endpoint);
      const exporter = this.createExporter({ ...candidate, enabled: true });
      try {
        await exporter.exportSmokeSpan();
      } finally {
        await exporter.shutdown().catch((error) => this.recordError(error));
      }
      return { ok: true, status: this.getStatus() };
    } catch (error) {
      this.recordError(error);
      return {
        ok: false,
        status: this.getStatus(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  recordPromptResolved(input: ObservabilityPromptResolvedInput): void {
    if (!this.isBuilderRuntime() || !this.settings?.enabled || !this.settings.capture.prompts || !this.exporter) {
      return;
    }

    try {
      this.exporter.recordPromptResolved(input);
      this.correlator.incrementSpanStarted();
      this.correlator.incrementSpanEnded();
    } catch (error) {
      this.recordError(error);
    }
  }

  recordRuntimeCreated(input: ObservabilityRuntimeCreatedInput): void {
    if (!this.isBuilderRuntime() || !this.settings?.enabled || !this.exporter) {
      return;
    }

    try {
      const exportInput = this.settings.capture.prompts
        ? input
        : { ...input, finalSystemPrompt: undefined, startupSystemPromptOverride: undefined };
      this.exporter.recordRuntimeCreated(exportInput);
      this.correlator.incrementSpanStarted();
      this.correlator.incrementSpanEnded();
    } catch (error) {
      this.recordError(error);
    }
  }

  beginRuntimeInput(input: ObservabilityRuntimeInputInput): ObservabilityRuntimeInputHandle | undefined {
    if (!this.isBuilderRuntime() || !this.settings?.enabled || !this.exporter) {
      return undefined;
    }

    try {
      const handle = this.exporter.beginRuntimeInput(input);
      this.correlator.incrementSpanStarted();
      return handle;
    } catch (error) {
      this.recordError(error);
      return undefined;
    }
  }

  completeRuntimeInput(handle: ObservabilityRuntimeInputHandle | undefined, patch: ObservabilityRuntimeInputCompletion): void {
    if (!handle || !this.isBuilderRuntime() || !this.settings?.enabled || !this.exporter) {
      return;
    }

    try {
      this.exporter.completeRuntimeInput(handle, patch);
    } catch (error) {
      this.recordError(error);
    }
  }

  cancelRuntimeInput(handle: ObservabilityRuntimeInputHandle | undefined, reason: string): void {
    if (!handle || !this.isBuilderRuntime() || !this.settings?.enabled || !this.exporter) {
      return;
    }

    try {
      const ended = this.exporter.cancelRuntimeInput(handle, reason);
      for (let index = 0; index < ended; index += 1) this.correlator.incrementSpanEnded();
    } catch (error) {
      this.recordError(error);
    }
  }

  recordRuntimeInput(input: ObservabilityRuntimeInputInput): string | undefined {
    return this.beginRuntimeInput(input)?.rootTurnId;
  }

  recordRuntimeSessionEvent(input: ObservabilityRuntimeSessionEventInput): void {
    if (!this.isBuilderRuntime() || !this.settings?.enabled || !this.exporter) {
      return;
    }

    try {
      const result = this.exporter.recordRuntimeSessionEvent(input);
      if (result.started > 0) {
        for (let index = 0; index < result.started; index += 1) this.correlator.incrementSpanStarted();
      }
      if (result.ended > 0) {
        for (let index = 0; index < result.ended; index += 1) this.correlator.incrementSpanEnded();
      }
      if (result.correlationMisses > 0) {
        for (let index = 0; index < result.correlationMisses; index += 1) this.correlator.recordCorrelationMiss();
      }
      // Exporter-owned correlation evictions are exposed through exporter status counters.
    } catch (error) {
      this.recordError(error);
    }
  }

  recordToolSideEffect(input: ObservabilityToolSideEffectInput): void {
    if (!this.isBuilderRuntime() || !this.settings?.enabled || !this.exporter) {
      return;
    }

    try {
      const result = this.exporter.recordToolSideEffect(input);
      this.applySpanRecordResult(result);
    } catch (error) {
      this.recordError(error);
    }
  }

  recordAgentDelivery(input: ObservabilityAgentDeliveryInput): void {
    if (!this.isBuilderRuntime() || !this.settings?.enabled || !this.exporter) {
      return;
    }

    try {
      const result = this.exporter.recordAgentDelivery(input);
      this.applySpanRecordResult(result);
    } catch (error) {
      this.recordError(error);
    }
  }

  recordFeedback(_event: FeedbackSubmitEvent): void {
    // Package 1 adds the shared injection seam. Rich feedback annotation export is Package 7.
    if (!this.isBuilderRuntime() || !this.settings?.enabled) {
      return;
    }
  }

  async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    const exporter = this.exporter;
    this.exporter = null;
    if (!exporter) {
      return;
    }

    const shutdown = exporter.shutdown();
    if (!options?.timeoutMs) {
      await shutdown.catch((error) => this.recordError(error));
      return;
    }

    await Promise.race([
      shutdown,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.timeoutMs);
        timer.unref?.();
      }),
    ]).catch((error) => this.recordError(error));
  }

  private applySpanRecordResult(result: { started?: number; ended?: number; correlationMisses?: number }): void {
    if ((result.started ?? 0) > 0) {
      for (let index = 0; index < (result.started ?? 0); index += 1) this.correlator.incrementSpanStarted();
    }
    if ((result.ended ?? 0) > 0) {
      for (let index = 0; index < (result.ended ?? 0); index += 1) this.correlator.incrementSpanEnded();
    }
    if ((result.correlationMisses ?? 0) > 0) {
      for (let index = 0; index < (result.correlationMisses ?? 0); index += 1) this.correlator.recordCorrelationMiss();
    }
  }

  private async configureExporter(
    settings: PhoenixObservabilitySettings,
    options: { throwOnFailure: boolean },
  ): Promise<void> {
    const oldExporter = this.exporter;
    this.exporter = null;
    await oldExporter?.shutdown().catch((error) => this.recordError(error));

    if (!this.isBuilderRuntime() || !settings.enabled) {
      return;
    }

    try {
      validatePhoenixEndpoint(settings.endpoint);
      this.exporter = this.createExporter(settings);
      this.lastErrorAt = null;
      this.lastErrorMessage = null;
    } catch (error) {
      this.recordError(error);
      if (options.throwOnFailure) {
        throw error;
      }
    }
  }

  private isBuilderRuntime(): boolean {
    return isBuilderRuntimeTarget(this.options.runtimeTarget);
  }

  private createExporter(settings: PhoenixObservabilitySettings): PhoenixOtlpExporter {
    return this.options.exporterFactory?.(settings) ?? new PhoenixOtlpExporter({ settings, version: this.options.version });
  }

  private getDefaultStatusSettings(): PhoenixObservabilitySettings {
    return {
      enabled: false,
      endpoint: "http://127.0.0.1:6006/v1/traces",
      projectName: "default",
      contentMode: "rich",
      capture: {
        prompts: true,
        modelInputs: true,
        modelOutputs: true,
        toolInputs: true,
        toolResults: true,
        feedbackComments: true,
        imageData: false,
      },
      privacy: {
        redactionEnabled: true,
        includeDisplayNames: false,
        identifierMode: "stable_hash",
        pathMode: "basename_and_hash",
        maxContentChars: 32 * 1024,
        maxAttributeChars: 32 * 1024,
        maxSpanContentChars: 128 * 1024,
        extraRedactionPatterns: [],
      },
      export: {
        batchMaxQueueSize: 512,
        batchMaxExportBatchSize: 64,
        scheduledDelayMs: 2000,
        exportTimeoutMs: 3000,
        concurrencyLimit: 1,
      },
      updatedAt: null,
    };
  }

  private recordError(error: unknown): void {
    this.lastErrorAt = new Date().toISOString();
    this.lastErrorMessage = error instanceof Error ? error.message : String(error);
  }
}

function cloneSettings(settings: PhoenixObservabilitySettings): PhoenixObservabilitySettings {
  return JSON.parse(JSON.stringify(settings)) as PhoenixObservabilitySettings;
}
