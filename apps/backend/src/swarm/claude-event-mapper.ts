import {
  extractClaudeContextUsage,
  readBoolean,
  readObject,
  readString
} from "./claude-utils.js";
import type { ClaudeSdkMessage } from "./claude-sdk-loader.js";
import type { AgentContextUsage, AgentStatus } from "./types.js";
import type { RuntimeSessionEvent } from "./runtime-types.js";

export interface ClaudeEventMapperContext {
  agentId: string;
  turnId?: string;
  status: AgentStatus;
}

export interface ClaudeEventMapperLike {
  mapEvent(event: ClaudeSdkMessage, context?: ClaudeEventMapperContext): RuntimeSessionEvent[];
  getContextUsage(): AgentContextUsage | undefined;
  reset(): void;
}

export class ClaudeEventMapper implements ClaudeEventMapperLike {
  private readonly streamedAssistantMessageIds = new Set<string>();
  private readonly completedAssistantMessageIds = new Set<string>();
  private readonly startedToolCallIds = new Set<string>();
  private readonly toolNameByCallId = new Map<string, string>();

  private activeAssistantMessageId: string | undefined;
  private activeAssistantText = "";
  private contextUsage: AgentContextUsage | undefined;

  mapEvent(event: ClaudeSdkMessage, _context?: ClaudeEventMapperContext): RuntimeSessionEvent[] {
    this.captureContextUsage(event);

    const type = readString((event as { type?: unknown }).type);
    switch (type) {
      case "stream_event":
        return this.mapStreamEvent((event as { event?: unknown }).event);

      case "assistant":
        return this.mapAssistantEvent(event as Record<string, unknown>);

      case "user":
        return this.mapUserEvent(event as Record<string, unknown>);

      case "content_block_start":
        return this.mapContentBlockStart(event as Record<string, unknown>);

      case "task_started":
      case "system:task_started":
        return this.mapTaskStarted(event as Record<string, unknown>);

      default:
        return [];
    }
  }

  getContextUsage(): AgentContextUsage | undefined {
    return this.contextUsage;
  }

  reset(): void {
    this.streamedAssistantMessageIds.clear();
    this.completedAssistantMessageIds.clear();
    this.startedToolCallIds.clear();
    this.toolNameByCallId.clear();
    this.activeAssistantMessageId = undefined;
    this.activeAssistantText = "";
    this.contextUsage = undefined;
  }

  private mapStreamEvent(rawEvent: unknown): RuntimeSessionEvent[] {
    const event = readObject(rawEvent);
    if (!event) {
      return [];
    }

    const type = readString(event.type);
    switch (type) {
      case "message_start": {
        const message = readObject(event.message);
        const messageId = readString(message?.id) ?? `claude-stream-${this.streamedAssistantMessageIds.size + 1}`;
        this.activeAssistantMessageId = messageId;
        this.activeAssistantText = "";
        this.streamedAssistantMessageIds.add(messageId);
        return [
          {
            type: "message_start",
            message: {
              role: "assistant",
              content: ""
            }
          }
        ];
      }

      case "content_block_delta": {
        if (!this.activeAssistantMessageId) {
          return [];
        }

        const delta = readObject(event.delta);
        if (readString(delta?.type) !== "text_delta") {
          return [];
        }

        const deltaText = readString(delta?.text) ?? "";
        if (!deltaText) {
          return [];
        }

        this.activeAssistantText += deltaText;
        return [
          {
            type: "message_update",
            message: {
              role: "assistant",
              content: [{ type: "text", text: this.activeAssistantText }]
            }
          }
        ];
      }

      case "message_stop": {
        if (!this.activeAssistantMessageId) {
          return [];
        }

        const messageId = this.activeAssistantMessageId;
        const completedText = this.activeAssistantText;
        this.activeAssistantMessageId = undefined;
        this.activeAssistantText = "";
        this.streamedAssistantMessageIds.delete(messageId);
        this.completedAssistantMessageIds.add(messageId);

        return [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: completedText }]
            }
          }
        ];
      }

      default:
        return [];
    }
  }

  private mapAssistantEvent(event: Record<string, unknown>): RuntimeSessionEvent[] {
    const message = readObject(event.message);
    if (!message) {
      return [];
    }

    const messageId = readString(message.id);
    if (messageId && (this.streamedAssistantMessageIds.has(messageId) || this.completedAssistantMessageIds.has(messageId))) {
      return [];
    }

    const content = extractAssistantContent(message.content);
    if (!content) {
      return [];
    }

    if (messageId) {
      this.completedAssistantMessageIds.add(messageId);
    }

    return [
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: ""
        }
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content
        }
      }
    ];
  }

  private mapUserEvent(event: Record<string, unknown>): RuntimeSessionEvent[] {
    const parentToolUseId = readString(event.parent_tool_use_id);
    if (!parentToolUseId || !("tool_use_result" in event)) {
      return [];
    }

    const toolName = this.toolNameByCallId.get(parentToolUseId) ?? parentToolUseId;
    this.toolNameByCallId.delete(parentToolUseId);
    this.startedToolCallIds.delete(parentToolUseId);

    return [
      {
        type: "tool_execution_end",
        toolName,
        toolCallId: parentToolUseId,
        result: event.tool_use_result,
        isError: readBoolean(event.is_error) ?? readBoolean(event.isError) ?? false
      }
    ];
  }

  private mapContentBlockStart(event: Record<string, unknown>): RuntimeSessionEvent[] {
    const block = readObject(event.content_block);
    if (!block || readString(block.type) !== "tool_use") {
      return [];
    }

    const toolCallId = readString(block.id);
    const toolName = readString(block.name);
    if (!toolCallId || !toolName || this.startedToolCallIds.has(toolCallId)) {
      return [];
    }

    this.startedToolCallIds.add(toolCallId);
    this.toolNameByCallId.set(toolCallId, toolName);

    return [
      {
        type: "tool_execution_start",
        toolName,
        toolCallId,
        args: block.input ?? {}
      }
    ];
  }

  private mapTaskStarted(event: Record<string, unknown>): RuntimeSessionEvent[] {
    const toolCallId = readString(event.tool_use_id) ?? readString(event.task_id);
    const toolName = readString(event.tool_name) ?? readString(event.last_tool_name);
    if (!toolCallId || !toolName || this.startedToolCallIds.has(toolCallId)) {
      return [];
    }

    this.startedToolCallIds.add(toolCallId);
    this.toolNameByCallId.set(toolCallId, toolName);

    return [
      {
        type: "tool_execution_start",
        toolName,
        toolCallId,
        args: event.arguments ?? {}
      }
    ];
  }

  private captureContextUsage(event: ClaudeSdkMessage): void {
    const usage = extractClaudeContextUsage(event);
    if (!usage) {
      return;
    }

    this.contextUsage = usage;
  }
}

function extractAssistantContent(content: unknown): string | Array<Record<string, unknown>> | undefined {
  if (typeof content === "string") {
    return content.trim().length > 0 ? [{ type: "text", text: content }] : undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textBlocks = content.filter((item) => {
    const block = readObject(item);
    return readString(block?.type) === "text" && typeof block?.text === "string" && block.text.length > 0;
  }) as Array<Record<string, unknown>>;

  return textBlocks.length > 0 ? textBlocks : undefined;
}

