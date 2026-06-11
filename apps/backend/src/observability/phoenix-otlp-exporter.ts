import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SEMRESATTRS_PROJECT_NAME, SemanticConventions } from "@arizeai/openinference-semantic-conventions";
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
import { ObservabilityRedactor, type RedactionStats } from "./observability-redaction.js";
import type { ObservabilityPromptResolvedInput, ObservabilityRuntimeCreatedInput } from "./observability-types.js";
import { buildCommonOpenInferenceAttributes, assertOtelPrimitiveAttributes, type OtelAttributes } from "./openinference-attributes.js";

export interface PhoenixOtlpExporterStatus {
  active: boolean;
  endpoint: string;
  projectName: string;
  counters: CountingBatchSpanProcessorCounters;
  redactionStats: RedactionStats;
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

  recordPromptResolved(input: ObservabilityPromptResolvedInput): void {
    const attributes: OtelAttributes = buildCommonOpenInferenceAttributes({
      spanKind: "PROMPT",
      input: input.prompt,
      sessionId: input.managerId ?? input.agentId,
      userId: input.profileId,
      metadata: {
        ...input.metadata,
        event: "prompt_resolved",
        source: input.source,
        runtimeType: input.runtimeType,
        runtimeToken: input.runtimeToken,
        role: input.role,
        cwd: input.cwd,
        modelProvider: input.modelProvider,
        modelId: input.modelId,
      },
      tags: ["forge", "phoenix", "prompt", input.runtimeType],
      agentName: input.agentName ?? input.agentId,
      graphNodeId: input.agentId,
      graphNodeParentId: input.managerId,
    }, this.redactor);

    this.exportOneShotSpan("forge.prompt.resolve", attributes);
  }

  recordRuntimeCreated(input: ObservabilityRuntimeCreatedInput): void {
    const attributes: OtelAttributes = buildCommonOpenInferenceAttributes({
      spanKind: input.role === "worker" ? "AGENT" : "CHAIN",
      input: input.finalSystemPrompt,
      output: input.status,
      sessionId: input.managerId ?? input.agentId,
      userId: input.profileId,
      metadata: {
        ...input.metadata,
        event: "runtime_created",
        runtimeType: input.runtimeType,
        runtimeToken: input.runtimeToken,
        role: input.role,
        cwd: input.cwd,
        modelProvider: input.modelProvider,
        modelId: input.modelId,
        reasoningLevel: input.reasoningLevel,
        archetypeId: input.archetypeId,
        startupSystemPromptOverride: input.startupSystemPromptOverride,
        mcpServers: input.mcpServers,
      },
      tags: ["forge", "phoenix", "runtime", input.runtimeType],
      agentName: input.agentName ?? input.agentId,
      graphNodeId: input.agentId,
      graphNodeParentId: input.managerId,
    }, this.redactor);
    if (input.activeTools && input.activeTools.length > 0) {
      attributes[SemanticConventions.LLM_TOOLS] = this.redactor.sanitizeAttributeValue(input.activeTools);
    }

    this.exportOneShotSpan("forge.runtime.create", attributes);
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

  private exportOneShotSpan(name: string, attributes: OtelAttributes): void {
    try {
      assertOtelPrimitiveAttributes(attributes);
      const tracer = this.provider.getTracer("forge-phoenix");
      const span = tracer.startSpan(
        name,
        {
          kind: SpanKind.INTERNAL,
          attributes,
        },
        ROOT_CONTEXT,
      );
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    } catch {
      // Observability export must never affect Forge runtime behavior.
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
      redactionStats: this.redactor.getStats(),
    };
  }
}
