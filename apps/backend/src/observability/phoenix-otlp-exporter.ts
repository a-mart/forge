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
  ObservabilityRuntimeInputCompletion,
  ObservabilityRuntimeInputHandle,
  ObservabilityRuntimeInputInput,
  ObservabilityRuntimeSessionEventInput,
  ObservabilityToolDefinition,
  ObservabilityToolSideEffectInput,
  ObservabilityAgentDeliveryInput,
} from "./observability-types.js";
import {
  buildCommonOpenInferenceAttributes,
  buildModelCallAttributes,
  buildToolAttributes,
  assertOtelPrimitiveAttributes,
  type OtelAttributes,
} from "./openinference-attributes.js";

export interface PhoenixOtlpExporterStatus {
  active: boolean;
  endpoint: string;
  projectName: string;
  counters: CountingBatchSpanProcessorCounters;
  redactionStats: RedactionStats;
  correlationEvictions: number;
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
  correlationEvictions: number;
}

export interface ToolSideEffectRecordResult {
  started: number;
  ended: number;
  correlationMisses: number;
}

export interface AgentDeliveryRecordResult {
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
  parentRootTurnId?: string;
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
  output?: unknown;
  meta?: RuntimeModelCallMeta;
}

interface ActiveToolCall {
  span: Span;
  rootTurnId: string;
  agentId: string;
  runtimeToken?: number;
  toolCallId: string;
  toolName: string;
  startedAtMs: number;
  updateCount: number;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

interface RuntimeToolCacheEntry {
  tools: ObservabilityToolDefinition[];
  updatedAtMs: number;
}

const PENDING_RUNTIME_INPUT_TTL_MS = 5 * 60 * 1000;
const ACTIVE_RUNTIME_TURN_TTL_MS = 30 * 60 * 1000;
const RUNTIME_TOOL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PENDING_INPUTS_PER_AGENT = 16;
const MAX_PENDING_INPUT_AGENTS = 128;
const MAX_ACTIVE_TURNS = 256;
const MAX_ACTIVE_TOOL_SPANS = 1024;
const MAX_RUNTIME_TOOL_CACHE_ENTRIES = 512;

export class PhoenixOtlpExporter {
  private readonly provider: BasicTracerProvider;
  private readonly processor: CountingBatchSpanProcessor;
  private readonly endpoint: string;
  private readonly projectName: string;
  private readonly capture: PhoenixObservabilitySettings["capture"];
  private readonly redactor: ObservabilityRedactor;
  private readonly runtimeToolsByAgentToken = new Map<string, RuntimeToolCacheEntry>();
  private readonly pendingInputsByAgentId = new Map<string, PendingRuntimeInput[]>();
  private readonly activeTurnsByAgentToken = new Map<string, ActiveRuntimeTurn>();
  private readonly activeToolSpansByAgentTokenToolCall = new Map<string, ActiveToolCall>();
  private readonly toolEnrichmentSeenByAgentTokenToolPhase = new Set<string>();
  private correlationEvictions = 0;

  constructor(options: PhoenixOtlpExporterOptions) {
    validatePhoenixEndpoint(options.settings.endpoint);
    this.endpoint = options.settings.endpoint;
    this.projectName = sanitizePhoenixProjectName(options.settings.projectName) || DEFAULT_PHOENIX_PROJECT_NAME;
    this.capture = options.settings.capture;
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
      this.runtimeToolsByAgentToken.set(buildAgentTokenKey(input.agentId, input.runtimeToken), { tools, updatedAtMs: Date.now() });
      this.evictCorrelationState();
    }

    this.exportOneShotSpan("forge.runtime.create", attributes);
  }

  beginRuntimeInput(input: ObservabilityRuntimeInputInput): ObservabilityRuntimeInputHandle {
    this.evictCorrelationState();
    const rootTurnId = input.rootTurnId ?? randomUUID();
    const tracer = this.provider.getTracer("forge-phoenix");
    const capturedOriginalInput = this.captureInput(input.originalInput);
    const capturedRuntimeInput = this.captureInput(input.runtimeInput);
    const attributes = buildCommonOpenInferenceAttributes({
      spanKind: input.role === "worker" ? "AGENT" : "CHAIN",
      input: capturedOriginalInput ?? capturedRuntimeInput,
      sessionId: input.managerId ?? input.targetAgentId,
      userId: input.profileId,
      metadata: {
        ...input.metadata,
        event: "runtime_input",
        rootTurnId,
        parentRootTurnId: input.parentRootTurnId,
        rootSource: input.rootSource,
        runtimeType: input.runtimeType,
        runtimeToken: input.runtimeToken,
        role: input.role,
        visibleMessageId: input.visibleMessageId,
        requestedDelivery: input.requestedDelivery,
        acceptedMode: input.acceptedMode,
        sourceChannel: input.sourceChannel,
        requestPayloadFidelity: input.requestPayloadFidelity ?? "delta_only",
        runtimeInput: capturedRuntimeInput,
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
      activeTools: input.activeTools ?? this.runtimeToolsByAgentToken.get(buildAgentTokenKey(input.targetAgentId, input.runtimeToken))?.tools,
    };
    const queue = this.pendingInputsByAgentId.get(input.targetAgentId) ?? [];
    queue.push(pending);
    this.pendingInputsByAgentId.set(input.targetAgentId, queue);
    this.enforcePendingInputCaps(input.targetAgentId);
    return { rootTurnId, targetAgentId: input.targetAgentId, runtimeToken: input.runtimeToken };
  }

  completeRuntimeInput(handle: ObservabilityRuntimeInputHandle | undefined, patch: ObservabilityRuntimeInputCompletion): void {
    if (!handle) {
      return;
    }
    const pending = this.findPendingInput(handle.rootTurnId);
    const turn = this.findActiveTurnByRootTurnId(handle.rootTurnId);
    const span = pending?.rootSpan ?? turn?.rootSpan;
    if (!span) {
      return;
    }
    if (patch.acceptedMode !== undefined) {
      span.setAttribute("forge.accepted_mode", this.redactor.sanitizeLabel(patch.acceptedMode));
    }
    if (patch.deliveryId !== undefined) {
      span.setAttribute("forge.delivery_id", this.redactor.redactIdentifier(patch.deliveryId));
    }
    if (patch.metadata !== undefined) {
      span.setAttribute("forge.dispatch_metadata", this.redactor.sanitizeAttributeValue({
        rootTurnId: handle.rootTurnId,
        acceptedMode: patch.acceptedMode,
        deliveryId: patch.deliveryId,
        ...patch.metadata,
      }));
    }
    if (pending && patch.acceptedMode !== undefined) {
      pending.acceptedMode = patch.acceptedMode;
    }
  }

  cancelRuntimeInput(handle: ObservabilityRuntimeInputHandle | undefined, reason: string): number {
    if (!handle) {
      return 0;
    }
    const pending = this.removePendingInputByRootTurnId(handle.rootTurnId);
    if (pending) {
      this.closePendingInput(pending, reason);
      return 1;
    }
    const turn = this.removeActiveTurnByRootTurnId(handle.rootTurnId);
    if (turn) {
      const ended = 1 + (turn.llm ? 1 : 0) + 1;
      this.closeActiveTurn(turn, reason);
      return ended;
    }
    return 0;
  }

  recordRuntimeInput(input: ObservabilityRuntimeInputInput): string {
    return this.beginRuntimeInput(input).rootTurnId;
  }

  recordRuntimeSessionEvent(input: ObservabilityRuntimeSessionEventInput): RuntimeSessionEventRecordResult {
    const evictionsBefore = this.correlationEvictions;
    this.evictCorrelationState();
    const result: RuntimeSessionEventRecordResult = { started: 0, ended: 0, correlationMisses: 0, correlationEvictions: 0 };
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
        if (!turn) {
          return result;
        }
        if (turn.llm) {
          this.endLlmCall(turn.llm, turn, input);
          turn.llm = undefined;
          result.ended += 1;
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
        llm.output = event.message.content;
        llm.meta = mergeRuntimeModelCallMeta(llm.meta, event.meta);
        return result;
      }

      if (event.type === "tool_execution_start") {
        const turn = this.ensureActiveTurn(input, result);
        if (!turn) {
          return result;
        }
        if (this.startToolCall(input, turn, event) !== undefined) {
          result.started += 1;
        }
        return result;
      }

      if (event.type === "tool_execution_update") {
        const tool = this.getActiveToolCall(input.agentId, input.runtimeToken, event.toolCallId);
        if (tool) {
          this.updateToolCall(tool, event.partialResult);
        } else {
          result.correlationMisses += 1;
        }
        return result;
      }

      if (event.type === "tool_execution_end") {
        const tool = this.getActiveToolCall(input.agentId, input.runtimeToken, event.toolCallId);
        if (tool) {
          this.endToolCall(tool, event.result, event.isError);
          result.ended += 1;
        } else {
          result.correlationMisses += 1;
        }
        return result;
      }

      if (event.type === "turn_end") {
        const turn = this.getActiveTurn(input.agentId, input.runtimeToken);
        if (!turn) {
          result.correlationMisses += 1;
          return result;
        }
        if (turn.llm) {
          turn.llm.meta = mergeRuntimeModelCallMeta(turn.llm.meta, event.meta);
          this.endLlmCall(turn.llm, turn, input);
          turn.llm = undefined;
          result.ended += 1;
        }
        result.ended += this.closeActiveToolsForTurn(turn, "runtime_turn_ended");
        this.endRuntimeTurn(turn, event.meta, event.toolResults);
        result.ended += 2;
        return result;
      }
    } catch {
      // Observability must never affect runtime projection.
    } finally {
      result.correlationEvictions = this.correlationEvictions - evictionsBefore;
    }
    return result;
  }

  recordToolSideEffect(input: ObservabilityToolSideEffectInput): ToolSideEffectRecordResult {
    const result: ToolSideEffectRecordResult = { started: 0, ended: 0, correlationMisses: 0 };
    try {
      const tool = this.getActiveToolCall(input.agentId, input.runtimeToken, input.toolCallId);
      if (!tool) {
        result.correlationMisses += 1;
        return result;
      }
      const enrichmentKey = buildToolEnrichmentKey(input.agentId, input.runtimeToken, input.toolCallId, input.phase);
      if (this.toolEnrichmentSeenByAgentTokenToolPhase.has(enrichmentKey)) {
        tool.span.addEvent("forge.tool.duplicate_enrichment", {
          "forge.tool_phase": input.phase,
        });
        return result;
      }
      this.toolEnrichmentSeenByAgentTokenToolPhase.add(enrichmentKey);
      const attrs: OtelAttributes = {
        "forge.tool_phase": input.phase,
        "forge.user_visible": input.userVisible === true || tool.toolName === "speak_to_user",
      };
      const capturedInput = this.captureToolInput(input.input);
      const capturedOutput = this.captureToolResult(input.output);
      if (capturedInput !== undefined) {
        attrs[SemanticConventions.INPUT_VALUE] = this.redactor.sanitizeAttributeValue(capturedInput);
        attrs[SemanticConventions.INPUT_MIME_TYPE] = "application/json";
      }
      if (capturedOutput !== undefined) {
        attrs[SemanticConventions.OUTPUT_VALUE] = this.redactor.sanitizeAttributeValue(capturedOutput);
        attrs[SemanticConventions.OUTPUT_MIME_TYPE] = "application/json";
      }
      if (input.metadata) {
        attrs[SemanticConventions.METADATA] = this.redactor.sanitizeAttributeValue({
          rootTurnId: tool.rootTurnId,
          runtimeToken: input.runtimeToken,
          toolName: input.toolName,
          ...input.metadata,
        });
      }
      assertOtelPrimitiveAttributes(attrs);
      tool.span.addEvent(`forge.tool.${input.phase}`, attrs);
      if (input.userVisible === true) {
        tool.span.setAttribute("forge.user_visible", true);
      }
      if (input.isError === true) {
        tool.span.setAttribute("forge.side_effect_error", true);
      }
      if (input.toolName === "send_message_to_agent" || input.metadata?.targetAgentId !== undefined) {
        this.exportChildSideEffectSpan("forge.agent.delivery", tool, input, "agent_delivery");
        result.started += 1;
        result.ended += 1;
      }
      if (input.userVisible === true || (input.phase === "side_effect" && input.toolName === "speak_to_user")) {
        this.exportChildSideEffectSpan("forge.user.output", tool, input, "user_output");
        result.started += 1;
        result.ended += 1;
      }
    } catch {
      // Observability must never affect tool execution.
    }
    return result;
  }

  recordAgentDelivery(input: ObservabilityAgentDeliveryInput): AgentDeliveryRecordResult {
    const result: AgentDeliveryRecordResult = { started: 0, ended: 0, correlationMisses: 0 };
    try {
      const parentRootTurnId = input.parentRootTurnId ?? input.rootTurnId;
      const parentSpan = parentRootTurnId ? this.findRootSpanByRootTurnId(parentRootTurnId) : undefined;
      const correlationStatus = parentSpan ? "resolved" : "unresolved";
      const capturedMessage = this.captureInput(input.message);
      const capturedRuntimeInput = this.captureInput(input.runtimeInput);
      const attributes = buildCommonOpenInferenceAttributes({
        spanKind: "CHAIN",
        input: capturedMessage,
        output: capturedRuntimeInput,
        sessionId: input.managerId ?? input.targetAgentId,
        userId: input.profileId,
        metadata: {
          event: "agent_delivery",
          rootTurnId: input.rootTurnId,
          parentRootTurnId: input.parentRootTurnId,
          attachmentRootTurnId: parentRootTurnId,
          correlationStatus,
          fromAgentId: input.fromAgentId,
          targetAgentId: input.targetAgentId,
          requestedDelivery: input.requestedDelivery,
          acceptedMode: input.acceptedMode,
          deliveryId: input.deliveryId,
          source: input.source,
          runtimeInput: capturedRuntimeInput,
          ...input.metadata,
        },
        tags: ["forge", "phoenix", "agent_delivery", input.source ?? "agent_message"],
        agentName: input.sourceAgentName ?? input.fromAgentId,
        graphNodeId: input.targetAgentId,
        graphNodeParentId: input.fromAgentId,
      }, this.redactor);
      if (input.deliveryId) {
        attributes["forge.delivery_id"] = this.redactor.redactIdentifier(input.deliveryId);
      }
      if (input.acceptedMode) {
        attributes["forge.accepted_mode"] = this.redactor.sanitizeLabel(input.acceptedMode);
      }
      assertOtelPrimitiveAttributes(attributes);
      const span = this.provider.getTracer("forge-phoenix").startSpan(
        "forge.agent.delivery",
        { kind: SpanKind.INTERNAL, attributes },
        parentSpan ? trace.setSpan(ROOT_CONTEXT, parentSpan) : ROOT_CONTEXT,
      );
      span.setStatus(parentSpan ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR, message: "unresolved_parent_root" });
      span.end();
      result.started += 1;
      result.ended += 1;
      if (!parentSpan) {
        result.correlationMisses += 1;
      }
    } catch {
      // Observability must never affect delivery.
    }
    return result;
  }

  private exportChildSideEffectSpan(
    spanName: "forge.agent.delivery" | "forge.user.output",
    tool: ActiveToolCall,
    input: ObservabilityToolSideEffectInput,
    eventName: "agent_delivery" | "user_output",
  ): void {
    const childInput = input.input !== undefined ? this.captureToolInput(input.input) : undefined;
    const childOutput = input.output !== undefined ? this.captureToolResult(input.output) : undefined;
    const attributes = buildCommonOpenInferenceAttributes({
      spanKind: "CHAIN",
      input: childInput,
      output: childOutput,
      sessionId: input.managerId ?? input.agentId,
      userId: input.profileId,
      metadata: {
        event: eventName,
        rootTurnId: tool.rootTurnId,
        runtimeToken: input.runtimeToken,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        userVisible: input.userVisible === true || input.toolName === "speak_to_user",
        ...input.metadata,
      },
      tags: ["forge", "phoenix", eventName],
      agentName: input.agentName ?? input.agentId,
      graphNodeId: input.agentId,
      graphNodeParentId: input.managerId,
    }, this.redactor);
    assertOtelPrimitiveAttributes(attributes);
    const span = this.provider.getTracer("forge-phoenix").startSpan(
      spanName,
      { kind: SpanKind.INTERNAL, attributes },
      trace.setSpan(ROOT_CONTEXT, tool.span),
    );
    span.setStatus(input.isError ? { code: SpanStatusCode.ERROR, message: "tool_side_effect_error" } : { code: SpanStatusCode.OK });
    span.end();
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
      input: this.captureInput(pending.runtimeInput),
      sessionId: input.managerId ?? input.agentId,
      userId: input.profileId,
      metadata: {
        event: "runtime_turn",
        rootTurnId: pending.rootTurnId,
        parentRootTurnId: pending.parentRootTurnId,
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
      parentRootTurnId: pending.parentRootTurnId,
      rootSpan: pending.rootSpan,
      turnSpan,
      agentId: input.agentId,
      runtimeToken: input.runtimeToken,
      startedAtMs: Date.now(),
      runtimeInput: pending.runtimeInput,
      activeTools: pending.activeTools,
    };
    const key = buildAgentTokenKey(input.agentId, input.runtimeToken);
    const existing = this.activeTurnsByAgentToken.get(key);
    if (existing) {
      this.closeActiveTurn(existing, "superseded_by_new_turn");
      this.correlationEvictions += 1;
    }
    this.activeTurnsByAgentToken.set(key, turn);
    this.enforceActiveTurnCaps();
    return turn;
  }

  private startLlmCall(input: ObservabilityRuntimeSessionEventInput, turn: ActiveRuntimeTurn): ActiveLlmCall {
    const parentContext = trace.setSpan(ROOT_CONTEXT, turn.turnSpan);
    const attributes = buildCommonOpenInferenceAttributes({
      spanKind: "LLM",
      input: this.captureInput(turn.runtimeInput),
      sessionId: input.managerId ?? input.agentId,
      userId: input.profileId,
      metadata: {
        event: "llm_call",
        rootTurnId: turn.rootTurnId,
        parentRootTurnId: turn.parentRootTurnId,
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

  private startToolCall(
    input: ObservabilityRuntimeSessionEventInput,
    turn: ActiveRuntimeTurn,
    event: Extract<ObservabilityRuntimeSessionEventInput["event"], { type: "tool_execution_start" }>,
  ): ActiveToolCall | undefined {
    const key = buildToolCallKey(input.agentId, input.runtimeToken, event.toolCallId);
    const existing = this.activeToolSpansByAgentTokenToolCall.get(key);
    if (existing) {
      existing.span.addEvent("forge.tool.duplicate_start", {
        "forge.tool_name": this.redactor.sanitizeLabel(event.toolName),
      });
      return undefined;
    }

    const definition = findToolDefinition(turn.activeTools, event.toolName);
    const capturedArgs = this.captureToolInput(event.args);
    const attributes: OtelAttributes = {
      ...buildCommonOpenInferenceAttributes({
        spanKind: "TOOL",
        input: capturedArgs,
        sessionId: input.managerId ?? input.agentId,
        userId: input.profileId,
        metadata: {
          event: "tool_execution",
          rootTurnId: turn.rootTurnId,
          parentRootTurnId: turn.parentRootTurnId,
          runtimeToken: input.runtimeToken,
          runtimeType: input.runtimeType,
          role: input.role,
          correlationStatus: "resolved",
          ...input.metadata,
        },
        tags: ["forge", "phoenix", "tool", event.toolName],
        agentName: input.agentName ?? input.agentId,
        graphNodeId: input.agentId,
        graphNodeParentId: input.managerId,
      }, this.redactor),
      ...buildToolAttributes({
        name: event.toolName,
        description: definition?.description,
        parameters: capturedArgs,
        jsonSchema: definition?.jsonSchema,
      }, this.redactor),
      [SemanticConventions.TOOL_CALL_ID]: this.redactor.redactIdentifier(event.toolCallId),
      "forge.runtime_token": input.runtimeToken ?? "unknown",
      "forge.user_visible": event.toolName === "speak_to_user",
    };
    if (definition?.source) {
      attributes["forge.tool_source"] = this.redactor.sanitizeLabel(definition.source);
    }
    assertOtelPrimitiveAttributes(attributes);
    const span = this.provider.getTracer("forge-phoenix").startSpan(
      `forge.tool.${event.toolName}`,
      { kind: SpanKind.INTERNAL, attributes },
      trace.setSpan(ROOT_CONTEXT, turn.turnSpan),
    );
    const tool: ActiveToolCall = {
      span,
      rootTurnId: turn.rootTurnId,
      agentId: input.agentId,
      runtimeToken: input.runtimeToken,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      startedAtMs: Date.now(),
      updateCount: 0,
      input: event.args,
    };
    this.activeToolSpansByAgentTokenToolCall.set(key, tool);
    this.enforceActiveToolSpanCaps();
    return tool;
  }

  private updateToolCall(tool: ActiveToolCall, partialResult: unknown): void {
    tool.updateCount += 1;
    const captured = this.captureToolResult(partialResult);
    const attrs: OtelAttributes = {
      "forge.tool_update_count": tool.updateCount,
    };
    if (captured !== undefined) {
      attrs[SemanticConventions.OUTPUT_VALUE] = this.redactor.sanitizeAttributeValue(captured);
      attrs[SemanticConventions.OUTPUT_MIME_TYPE] = "application/json";
    }
    assertOtelPrimitiveAttributes(attrs);
    tool.span.addEvent("forge.tool.update", attrs);
  }

  private endToolCall(tool: ActiveToolCall, result: unknown, isError: boolean, reason?: string): void {
    const key = buildToolCallKey(tool.agentId, tool.runtimeToken, tool.toolCallId);
    this.activeToolSpansByAgentTokenToolCall.delete(key);
    this.clearToolEnrichmentSeen(tool.agentId, tool.runtimeToken, tool.toolCallId);
    tool.output = result;
    tool.isError = isError;
    const attrs: OtelAttributes = {
      "forge.duration_ms": Date.now() - tool.startedAtMs,
      "forge.tool_update_count": tool.updateCount,
      "forge.user_visible": tool.toolName === "speak_to_user",
    };
    const capturedResult = this.captureToolResult(result);
    if (capturedResult !== undefined) {
      attrs[SemanticConventions.OUTPUT_VALUE] = this.redactor.sanitizeAttributeValue(capturedResult);
      attrs[SemanticConventions.OUTPUT_MIME_TYPE] = "application/json";
    }
    const capturedInput = this.captureToolInput(tool.input);
    if (capturedInput !== undefined) {
      attrs[SemanticConventions.TOOL_PARAMETERS] = this.redactor.sanitizeAttributeValue(capturedInput);
    }
    if (reason) {
      attrs["forge.correlation_status"] = reason;
    }
    assertOtelPrimitiveAttributes(attrs);
    for (const [name, value] of Object.entries(attrs)) {
      tool.span.setAttribute(name, value);
    }
    tool.span.setStatus(isError || reason ? { code: SpanStatusCode.ERROR, message: reason ?? "tool_error" } : { code: SpanStatusCode.OK });
    tool.span.end();
  }

  private closeActiveToolsForTurn(turn: ActiveRuntimeTurn, reason: string): number {
    let ended = 0;
    for (const tool of Array.from(this.activeToolSpansByAgentTokenToolCall.values())) {
      if (tool.agentId === turn.agentId && tool.runtimeToken === turn.runtimeToken) {
        this.endToolCall(tool, tool.output ?? { status: reason }, true, reason);
        ended += 1;
      }
    }
    return ended;
  }

  private getActiveToolCall(agentId: string, runtimeToken: number | undefined, toolCallId: string): ActiveToolCall | undefined {
    return this.activeToolSpansByAgentTokenToolCall.get(buildToolCallKey(agentId, runtimeToken, toolCallId));
  }

  private endLlmCall(
    llm: ActiveLlmCall,
    turn: ActiveRuntimeTurn,
    input: ObservabilityRuntimeSessionEventInput,
  ): void {
    const meta = llm.meta;
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
    const capturedOutput = this.captureOutput(llm.output ?? "");
    if (capturedOutput !== undefined) {
      attrs[SemanticConventions.OUTPUT_VALUE] = this.redactor.sanitizeAttributeValue(capturedOutput);
      attrs[SemanticConventions.OUTPUT_MIME_TYPE] = "application/json";
    }
    attrs["forge.duration_ms"] = meta?.durationMs ?? (Date.now() - llm.startedAtMs);
    if (meta?.providerRequestId) attrs["forge.provider_request_id"] = this.redactor.redactIdentifier(meta.providerRequestId);
    if (meta?.api) attrs["forge.provider_api"] = this.redactor.sanitizeLabel(meta.api);
    if (meta?.requestPayloadFidelity) attrs["forge.request_payload_fidelity"] = meta.requestPayloadFidelity;
    const capturedRequestMessages = this.captureInput(meta?.requestMessages);
    if (capturedRequestMessages !== undefined) attrs[SemanticConventions.LLM_INPUT_MESSAGES] = this.redactor.sanitizeAttributeValue(capturedRequestMessages);
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
      parentRootTurnId: turn.parentRootTurnId,
      toolResultCount: toolResults.length,
      ...(meta && typeof meta === "object" ? { turnMeta: this.captureModelCallMetaForMetadata(meta) } : {}),
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

  private findPendingInput(rootTurnId: string): PendingRuntimeInput | undefined {
    for (const queue of this.pendingInputsByAgentId.values()) {
      const pending = queue.find((candidate) => candidate.rootTurnId === rootTurnId);
      if (pending) {
        return pending;
      }
    }
    return undefined;
  }

  private removePendingInputByRootTurnId(rootTurnId: string): PendingRuntimeInput | undefined {
    for (const [agentId, queue] of this.pendingInputsByAgentId.entries()) {
      const index = queue.findIndex((candidate) => candidate.rootTurnId === rootTurnId);
      if (index < 0) {
        continue;
      }
      const [pending] = queue.splice(index, 1);
      if (queue.length === 0) {
        this.pendingInputsByAgentId.delete(agentId);
      }
      return pending;
    }
    return undefined;
  }

  private findRootSpanByRootTurnId(rootTurnId: string): Span | undefined {
    const pending = this.findPendingInput(rootTurnId);
    if (pending) {
      return pending.rootSpan;
    }
    return this.findActiveTurnByRootTurnId(rootTurnId)?.rootSpan;
  }

  private findActiveTurnByRootTurnId(rootTurnId: string): ActiveRuntimeTurn | undefined {
    for (const turn of this.activeTurnsByAgentToken.values()) {
      if (turn.rootTurnId === rootTurnId) {
        return turn;
      }
    }
    return undefined;
  }

  private removeActiveTurnByRootTurnId(rootTurnId: string): ActiveRuntimeTurn | undefined {
    for (const [key, turn] of this.activeTurnsByAgentToken.entries()) {
      if (turn.rootTurnId !== rootTurnId) {
        continue;
      }
      this.activeTurnsByAgentToken.delete(key);
      return turn;
    }
    return undefined;
  }

  private evictCorrelationState(nowMs = Date.now()): void {
    for (const [agentId, queue] of this.pendingInputsByAgentId.entries()) {
      const retained: PendingRuntimeInput[] = [];
      for (const pending of queue) {
        if (nowMs - pending.createdAtMs > PENDING_RUNTIME_INPUT_TTL_MS) {
          this.closePendingInput(pending, "pending_runtime_input_ttl_evicted");
          this.correlationEvictions += 1;
        } else {
          retained.push(pending);
        }
      }
      if (retained.length > 0) {
        this.pendingInputsByAgentId.set(agentId, retained);
      } else {
        this.pendingInputsByAgentId.delete(agentId);
      }
    }

    for (const [key, turn] of this.activeTurnsByAgentToken.entries()) {
      if (nowMs - turn.startedAtMs > ACTIVE_RUNTIME_TURN_TTL_MS) {
        this.activeTurnsByAgentToken.delete(key);
        this.closeActiveTurn(turn, "active_runtime_turn_ttl_evicted");
        this.correlationEvictions += 1;
      }
    }

    for (const [key, tool] of this.activeToolSpansByAgentTokenToolCall.entries()) {
      if (nowMs - tool.startedAtMs > ACTIVE_RUNTIME_TURN_TTL_MS) {
        this.activeToolSpansByAgentTokenToolCall.delete(key);
        this.endToolCall(tool, tool.output ?? { status: "active_tool_span_ttl_evicted" }, true, "active_tool_span_ttl_evicted");
        this.correlationEvictions += 1;
      }
    }

    for (const [key, entry] of this.runtimeToolsByAgentToken.entries()) {
      if (nowMs - entry.updatedAtMs > RUNTIME_TOOL_CACHE_TTL_MS) {
        this.runtimeToolsByAgentToken.delete(key);
        this.correlationEvictions += 1;
      }
    }

    this.enforceGlobalPendingInputCaps();
    this.enforceActiveTurnCaps();
    this.enforceActiveToolSpanCaps();
    this.enforceRuntimeToolCacheCaps();
  }

  private enforcePendingInputCaps(agentId: string): void {
    const queue = this.pendingInputsByAgentId.get(agentId);
    if (queue) {
      while (queue.length > MAX_PENDING_INPUTS_PER_AGENT) {
        const pending = queue.shift();
        if (pending) {
          this.closePendingInput(pending, "pending_runtime_input_agent_cap_evicted");
          this.correlationEvictions += 1;
        }
      }
      if (queue.length === 0) {
        this.pendingInputsByAgentId.delete(agentId);
      }
    }
    this.enforceGlobalPendingInputCaps();
  }

  private enforceGlobalPendingInputCaps(): void {
    while (this.pendingInputsByAgentId.size > MAX_PENDING_INPUT_AGENTS) {
      const oldest = this.findOldestPendingInput();
      if (!oldest) {
        return;
      }
      const pending = this.removePendingInputByRootTurnId(oldest.rootTurnId);
      if (pending) {
        this.closePendingInput(pending, "pending_runtime_input_global_cap_evicted");
        this.correlationEvictions += 1;
      }
    }
  }

  private findOldestPendingInput(): PendingRuntimeInput | undefined {
    let oldest: PendingRuntimeInput | undefined;
    for (const queue of this.pendingInputsByAgentId.values()) {
      for (const pending of queue) {
        if (!oldest || pending.createdAtMs < oldest.createdAtMs) {
          oldest = pending;
        }
      }
    }
    return oldest;
  }

  private enforceActiveTurnCaps(): void {
    while (this.activeTurnsByAgentToken.size > MAX_ACTIVE_TURNS) {
      const oldestEntry = Array.from(this.activeTurnsByAgentToken.entries())
        .sort((left, right) => left[1].startedAtMs - right[1].startedAtMs)[0];
      if (!oldestEntry) {
        return;
      }
      const [key, turn] = oldestEntry;
      this.activeTurnsByAgentToken.delete(key);
      this.closeActiveTurn(turn, "active_runtime_turn_cap_evicted");
      this.correlationEvictions += 1;
    }
  }

  private enforceActiveToolSpanCaps(): void {
    while (this.activeToolSpansByAgentTokenToolCall.size > MAX_ACTIVE_TOOL_SPANS) {
      const oldestEntry = Array.from(this.activeToolSpansByAgentTokenToolCall.entries())
        .sort((left, right) => left[1].startedAtMs - right[1].startedAtMs)[0];
      if (!oldestEntry) {
        return;
      }
      const [key, tool] = oldestEntry;
      this.activeToolSpansByAgentTokenToolCall.delete(key);
      this.endToolCall(tool, tool.output ?? { status: "active_tool_span_cap_evicted" }, true, "active_tool_span_cap_evicted");
      this.correlationEvictions += 1;
    }
  }

  private enforceRuntimeToolCacheCaps(): void {
    while (this.runtimeToolsByAgentToken.size > MAX_RUNTIME_TOOL_CACHE_ENTRIES) {
      const oldestEntry = Array.from(this.runtimeToolsByAgentToken.entries())
        .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs)[0];
      if (!oldestEntry) {
        return;
      }
      this.runtimeToolsByAgentToken.delete(oldestEntry[0]);
      this.correlationEvictions += 1;
    }
  }

  private clearToolEnrichmentSeen(agentId: string, runtimeToken: number | undefined, toolCallId: string): void {
    const prefix = `${buildToolCallKey(agentId, runtimeToken, toolCallId)}:`;
    for (const key of Array.from(this.toolEnrichmentSeenByAgentTokenToolPhase)) {
      if (key.startsWith(prefix)) {
        this.toolEnrichmentSeenByAgentTokenToolPhase.delete(key);
      }
    }
  }

  private closePendingInput(pending: PendingRuntimeInput, reason: string): void {
    pending.rootSpan.setAttribute("forge.correlation_status", reason);
    pending.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
    pending.rootSpan.end();
  }

  private closeActiveTurn(turn: ActiveRuntimeTurn, reason: string): void {
    this.closeActiveToolsForTurn(turn, reason);
    if (turn.llm) {
      turn.llm.span.setAttribute("forge.correlation_status", reason);
      turn.llm.span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
      turn.llm.span.end();
      turn.llm = undefined;
    }
    turn.turnSpan.setAttribute("forge.correlation_status", reason);
    turn.turnSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
    turn.turnSpan.end();
    turn.rootSpan.setAttribute("forge.correlation_status", reason);
    turn.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
    turn.rootSpan.end();
  }

  private closeOpenCorrelationSpans(reason: string): void {
    for (const tool of Array.from(this.activeToolSpansByAgentTokenToolCall.values())) {
      this.endToolCall(tool, tool.output ?? { status: reason }, true, reason);
    }
    this.activeToolSpansByAgentTokenToolCall.clear();

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

  private captureInput(value: unknown): unknown {
    if (!this.capture.modelInputs) {
      return undefined;
    }
    return this.capture.imageData ? value : stripRuntimeImageData(value);
  }

  private captureOutput(value: unknown): unknown {
    if (!this.capture.modelOutputs) {
      return undefined;
    }
    return this.capture.imageData ? value : stripRuntimeImageData(value);
  }

  private captureToolInput(value: unknown): unknown {
    if (!this.capture.toolInputs) {
      return undefined;
    }
    return this.capture.imageData ? value : stripRuntimeImageData(value);
  }

  private captureToolResult(value: unknown): unknown {
    if (!this.capture.toolResults) {
      return undefined;
    }
    return this.capture.imageData ? value : stripRuntimeImageData(value);
  }

  private captureModelCallMetaForMetadata(meta: unknown): unknown {
    if (!meta || typeof meta !== "object") {
      return meta;
    }
    const record = { ...(meta as Record<string, unknown>) };
    if (!this.capture.modelInputs) {
      delete record.requestMessages;
      delete record.request_messages;
    }
    return this.capture.imageData ? record : stripRuntimeImageData(record);
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
      correlationEvictions: this.correlationEvictions,
    };
  }
}

function mergeRuntimeModelCallMeta(
  current: RuntimeModelCallMeta | undefined,
  next: RuntimeModelCallMeta | undefined,
): RuntimeModelCallMeta | undefined {
  if (!current) return next;
  if (!next) return current;
  return {
    ...current,
    ...next,
    provider: next.provider ?? current.provider,
    api: next.api ?? current.api,
    modelId: next.modelId ?? current.modelId,
    responseModelId: next.responseModelId ?? current.responseModelId,
    providerRequestId: next.providerRequestId ?? current.providerRequestId,
    stopReason: next.stopReason ?? current.stopReason,
    durationMs: next.durationMs ?? current.durationMs,
    usage: next.usage ?? current.usage,
    costUsd: next.costUsd ?? current.costUsd,
    requestPayloadFidelity: next.requestPayloadFidelity ?? current.requestPayloadFidelity,
    requestMessages: next.requestMessages ?? current.requestMessages,
    invocationParameters: next.invocationParameters ?? current.invocationParameters,
    metadata: current.metadata || next.metadata ? { ...current.metadata, ...next.metadata } : undefined,
  };
}

function stripRuntimeImageData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripRuntimeImageData(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "images" && Array.isArray(entry)) {
      output[key] = entry.map((image) => summarizeImagePayload(image));
      continue;
    }
    if (key === "data" && typeof entry === "string" && looksLikeImagePayloadContainer(record)) {
      output[key] = summarizeImageData(record, entry);
      continue;
    }
    if (key === "source" && entry && typeof entry === "object" && looksLikeImagePayloadContainer(entry as Record<string, unknown>)) {
      output[key] = summarizeImagePayload(entry);
      continue;
    }
    output[key] = stripRuntimeImageData(entry);
  }
  return output;
}

function summarizeImagePayload(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "data" && typeof entry === "string") {
      output[key] = summarizeImageData(record, entry);
    } else {
      output[key] = stripRuntimeImageData(entry);
    }
  }
  return output;
}

function looksLikeImagePayloadContainer(record: Record<string, unknown>): boolean {
  const mimeType = record.mimeType ?? record.mediaType ?? record.media_type;
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/")
    || record.type === "base64"
    || record.type === "image"
    || record.type === "input_image";
}

function summarizeImageData(record: Record<string, unknown>, data: string): string {
  const mimeType = record.mimeType ?? record.mediaType ?? record.media_type;
  const label = typeof mimeType === "string" ? mimeType : "image";
  return `[${label} data omitted; ${data.length} chars]`;
}

function buildAgentTokenKey(agentId: string, runtimeToken?: number): string {
  return `${agentId}:${runtimeToken ?? "unknown"}`;
}

function buildToolCallKey(agentId: string, runtimeToken: number | undefined, toolCallId: string): string {
  return `${buildAgentTokenKey(agentId, runtimeToken)}:${toolCallId}`;
}

function buildToolEnrichmentKey(agentId: string, runtimeToken: number | undefined, toolCallId: string, phase: string): string {
  return `${buildToolCallKey(agentId, runtimeToken, toolCallId)}:${phase}`;
}

function findToolDefinition(
  tools: ObservabilityToolDefinition[] | undefined,
  toolName: string,
): ObservabilityToolDefinition | undefined {
  return tools?.find((tool) => tool.name === toolName);
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
