import type {
  FeedbackSubmitEvent,
  PhoenixObservabilityCounters,
  PhoenixObservabilitySettings,
  PhoenixObservabilitySettingsPatch,
  PhoenixObservabilityStatus,
  PhoenixObservabilityTestResponse,
} from "@forge/protocol";
import { PhoenixOtlpExporter } from "./phoenix-otlp-exporter.js";
import { ObservabilityCorrelator } from "./observability-correlator.js";
import {
  PhoenixObservabilitySettingsService,
  normalizePhoenixObservabilitySettings,
  sanitizePhoenixProjectName,
  validatePhoenixEndpoint,
} from "./observability-settings.js";
import type { ObservabilityFacade, ObservabilityRuntimeTarget } from "./observability-types.js";

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
    try {
      this.settings = await this.settingsService.load();
      await this.configureExporter(this.settings, { throwOnFailure: false });
    } catch (error) {
      this.recordError(error);
    }
  }

  async getSettings(): Promise<PhoenixObservabilitySettings> {
    if (!this.settings) {
      this.settings = await this.settingsService.getSettings();
    }

    return cloneSettings(this.settings);
  }

  async updateSettings(patch: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilitySettings> {
    const next = await this.settingsService.updateSettings(patch);
    this.settings = next;
    await this.configureExporter(next, { throwOnFailure: true });
    return cloneSettings(next);
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
      contentTruncations: correlationCounters.contentTruncations,
      redactionMatches: correlationCounters.redactionMatches,
      correlationMisses: correlationCounters.correlationMisses,
      correlationEvictions: correlationCounters.correlationEvictions,
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

  recordFeedback(_event: FeedbackSubmitEvent): void {
    // Package 1 adds the shared injection seam. Rich feedback annotation export is Package 7.
    if (!this.settings?.enabled) {
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

  private async configureExporter(
    settings: PhoenixObservabilitySettings,
    options: { throwOnFailure: boolean },
  ): Promise<void> {
    const oldExporter = this.exporter;
    this.exporter = null;
    await oldExporter?.shutdown().catch((error) => this.recordError(error));

    if (!settings.enabled) {
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
