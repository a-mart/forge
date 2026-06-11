import {
  MimeType,
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";
import type { ObservabilityRedactor } from "./observability-redaction.js";

export type OtelAttributeValue = string | number | boolean | string[];
export type OtelAttributes = Record<string, OtelAttributeValue>;

export interface CommonOpenInferenceAttributeInput {
  spanKind: keyof typeof OpenInferenceSpanKind;
  input?: unknown;
  output?: unknown;
  inputMimeType?: string;
  outputMimeType?: string;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  agentName?: string;
  graphNodeId?: string;
  graphNodeName?: string;
  graphNodeParentId?: string;
}

export interface ModelCallAttributeInput {
  modelId?: string;
  provider?: string;
  finishReason?: string;
  invocationParameters?: Record<string, unknown>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    total?: number;
  };
  costUsd?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface ToolAttributeInput {
  name?: string;
  description?: string;
  parameters?: unknown;
  jsonSchema?: unknown;
}

export function buildCommonOpenInferenceAttributes(
  input: CommonOpenInferenceAttributeInput,
  redactor: ObservabilityRedactor,
): OtelAttributes {
  const attrs: OtelAttributes = {
    [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind[input.spanKind],
  };

  setSanitized(attrs, SemanticConventions.INPUT_VALUE, input.input, redactor);
  setSanitized(attrs, SemanticConventions.OUTPUT_VALUE, input.output, redactor);
  setString(attrs, SemanticConventions.INPUT_MIME_TYPE, input.inputMimeType ?? MimeType.TEXT);
  setString(attrs, SemanticConventions.OUTPUT_MIME_TYPE, input.outputMimeType ?? MimeType.TEXT);
  setString(attrs, SemanticConventions.SESSION_ID, input.sessionId);
  setString(attrs, SemanticConventions.USER_ID, input.userId);
  setSanitized(attrs, SemanticConventions.METADATA, input.metadata, redactor);
  setSanitized(attrs, SemanticConventions.TAG_TAGS, input.tags, redactor);
  setString(attrs, SemanticConventions.AGENT_NAME, input.agentName);
  setString(attrs, SemanticConventions.GRAPH_NODE_ID, input.graphNodeId);
  setString(attrs, SemanticConventions.GRAPH_NODE_NAME, input.graphNodeName);
  setString(attrs, SemanticConventions.GRAPH_NODE_PARENT_ID, input.graphNodeParentId);

  return attrs;
}

export function buildModelCallAttributes(input: ModelCallAttributeInput, redactor: ObservabilityRedactor): OtelAttributes {
  const attrs: OtelAttributes = {};
  setString(attrs, SemanticConventions.LLM_MODEL_NAME, input.modelId);
  setString(attrs, SemanticConventions.LLM_PROVIDER, input.provider);
  setString(attrs, SemanticConventions.LLM_FINISH_REASON, input.finishReason);
  setSanitized(attrs, SemanticConventions.LLM_INVOCATION_PARAMETERS, input.invocationParameters, redactor);

  setNumber(attrs, SemanticConventions.LLM_TOKEN_COUNT_PROMPT, input.usage?.input);
  setNumber(attrs, SemanticConventions.LLM_TOKEN_COUNT_COMPLETION, input.usage?.output);
  setNumber(attrs, SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ, input.usage?.cacheRead);
  setNumber(attrs, SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE, input.usage?.cacheWrite);
  setNumber(attrs, SemanticConventions.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING, input.usage?.reasoning);
  setNumber(attrs, SemanticConventions.LLM_TOKEN_COUNT_TOTAL, input.usage?.total);

  setNumber(attrs, SemanticConventions.LLM_COST_INPUT, input.costUsd?.input);
  setNumber(attrs, SemanticConventions.LLM_COST_OUTPUT, input.costUsd?.output);
  setNumber(attrs, SemanticConventions.LLM_COST_PROMPT_DETAILS_CACHE_READ, input.costUsd?.cacheRead);
  setNumber(attrs, SemanticConventions.LLM_COST_PROMPT_DETAILS_CACHE_WRITE, input.costUsd?.cacheWrite);
  setNumber(attrs, SemanticConventions.LLM_COST_TOTAL, input.costUsd?.total);

  return attrs;
}

export function buildToolAttributes(input: ToolAttributeInput, redactor: ObservabilityRedactor): OtelAttributes {
  const attrs: OtelAttributes = {};
  setString(attrs, SemanticConventions.TOOL_NAME, input.name);
  setString(attrs, SemanticConventions.TOOL_DESCRIPTION, input.description);
  setSanitized(attrs, SemanticConventions.TOOL_PARAMETERS, input.parameters, redactor);
  setSanitized(attrs, SemanticConventions.TOOL_JSON_SCHEMA, input.jsonSchema, redactor);
  return attrs;
}

export function assertOtelPrimitiveAttributes(attributes: Record<string, unknown>): asserts attributes is OtelAttributes {
  for (const [key, value] of Object.entries(attributes)) {
    const valid =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) && value.every((entry) => typeof entry === "string"));

    if (!valid) {
      throw new Error(`Attribute ${key} is not an OpenTelemetry primitive value.`);
    }
  }
}

function setSanitized(attrs: OtelAttributes, key: string, value: unknown, redactor: ObservabilityRedactor): void {
  if (value === undefined || value === null) {
    return;
  }

  attrs[key] = redactor.sanitizeAttributeValue(value);
}

function setString(attrs: OtelAttributes, key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) {
    return;
  }

  attrs[key] = value;
}

function setNumber(attrs: OtelAttributes, key: string, value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value)) {
    return;
  }

  attrs[key] = value;
}
