import { randomUUID } from "node:crypto";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { BasicTracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SEMRESATTRS_PROJECT_NAME, SemanticConventions } from "@arizeai/openinference-semantic-conventions";
import type { PhoenixObservabilitySettings } from "@forge/protocol";
import type { RuntimeModelCallMeta } from "../swarm/runtime-contracts.js";
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
import type {
  ObservabilityPromptResolvedInput,
  ObservabilityRuntimeCreatedInput,
  ObservabilityRuntimeInputInput,
  ObservabilityRuntimeSessionEventInput,
  ObservabilityToolDefinition,
} from "./observability-types.js";
import {
  buildCommonOpenInferenceAttributes,
  buildModelCallAttributes,
  assertOtelPrimitiveAttributes,
  type OtelAttributes,
} from "./openinference-attributes.js";

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

export interface RuntimeSessionEventRecordResult {
  started: number;
  ended: number;
  correlationMisses: number;
}

interface PendingRuntimeInput extends ObservabilityRuntimeInputInput {
  rootTurnId: string;
  rootSpan: Span;
  createdAtMs: number;
}

interface ActiveRuntimeTurn {
  rootTurnId: string;
  rootSpan: Span;
  turnSpan: Span;
  agentId: string;
  runtimeToken?: number;
  startedAtMs: number;
  runtimeInput?: unknown;
  activeTools?: ObservabilityToolDefinition[];
  llm?: ActiveLlmCall;
}

interface ActiveLlmCall {
  span: Span;
  startedAtMs: number;
  firstUpdateAtMs?: number;
}

export class PhoenixOtlpExporter {
  private readonly provider: BasicTracerProvider;
  private readonly processor: CountingBatchSpanProcessor;
  private readonly endpoint: string;
  private readonly projectName: string;
  private readonly redactor: ObservabilityRedactor;
  private readonly runtimeToolsByAgentToken = new Map<string, ObservabilityToolDefinition[]>();
  private readonly pendingInputsByAgentId = new Map<string, PendingRuntimeInput[]>();
  private readonly activeTurnsByAgentToken = new Map<string, ActiveRuntimeTurn>();

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
      const tools = [...input.activeTools];
      attributes[SemanticConventions.LLM_TOOLS] = this.redactor.sanitizeAttributeValue(tools);
      this.runtimeToolsByAgentToken.set(buildAgentTokenKey(input.agentId, input.runtimeToken), tools);
    }

    this.exportOneShotSpan("forge.runtime.create", attributes);
  }

  recordRuntimeInput(input: ObservabilityRuntimeInputInput): string {
    const rootTurnId = randomUUID();
    const tracer = this.provider.getTracer("forge-phoenix");
    const attributes = buildCommonOpenInferenceAttributes({
      spanKind: input.role === "worker" ? "AGENT" : "CHAIN",
      input: input.originalInput ?? input.runtimeInput,
      sessionId: input.managerId ?? input.targetAgentId,
      userId: input.profileId,
      metadata: {
        ...input.metadata,
        event: "runtime_input",
        rootTurnId,
        rootSource: input.rootSource,
        runtimeType: input.runtimeType,
        runtimeToken: input.runtimeToken,
        role: input.role,
        visibleMessageId: input.visibleMessageId,
        requestedDelivery: input.requestedDelivery,
        acceptedMode: input.acceptedMode,
        sourceChannel: input.sourceChannel,
        requestPayloadFidelity: input.requestPayloadFidelity ?? "delta_only",
        runtimeInput: input.runtimeInput,
        correlationStatus: "pending_runtime_start",
      },
      tags: ["forge", "phoenix", "root", input.rootSource],
      agentName: input.agentName ?? input.targetAgentId,
      graphNodeId: input.targetAgentId,
      graphNodeParentId: input.managerId,
    }, this.redactor);
    assertOtelPrimitiveAttributes(attributes);
    const rootSpan = tracer.startSpan("forge.session.turn", { kind: SpanKind.INTERNAL, attributes }, ROOT_CONTEXT);

    const pending: PendingRuntimeInput = {
      ...input,
      rootTurnId,
      rootSpan,
      createdAtMs: Date.now(),
      activeTools: input.activeTools ?? this.runtimeToolsByAgentToken.get(buildAgentTokenKey(input.targetAgentId, input.runtimeToken)),
    };
    const queue = this.pendingInputsByAgentId.get(input.targetAgentId) ?? [];
    queue.push(pending);
    this.pendingInputsByAgentId.set(input.targetAgentId, queue);
    return rootTurnId;
  }

  recordRuntimeSessionEvent(input: ObservabilityRuntimeSessionEventInput): RuntimeSessionEventRecordResult {
    const result: RuntimeSessionEventRecordResult = { started: 0, ended: 0, correlationMisses: 0 };
    const event = input.event;
    try {
      if (event.type === "turn_start" || (event.type === "message_start" && event.message.role === "user")) {
        if (!this.getActiveTurn(input.agentId, input.runtimeToken)) {
          const pending = this.consumePendingInput(input.agentId, input.runtimeToken, event.type === "message_start" ? event.message.content : undefined);
          if (pending) {
            this.startRuntimeTurn(input, pending);
            result.started += 1;
          } else if (event.type === "turn_start") {
            result.correlationMisses += 1;
          }
        }
        return result;
      }

      if (event.type === "message_start" && event.message.role === "assistant") {
        const turn = this.ensureActiveTurn(input, result);
        if (!turn || turn.llm) {
          return result;
        }
        turn.llm = this.startLlmCall(input, turn);
        result.started += 1;
        return result;
      }

      if (event.type === "message_update" && event.message.role === "assistant") {
        const turn = this.getActiveTurn(input.agentId, input.runtimeToken);
        if (turn?.llm && turn.llm.firstUpdateAtMs === undefined) {
          turn.llm.firstUpdateAtMs = Date.now();
          turn.llm.span.setAttribute("forge.ttft_ms", turn.llm.firstUpdateAtMs - turn.llm.startedAtMs);
        }
        return result;
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        const turn = this.ensureActiveTurn(input, result);
        if (!turn) {
          return result;
        }
        const llm = turn.llm ?? this.startLlmCall(input, turn);
        if (!turn.llm) {
          turn.llm = llm;
          result.started += 1;
        }
        this.endLlmCall(llm, turn, input, event.message.content, event.meta);
        turn.llm = undefined;
        result.ended += 1;
        return result;
      }

      if (event.type === "turn_end") {
        const turn = this.getActiveTurn(input.agentId, input.runtimeToken);
        if (!turn) {
          result.correlationMisses += 1;
          return result;
        }
        if (turn.llm) {
          this.endLlmCall(turn.llm, turn, input, undefined, event.meta);
          turn.llm = undefined;
          result.ended += 1;
        }
        this.endRuntimeTurn(turn, event.meta, event.toolResults);
        result.ended += 2;
        return result;
      }
    } catch {
      // Observability must never affect runtime projection.
    }
    return result;
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

  private startRuntimeTurn(input: ObservabilityRuntimeSessionEventInput, pending: PendingRuntimeInput): ActiveRuntimeTurn {
    const parentContext = trace.setSpan(ROOT_CONTEXT, pending.rootSpan);
    const attributes = buildCommonOpenInferenceAttributes({
      spanKind: input.role === "worker" ? "AGENT" : "CHAIN",
      input: pending.runtimeInput,
      sessionId: input.managerId ?? input.agentId,
      userId: input.profileId,
      metadata: {
        event: "runtime_turn",
        rootTurnId: pending.rootTurnId,
        rootSource: pending.rootSource,
        runtimeType: input.runtimeType ?? pending.runtimeType,
        runtimeToken: input.runtimeToken,
        requestPayloadFidelity: pending.requestPayloadFidelity ?? "delta_only",
        correlationStatus: "resolved",
        ...input.metadata,
      },
      tags: ["forge", "phoenix", "runtime_turn", input.runtimeType ?? pending.runtimeType ?? "runtime"],
      agentName: input.agentName ?? pending.agentName ?? input.agentId,
      graphNodeId: input.agentId,
      graphNodeParentId: input.managerId,
    }, this.redactor);
    assertOtelPrimitiveAttributes(attributes);
    const turnSpan = this.provider.getTracer("forge-phoenix").startSpan(
      "forge.runtime.turn",
      { kind: SpanKind.INTERNAL, attributes },
      parentContext,
    );
    const turn: ActiveRuntimeTurn = {
      rootTurnId: pending.rootTurnId,
      rootSpan: pending.rootSpan,
      turnSpan,
      agentId: input.agentId,
      runtimeToken: input.runtimeToken,
      startedAtMs: Date.now(),
      runtimeInput: pending.runtimeInput,
      activeTools: pending.activeTools,
    };
    this.activeTurnsByAgentToken.set(buildAgentTokenKey(input.agentId, input.runtimeToken), turn);
    return turn;
  }

  private startLlmCall(input: ObservabilityRuntimeSessionEventInput, turn: ActiveRuntimeTurn): ActiveLlmCall {
    const parentContext = trace.setSpan(ROOT_CONTEXT, turn.turnSpan);
    const attributes = buildCommonOpenInferenceAttributes({
      spanKind: "LLM",
      input: turn.runtimeInput,
      sessionId: input.managerId ?? input.agentId,
      userId: input.profileId,
      metadata: {
        event: "llm_call",
        rootTurnId: turn.rootTurnId,
        runtimeToken: input.runtimeToken,
        runtimeType: input.runtimeType,
        role: input.role,
        ...input.metadata,
      },
      tags: ["forge", "phoenix", "llm", input.runtimeType ?? "runtime"],
      agentName: input.agentName ?? input.agentId,
      graphNodeId: input.agentId,
      graphNodeParentId: input.managerId,
    }, this.redactor);
    if (turn.activeTools && turn.activeTools.length > 0) {
      attributes[SemanticConventions.LLM_TOOLS] = this.redactor.sanitizeAttributeValue(turn.activeTools);
    }
    assertOtelPrimitiveAttributes(attributes);
    const span = this.provider.getTracer("forge-phoenix").startSpan(
      "forge.llm.call",
      { kind: SpanKind.INTERNAL, attributes },
      parentContext,
    );
    return { span, startedAtMs: Date.now() };
  }

  private endLlmCall(
    llm: ActiveLlmCall,
    turn: ActiveRuntimeTurn,
    input: ObservabilityRuntimeSessionEventInput,
    output: unknown,
    meta: RuntimeModelCallMeta | undefined,
  ): void {
    const attrs: OtelAttributes = {
      ...buildModelCallAttributes({
        modelId: meta?.responseModelId ?? meta?.modelId,
        provider: meta?.provider,
        finishReason: meta?.stopReason,
        invocationParameters: meta?.invocationParameters,
        usage: meta?.usage,
        costUsd: meta?.costUsd,
      }, this.redactor),
    };
    attrs[SemanticConventions.OUTPUT_VALUE] = this.redactor.sanitizeAttributeValue(output ?? "");
    attrs[SemanticConventions.OUTPUT_MIME_TYPE] = "application/json";
    attrs["forge.duration_ms"] = meta?.durationMs ?? (Date.now() - llm.startedAtMs);
    if (meta?.providerRequestId) attrs["forge.provider_request_id"] = this.redactor.redactIdentifier(meta.providerRequestId);
    if (meta?.api) attrs["forge.provider_api"] = this.redactor.sanitizeLabel(meta.api);
    if (meta?.requestPayloadFidelity) attrs["forge.request_payload_fidelity"] = meta.requestPayloadFidelity;
    if (meta?.requestMessages !== undefined) attrs[SemanticConventions.LLM_INPUT_MESSAGES] = this.redactor.sanitizeAttributeValue(meta.requestMessages);
    if (meta?.metadata) attrs["metadata"] = this.redactor.sanitizeAttributeValue({ rootTurnId: turn.rootTurnId, ...input.metadata, ...meta.metadata });
    assertOtelPrimitiveAttributes(attrs);
    for (const [key, value] of Object.entries(attrs)) llm.span.setAttribute(key, value);
    llm.span.setStatus({ code: SpanStatusCode.OK });
    llm.span.end();
  }

  private endRuntimeTurn(turn: ActiveRuntimeTurn, meta: unknown, toolResults: unknown[]): void {
    turn.turnSpan.setAttribute("forge.duration_ms", Date.now() - turn.startedAtMs);
    turn.turnSpan.setAttribute("metadata", this.redactor.sanitizeAttributeValue({
      event: "runtime_turn_end",
      rootTurnId: turn.rootTurnId,
      toolResultCount: toolResults.length,
      ...(meta && typeof meta === "object" ? { turnMeta: meta } : {}),
    }));
    turn.turnSpan.setStatus({ code: SpanStatusCode.OK });
    turn.turnSpan.end();
    turn.rootSpan.setStatus({ code: SpanStatusCode.OK });
    turn.rootSpan.end();
    this.activeTurnsByAgentToken.delete(buildAgentTokenKey(turn.agentId, turn.runtimeToken));
  }

  private ensureActiveTurn(input: ObservabilityRuntimeSessionEventInput, result: RuntimeSessionEventRecordResult): ActiveRuntimeTurn | undefined {
    const existing = this.getActiveTurn(input.agentId, input.runtimeToken);
    if (existing) return existing;
    const pending = this.consumePendingInput(input.agentId, input.runtimeToken);
    if (!pending) {
      result.correlationMisses += 1;
      return undefined;
    }
    result.started += 1;
    return this.startRuntimeTurn(input, pending);
  }

  private getActiveTurn(agentId: string, runtimeToken?: number): ActiveRuntimeTurn | undefined {
    return this.activeTurnsByAgentToken.get(buildAgentTokenKey(agentId, runtimeToken));
  }

  private consumePendingInput(agentId: string, runtimeToken?: number, runtimeMessageContent?: unknown): PendingRuntimeInput | undefined {
    const queue = this.pendingInputsByAgentId.get(agentId);
    if (!queue || queue.length === 0) return undefined;
    const index = queue.findIndex((candidate) => {
      if (candidate.runtimeToken !== undefined && runtimeToken !== undefined && candidate.runtimeToken !== runtimeToken) {
        return false;
      }
      if (runtimeMessageContent === undefined) return true;
      const expected = stringifyForMatch(candidate.runtimeInput);
      const actual = stringifyForMatch(runtimeMessageContent);
      return !expected || !actual || actual.includes(expected) || expected.includes(actual);
    });
    if (index < 0) return undefined;
    const [pending] = queue.splice(index, 1);
    if (queue.length === 0) this.pendingInputsByAgentId.delete(agentId);
    return pending;
  }

  private closeOpenCorrelationSpans(reason: string): void {
    for (const turn of this.activeTurnsByAgentToken.values()) {
      if (turn.llm) {
        turn.llm.span.setAttribute("forge.correlation_status", reason);
        turn.llm.span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
        turn.llm.span.end();
      }
      turn.turnSpan.setAttribute("forge.correlation_status", reason);
      turn.turnSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
      turn.turnSpan.end();
      turn.rootSpan.setAttribute("forge.correlation_status", reason);
      turn.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
      turn.rootSpan.end();
    }
    this.activeTurnsByAgentToken.clear();

    for (const queue of this.pendingInputsByAgentId.values()) {
      for (const pending of queue) {
        pending.rootSpan.setAttribute("forge.correlation_status", reason);
        pending.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
        pending.rootSpan.end();
      }
    }
    this.pendingInputsByAgentId.clear();
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
    this.closeOpenCorrelationSpans("shutdown_orphaned");
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

function buildAgentTokenKey(agentId: string, runtimeToken?: number): string {
  return `${agentId}:${runtimeToken ?? "unknown"}`;
}

function stringifyForMatch(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "text" in value && typeof (value as { text?: unknown }).text === "string") {
    return (value as { text: string }).text;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stringifyForMatch(entry)).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) return stringifyForMatch(record.content);
    if (typeof record.text === "string") return record.text;
  }
  return undefined;
}
