import {
  extractClaudeContextUsage,
  readBoolean,
  readFiniteNumber,
  readObject,
  readString
} from "../../claude-utils.js";
import type { ClaudeSdkMessage } from "../../claude-sdk-loader.js";
import type { AgentContextUsage, AgentStatus } from "../../types.js";
import type { RuntimeSessionEvent } from "../../runtime-contracts.js";

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

interface PendingToolUseBlock {
  toolCallId: string;
  toolName: string;
  input: unknown;
  partialJson: string[];
}

export class ClaudeEventMapper implements ClaudeEventMapperLike {
  private readonly streamedAssistantMessageIds = new Set<string>();
  private readonly completedAssistantMessageIds = new Set<string>();
  private readonly startedToolCallIds = new Set<string>();
  private readonly toolNameByCallId = new Map<string, string>();
  private readonly pendingToolUseBlocks = new Map<number, PendingToolUseBlock>();

  private activeAssistantMessageId: string | undefined;
  private activeAssistantText = "";
  private contextUsage: AgentContextUsage | undefined;
  private compactionState: "idle" | "active" | "fallback_ended" = "idle";

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

      case "system":
        return this.mapSystemEvent(event as Record<string, unknown>);

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
    this.pendingToolUseBlocks.clear();
    this.activeAssistantMessageId = undefined;
    this.activeAssistantText = "";
    this.contextUsage = undefined;
    this.compactionState = "idle";
  }

  private mapStreamEvent(rawEvent: unknown): RuntimeSessionEvent[] {
    const event = readObject(rawEvent);
    if (!event) {
      return [];
    }

    const type = readString(event.type);
    switch (type) {
      case "message_start": {
        this.pendingToolUseBlocks.clear();

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

      case "content_block_start":
        return this.mapStreamContentBlockStart(event);

      case "content_block_delta":
        return this.mapStreamContentBlockDelta(event);

      case "content_block_stop":
        return this.mapStreamContentBlockStop(event);

      case "message_stop": {
        this.pendingToolUseBlocks.clear();

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

  private mapStreamContentBlockStart(event: Record<string, unknown>): RuntimeSessionEvent[] {
    const block = readObject(event.content_block);
    const index = readFiniteNumber(event.index);
    if (!block || index === undefined || readString(block.type) !== "tool_use") {
      return [];
    }

    const toolCallId = readString(block.id);
    const toolName = readString(block.name);
    if (!toolCallId || !toolName) {
      return [];
    }

    this.pendingToolUseBlocks.set(index, {
      toolCallId,
      toolName,
      input: block.input ?? {},
      partialJson: []
    });

    return [];
  }

  private mapStreamContentBlockDelta(event: Record<string, unknown>): RuntimeSessionEvent[] {
    const delta = readObject(event.delta);
    const deltaType = readString(delta?.type);

    if (deltaType === "input_json_delta") {
      const index = readFiniteNumber(event.index);
      const partialJson = readString(delta?.partial_json);
      if (index === undefined || partialJson === undefined) {
        return [];
      }

      const pendingBlock = this.pendingToolUseBlocks.get(index);
      if (!pendingBlock) {
        return [];
      }

      pendingBlock.partialJson.push(partialJson);
      return [];
    }

    if (!this.activeAssistantMessageId || deltaType !== "text_delta") {
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

  private mapStreamContentBlockStop(event: Record<string, unknown>): RuntimeSessionEvent[] {
    const index = readFiniteNumber(event.index);
    if (index === undefined) {
      return [];
    }

    const pendingBlock = this.pendingToolUseBlocks.get(index);
    if (!pendingBlock) {
      return [];
    }

    this.pendingToolUseBlocks.delete(index);
    const args = parseToolUseInput(pendingBlock.partialJson, pendingBlock.input);
    return this.startToolCall(pendingBlock.toolName, pendingBlock.toolCallId, args);
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
    const nestedToolResults = this.mapNestedToolResults(event);
    if (nestedToolResults.length > 0) {
      return nestedToolResults;
    }

    const toolCallId = readString(event.parent_tool_use_id) ?? readString(event.tool_use_id);
    if (!toolCallId || !("tool_use_result" in event)) {
      return [];
    }

    return [this.completeToolCall(toolCallId, event.tool_use_result, event)];
  }

  private mapNestedToolResults(event: Record<string, unknown>): RuntimeSessionEvent[] {
    const message = readObject(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const mappedEvents: RuntimeSessionEvent[] = [];

    for (const item of content) {
      const block = readObject(item);
      if (!block || readString(block.type) !== "tool_result") {
        continue;
      }

      const toolCallId = readString(block.tool_use_id) ?? readString(event.parent_tool_use_id) ?? readString(event.tool_use_id);
      if (!toolCallId) {
        continue;
      }

      const result = "content" in block ? block.content : event.tool_use_result;
      if (result === undefined) {
        continue;
      }

      mappedEvents.push(this.completeToolCall(toolCallId, result, block, event));
    }

    return mappedEvents;
  }

  private mapContentBlockStart(event: Record<string, unknown>): RuntimeSessionEvent[] {
    const block = readObject(event.content_block);
    if (!block || readString(block.type) !== "tool_use") {
      return [];
    }

    const toolCallId = readString(block.id);
    const toolName = readString(block.name);
    if (!toolCallId || !toolName) {
      return [];
    }

    return this.startToolCall(toolName, toolCallId, block.input ?? {});
  }

  private mapTaskStarted(event: Record<string, unknown>): RuntimeSessionEvent[] {
    const toolCallId = readString(event.tool_use_id) ?? readString(event.task_id);
    const toolName = readString(event.tool_name) ?? readString(event.last_tool_name);
    if (!toolCallId || !toolName) {
      return [];
    }

    return this.startToolCall(toolName, toolCallId, event.arguments ?? {});
  }

  private mapSystemEvent(event: Record<string, unknown>): RuntimeSessionEvent[] {
    const subtype = readString(event.subtype);

    if (subtype === "status") {
      const status = readString(event.status);
      if (status === "compacting") {
        if (this.compactionState === "active") {
          return [];
        }

        this.compactionState = "active";
        return [
          {
            type: "auto_compaction_start",
            reason: "threshold"
          }
        ];
      }

      if (this.compactionState !== "active") {
        return [];
      }

      this.compactionState = "fallback_ended";
      return [
        {
          type: "auto_compaction_end",
          result: {},
          aborted: false,
          willRetry: false
        }
      ];
    }

    if (subtype === "compact_boundary") {
      const compactMetadata = readObject(event.compact_metadata);
      const trigger = readString(compactMetadata?.trigger);
      const preTokens = readFiniteNumber(compactMetadata?.pre_tokens);
      const preservedSegment = readObject(compactMetadata?.preserved_segment);
      const result: Record<string, unknown> = {
        ...(trigger ? { trigger } : {}),
        ...(preTokens !== undefined ? { preTokens } : {}),
        ...(preservedSegment ? { preservedSegment } : {})
      };

      if (this.compactionState === "fallback_ended") {
        this.compactionState = "idle";
        return [];
      }

      this.compactionState = "idle";
      return [
        {
          type: "auto_compaction_end",
          result,
          aborted: false,
          willRetry: false
        }
      ];
    }

    return [];
  }

  private startToolCall(toolName: string, toolCallId: string, args: unknown): RuntimeSessionEvent[] {
    if (this.startedToolCallIds.has(toolCallId)) {
      return [];
    }

    this.startedToolCallIds.add(toolCallId);
    this.toolNameByCallId.set(toolCallId, toolName);

    return [
      {
        type: "tool_execution_start",
        toolName,
        toolCallId,
        args
      }
    ];
  }

  private completeToolCall(
    toolCallId: string,
    result: unknown,
    source: Record<string, unknown>,
    fallbackSource?: Record<string, unknown>
  ): RuntimeSessionEvent {
    const toolName = this.toolNameByCallId.get(toolCallId) ?? toolCallId;
    this.toolNameByCallId.delete(toolCallId);
    this.startedToolCallIds.delete(toolCallId);

    return {
      type: "tool_execution_end",
      toolName,
      toolCallId,
      result,
      isError: readBoolean(source.is_error)
        ?? readBoolean(source.isError)
        ?? readBoolean(fallbackSource?.is_error)
        ?? readBoolean(fallbackSource?.isError)
        ?? false
    };
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

function parseToolUseInput(partialJson: string[], fallbackInput: unknown): unknown {
  const json = partialJson.join("").trim();
  if (!json) {
    return fallbackInput ?? {};
  }

  try {
    return JSON.parse(json);
  } catch {
    return fallbackInput ?? {};
  }
}
