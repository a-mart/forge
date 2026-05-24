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
  }): RuntimeConversationProjection[] {
    const projections: RuntimeConversationProjection[] = [];
    const { agentId, event, timestamp, descriptor } = options;

    if (descriptor) {
      const managerContextId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
      const toolProjection = mapToolCallActivityFromRuntime(managerContextId, agentId, event, timestamp);
      if (toolProjection) {
        projections.push(toolProjection);
      }
    }

    if (descriptor?.role === "manager") {
      const managerErrorProjection = mapManagerRuntimeErrorConversationEvent(agentId, event, timestamp);
      if (managerErrorProjection) {
        projections.push(managerErrorProjection);
      }
      return projections;
    }

    const runtimeLogProjections = mapNonManagerRuntimeEvent(agentId, event, timestamp);
    projections.push(...runtimeLogProjections);
    return projections;
  }
}

function mapNonManagerRuntimeEvent(
  agentId: string,
  event: RuntimeSessionEvent,
  timestamp: string
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
          text: safeJson(event.result),
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
  timestamp: string
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
  timestamp: string
): AgentToolCallEvent | undefined {
  switch (event.type) {
    case "tool_execution_start":
      return {
        type: "agent_tool_call",
        agentId: managerContextId,
        actorAgentId,
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
        timestamp,
        kind: "tool_execution_end",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        text: safeJson(event.result),
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
