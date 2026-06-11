import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SEMRESATTRS_PROJECT_NAME } from "@arizeai/openinference-semantic-conventions";
import type { PhoenixObservabilitySettings } from "@forge/protocol";
import {
  DEFAULT_PHOENIX_PROJECT_NAME,
  sanitizePhoenixProjectName,
  validatePhoenixEndpoint,
} from "./observability-settings.js";
import {
  CountingBatchSpanProcessor,
  type CountingBatchSpanProcessorCounters,
} from "./counting-batch-span-processor.js";
import { ObservabilityRedactor } from "./observability-redaction.js";
import { buildCommonOpenInferenceAttributes } from "./openinference-attributes.js";

export interface PhoenixOtlpExporterStatus {
  active: boolean;
  endpoint: string;
  projectName: string;
  counters: CountingBatchSpanProcessorCounters;
}

export interface PhoenixOtlpExporterOptions {
  settings: PhoenixObservabilitySettings;
  version?: string;
  spanExporter?: SpanExporter;
}

export class PhoenixOtlpExporter {
  private readonly provider: BasicTracerProvider;
  private readonly processor: CountingBatchSpanProcessor;
  private readonly endpoint: string;
  private readonly projectName: string;
  private readonly redactor: ObservabilityRedactor;

  constructor(options: PhoenixOtlpExporterOptions) {
    validatePhoenixEndpoint(options.settings.endpoint);
    this.endpoint = options.settings.endpoint;
    this.projectName = sanitizePhoenixProjectName(options.settings.projectName) || DEFAULT_PHOENIX_PROJECT_NAME;
    this.redactor = new ObservabilityRedactor(options.settings.privacy);

    const resource = resourceFromAttributes({ [SEMRESATTRS_PROJECT_NAME]: this.projectName });
    const spanExporter = options.spanExporter ?? new OTLPTraceExporter({
      url: this.endpoint,
      timeoutMillis: options.settings.export.exportTimeoutMs,
      concurrencyLimit: options.settings.export.concurrencyLimit,
    });
    this.processor = new CountingBatchSpanProcessor(spanExporter, {
      maxQueueSize: options.settings.export.batchMaxQueueSize,
      maxExportBatchSize: options.settings.export.batchMaxExportBatchSize,
      scheduledDelayMs: options.settings.export.scheduledDelayMs,
      exportTimeoutMs: options.settings.export.exportTimeoutMs,
    });

    this.provider = new BasicTracerProvider({
      resource,
      spanLimits: {
        attributeValueLengthLimit: options.settings.privacy.maxAttributeChars,
        attributeCountLimit: 256,
      },
      spanProcessors: [this.processor],
    });

    // Force tracer construction through the local provider. Do not register the provider globally.
    this.provider.getTracer("forge-phoenix", options.version);
  }

  async exportSmokeSpan(): Promise<void> {
    const tracer = this.provider.getTracer("forge-phoenix");
    const rootSpan = tracer.startSpan(
      "forge.phoenix.test",
      {
        kind: SpanKind.INTERNAL,
        attributes: buildCommonOpenInferenceAttributes({
          spanKind: "CHAIN",
          input: "Forge Phoenix observability test span",
          output: "ok",
          metadata: { source: "settings_test_connection" },
          tags: ["forge", "phoenix", "test"],
        }, this.redactor),
      },
      ROOT_CONTEXT,
    );

    const parentContext = trace.setSpan(ROOT_CONTEXT, rootSpan);
    const childSpan = tracer.startSpan(
      "forge.phoenix.test.child",
      {
        kind: SpanKind.INTERNAL,
        attributes: buildCommonOpenInferenceAttributes({
          spanKind: "CHAIN",
          metadata: { parent_context: "explicit" },
        }, this.redactor),
      },
      parentContext,
    );
    childSpan.setStatus({ code: SpanStatusCode.OK });
    childSpan.end();
    rootSpan.setStatus({ code: SpanStatusCode.OK });
    rootSpan.end();

    const beforeFlush = this.processor.getCounters();
    await this.forceFlush();
    const afterFlush = this.processor.getCounters();
    if (afterFlush.exportFailed > beforeFlush.exportFailed || afterFlush.droppedQueueFull > beforeFlush.droppedQueueFull) {
      throw new Error(afterFlush.lastErrorMessage ?? "Phoenix test span export failed.");
    }
  }

  async forceFlush(): Promise<void> {
    await this.provider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }

  getStatus(): PhoenixOtlpExporterStatus {
    return {
      active: true,
      endpoint: this.endpoint,
      projectName: this.projectName,
      counters: this.processor.getCounters(),
    };
  }
}
