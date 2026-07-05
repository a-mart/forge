import {
  extractMessageErrorMessage,
  extractMessageImageAttachments,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  hasMessageErrorMessageField,
  isStrictContextOverflowMessage,
  normalizeProviderErrorMessage
} from "./message-utils.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import type {
  AgentDescriptor,
  AgentToolCallEvent,
  ConversationLogEvent,
  ConversationMessageEvent
} from "../types.js";

const MAX_SAFE_JSON_BYTES = 32 * 1024;
const SAFE_JSON_TRUNCATED_SUFFIX = " [truncated]";
const MANAGER_ERROR_CONTEXT_HINT = "Try compacting the conversation to free up context space.";
const MANAGER_ERROR_GENERIC_HINT = "Please retry. If this persists, check provider auth and rate limits.";
const WORKER_ERROR_CONTEXT_HINT = "The manager may need to compact the task context before retrying.";
const WORKER_ERROR_GENERIC_HINT = "The manager may need to retry after checking provider auth, quotas, or rate limits.";

type RuntimeConversationProjection = ConversationMessageEvent | ConversationLogEvent | AgentToolCallEvent;

export class RuntimeConversationEventMapper {
  mapRuntimeEvent(options: {
    agentId: string;
    event: RuntimeSessionEvent;
    timestamp: string;
    descriptor?: AgentDescriptor;
    turnId?: string;
  }): RuntimeConversationProjection[] {
    const projections: RuntimeConversationProjection[] = [];
    const { agentId, event, timestamp, descriptor, turnId } = options;

    if (descriptor) {
      const managerContextId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
      const toolProjection = mapToolCallActivityFromRuntime(managerContextId, agentId, event, timestamp, descriptor, turnId);
      if (toolProjection) {
        projections.push(toolProjection);
      }
    }

    if (descriptor?.role === "manager") {
      const managerErrorProjection = mapManagerRuntimeErrorConversationEvent(agentId, event, timestamp, turnId);
      if (managerErrorProjection) {
        projections.push(managerErrorProjection);
      }
      return projections;
    }

    const runtimeLogProjections = mapNonManagerRuntimeEvent(agentId, event, timestamp, descriptor, turnId);
    projections.push(...runtimeLogProjections);
    return projections;
  }
}

function mapNonManagerRuntimeEvent(
  agentId: string,
  event: RuntimeSessionEvent,
  timestamp: string,
  descriptor?: AgentDescriptor,
  turnId?: string
): RuntimeConversationProjection[] {
  switch (event.type) {
    case "message_start": {
      const role = extractRole(event.message);
      if (role !== "user" && role !== "assistant" && role !== "system") {
        return [];
      }

      return [
        {
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "message_start",
          role,
          text: extractMessageText(event.message) ?? "(non-text message)"
        }
      ];
    }

    case "message_end": {
      const role = extractRole(event.message);
      if (role !== "user" && role !== "assistant" && role !== "system") {
        return [];
      }

      const projections: RuntimeConversationProjection[] = [];
      const extractedText = extractMessageText(event.message);
      const text = extractedText ?? "(non-text message)";
      const attachments = extractMessageImageAttachments(event.message);

      if ((role === "assistant" || role === "system") && (extractedText || attachments.length > 0)) {
        projections.push({
          type: "conversation_message",
          agentId,
          ...(turnId ? { turnId } : {}),
          role,
          text: extractedText ?? "",
          attachments: attachments.length > 0 ? attachments : undefined,
          timestamp,
          source: "system"
        });
      }

      if (role === "assistant") {
        const stopReason = extractMessageStopReason(event.message);
        const hasStructuredErrorMessage = hasMessageErrorMessageField(event.message);
        if (stopReason === "error" || hasStructuredErrorMessage) {
          const normalizedErrorMessage = normalizeProviderErrorMessage(
            extractMessageErrorMessage(event.message) ?? extractedText
          );
          const isContextOverflow = isStrictContextOverflowMessage(normalizedErrorMessage);

          projections.push({
            type: "conversation_message",
            agentId,
            ...(turnId ? { turnId } : {}),
            role: "system",
            text: buildWorkerErrorConversationText({
              errorMessage: normalizedErrorMessage,
              isContextOverflow
            }),
            timestamp,
            source: "system"
          });
        }
      }

      projections.push({
        type: "conversation_log",
        agentId,
        timestamp,
        source: "runtime_log",
        kind: "message_end",
        role,
        text
      });
      return projections;
    }

    case "tool_execution_start":
      return [
        {
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.args)
        }
      ];

    case "tool_execution_update":
      return [
        {
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_update",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.partialResult)
        }
      ];

    case "tool_execution_end":
      return [
        {
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_end",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(sanitizeToolExecutionEndResultForAudit(event.result, { descriptor, toolName: event.toolName })),
          isError: event.isError
        }
      ];

    case "agent_start":
    case "agent_end":
    case "turn_start":
    case "turn_end":
    case "message_update":
    case "auto_compaction_start":
    case "auto_compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      return [];
  }
}

function mapManagerRuntimeErrorConversationEvent(
  agentId: string,
  event: RuntimeSessionEvent,
  timestamp: string,
  turnId?: string
): ConversationMessageEvent | undefined {
  if (event.type !== "message_end") {
    return undefined;
  }

  const role = extractRole(event.message);
  if (role !== "assistant") {
    return undefined;
  }

  const stopReason = extractMessageStopReason(event.message);
  const hasStructuredErrorMessage = hasMessageErrorMessageField(event.message);
  if (stopReason !== "error" && !hasStructuredErrorMessage) {
    return undefined;
  }

  const messageText = extractMessageText(event.message);
  const normalizedErrorMessage = normalizeProviderErrorMessage(extractMessageErrorMessage(event.message) ?? messageText);
  const isContextOverflow = isStrictContextOverflowMessage(normalizedErrorMessage);

  return {
    type: "conversation_message",
    agentId,
    ...(turnId ? { turnId } : {}),
    role: "system",
    text: buildManagerErrorConversationText({
      errorMessage: normalizedErrorMessage,
      isContextOverflow
    }),
    timestamp,
    source: "system"
  };
}

function mapToolCallActivityFromRuntime(
  managerContextId: string,
  actorAgentId: string,
  event: RuntimeSessionEvent,
  timestamp: string,
  descriptor: AgentDescriptor,
  turnId?: string
): AgentToolCallEvent | undefined {
  switch (event.type) {
    case "tool_execution_start":
      return {
        type: "agent_tool_call",
        agentId: managerContextId,
        actorAgentId,
        ...(turnId ? { turnId } : {}),
        timestamp,
        kind: "tool_execution_start",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        text: safeJson(event.args)
      };

    case "tool_execution_update":
      return {
        type: "agent_tool_call",
        agentId: managerContextId,
        actorAgentId,
        ...(turnId ? { turnId } : {}),
        timestamp,
        kind: "tool_execution_update",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        text: safeJson(event.partialResult)
      };

    case "tool_execution_end":
      return {
        type: "agent_tool_call",
        agentId: managerContextId,
        actorAgentId,
        ...(turnId ? { turnId } : {}),
        timestamp,
        kind: "tool_execution_end",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        text: safeJson(sanitizeToolExecutionEndResultForAudit(event.result, { descriptor, toolName: event.toolName })),
        isError: event.isError
      };

    case "agent_start":
    case "agent_end":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "message_update":
    case "message_end":
    case "auto_compaction_start":
    case "auto_compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      return undefined;
  }
}

export function sanitizeToolExecutionEndResultForAudit(
  value: unknown,
  context?: { descriptor?: AgentDescriptor; toolName?: string },
): unknown {
  if (!shouldSanitizeCodexPluginScopedToolResult(value, context)) {
    return value;
  }

  return sanitizeAuditValue(value, new WeakSet<object>());
}

function shouldSanitizeCodexPluginScopedToolResult(
  value: unknown,
  context?: { descriptor?: AgentDescriptor; toolName?: string },
): boolean {
  const descriptor = context?.descriptor;
  if (descriptor?.role !== "worker" || descriptor.internalWorkerKind !== "codex_plugin") {
    return false;
  }

  return containsFullContentAuditField(value);
}

function sanitizeAuditValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((entry) => sanitizeAuditValue(entry, seen));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  const publicDetails = isRecord(value.details) ? sanitizeAuditValue(value.details, new WeakSet<object>()) : undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isFullContentAuditKey(key) || isFullContentAuditNote(key, entry)) {
      continue;
    }

    if (key === "content" && Array.isArray(entry)) {
      sanitized[key] = sanitizeToolResultContentArrayForAudit(entry, publicDetails, seen);
      continue;
    }

    sanitized[key] = sanitizeAuditValue(entry, seen);
  }

  return sanitized;
}

function sanitizeToolResultContentArrayForAudit(
  content: unknown[],
  publicDetails: unknown,
  seen: WeakSet<object>,
): unknown[] {
  return content.map((entry) => {
    if (!isRecord(entry) || typeof entry.text !== "string") {
      return sanitizeAuditValue(entry, seen);
    }

    const parsedText = parseJsonObject(entry.text);
    if (!parsedText || !containsFullContentAuditField(parsedText)) {
      return sanitizeAuditValue(entry, seen);
    }

    const sanitizedEntry = sanitizeAuditValue(entry, seen) as Record<string, unknown>;
    return {
      ...sanitizedEntry,
      text: JSON.stringify(publicDetails ?? sanitizeAuditValue(parsedText, new WeakSet<object>())),
    };
  });
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function containsFullContentAuditField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsFullContentAuditField(entry));
  }

  if (typeof value === "string" && /fullRedactedContent|redactedModelContent/i.test(value)) {
    const parsed = parseJsonObject(value);
    return parsed ? containsFullContentAuditField(parsed) : false;
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(
    ([key, entry]) => isFullContentAuditKey(key) || containsFullContentAuditField(entry)
  );
}

function isFullContentAuditKey(key: string): boolean {
  return /^(fullRedactedContent|fullRedactedContentTruncated|redactedModelContent|redactedModelContentTruncated)$/i.test(key);
}

function isFullContentAuditNote(key: string, value: unknown): boolean {
  return key === "note" && typeof value === "string" && /fullRedactedContent|redactedModelContent|full content/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function safeJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }

  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes <= MAX_SAFE_JSON_BYTES) {
    return serialized;
  }

  const suffixBytes = Buffer.byteLength(SAFE_JSON_TRUNCATED_SUFFIX, "utf8");
  if (MAX_SAFE_JSON_BYTES <= suffixBytes) {
    return SAFE_JSON_TRUNCATED_SUFFIX;
  }

  const previewByteCount = MAX_SAFE_JSON_BYTES - suffixBytes;
  const preview = Buffer.from(serialized, "utf8").subarray(0, previewByteCount).toString("utf8");
  return `${preview}${SAFE_JSON_TRUNCATED_SUFFIX}`;
}

function buildManagerErrorConversationText(options: {
  errorMessage?: string;
  isContextOverflow: boolean;
}): string {
  if (options.isContextOverflow) {
    if (options.errorMessage) {
      return `⚠️ Manager reply failed because the prompt exceeded the model context window (${options.errorMessage}). ${MANAGER_ERROR_CONTEXT_HINT}`;
    }

    return `⚠️ Manager reply failed because the prompt exceeded the model context window. ${MANAGER_ERROR_CONTEXT_HINT}`;
  }

  if (options.errorMessage) {
    return `⚠️ Manager reply failed: ${formatManagerErrorMessage(options.errorMessage)} ${MANAGER_ERROR_GENERIC_HINT}`;
  }

  return `⚠️ Manager reply failed. ${MANAGER_ERROR_GENERIC_HINT}`;
}

function buildWorkerErrorConversationText(options: {
  errorMessage?: string;
  isContextOverflow: boolean;
}): string {
  if (options.isContextOverflow) {
    if (options.errorMessage) {
      return `⚠️ Worker reply failed because the prompt exceeded the model context window (${options.errorMessage}). ${WORKER_ERROR_CONTEXT_HINT}`;
    }

    return `⚠️ Worker reply failed because the prompt exceeded the model context window. ${WORKER_ERROR_CONTEXT_HINT}`;
  }

  if (options.errorMessage) {
    return `⚠️ Worker reply failed: ${formatManagerErrorMessage(options.errorMessage)} ${WORKER_ERROR_GENERIC_HINT}`;
  }

  return `⚠️ Worker reply failed. ${WORKER_ERROR_GENERIC_HINT}`;
}

function formatManagerErrorMessage(errorMessage: string): string {
  const trimmed = errorMessage.trim();
  if (trimmed.length === 0) {
    return "Unknown error.";
  }

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
