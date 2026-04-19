import type { RuntimeSessionEvent } from "../../runtime-contracts.js";

export interface AcpEventMapperOptions {
  debug?: boolean;
  logDebug?: (message: string, details?: unknown) => void;
}

export class AcpEventMapper {
  private readonly options: AcpEventMapperOptions;

  private assistantMessageStarted = false;
  private assistantText = "";
  private readonly startedToolCallIds = new Set<string>();
  private readonly toolNameByCallId = new Map<string, string>();
  private readonly completedToolResults: unknown[] = [];

  constructor(options: AcpEventMapperOptions = {}) {
    this.options = options;
  }

  beginPrompt(): RuntimeSessionEvent[] {
    this.resetTurnState();

    return [
      { type: "agent_start" },
      { type: "turn_start" }
    ];
  }

  completePrompt(): RuntimeSessionEvent[] {
    const events: RuntimeSessionEvent[] = [];

    if (this.assistantMessageStarted) {
      events.push({
        type: "message_end",
        message: {
          role: "assistant",
          content: this.assistantText
        }
      });
    }

    events.push({
      type: "turn_end",
      toolResults: this.completedToolResults.map((result) => structuredClone(result))
    });
    events.push({ type: "agent_end" });

    this.resetTurnState();
    return events;
  }

  reset(): void {
    this.resetTurnState();
  }

  mapSessionUpdate(rawUpdate: unknown): RuntimeSessionEvent[] {
    const update = readObject(rawUpdate);
    if (!update) {
      this.debug("session_update:invalid", rawUpdate);
      return [];
    }

    const sessionUpdate = readString(update.sessionUpdate);
    switch (sessionUpdate) {
      case "agent_message_chunk":
        return this.mapAgentMessageChunk(update);

      case "agent_thought_chunk":
      case "session_info_update":
      case "available_commands_update":
      case "current_mode_update":
      case "plan":
        return [];

      case "tool_call":
        return this.mapToolCall(update);

      case "tool_call_update":
        return this.mapToolCallUpdate(update);

      default:
        this.debug("session_update:unrecognized", update);
        return [];
    }
  }

  private mapAgentMessageChunk(update: Record<string, unknown>): RuntimeSessionEvent[] {
    const content = readObject(update.content);
    const text = extractTextContent(content);
    if (text.length === 0) {
      return [];
    }

    const events: RuntimeSessionEvent[] = [];
    if (!this.assistantMessageStarted) {
      this.assistantMessageStarted = true;
      this.assistantText = "";
      events.push({
        type: "message_start",
        message: {
          role: "assistant",
          content: ""
        }
      });
    }

    this.assistantText += text;
    events.push({
      type: "message_update",
      message: {
        role: "assistant",
        content: this.assistantText
      }
    });

    return events;
  }

  private mapToolCall(update: Record<string, unknown>): RuntimeSessionEvent[] {
    const toolCallId = readString(update.toolCallId);
    if (!toolCallId) {
      this.debug("tool_call:missing_id", update);
      return [];
    }

    const toolName = resolveToolName(update);
    const args = "rawInput" in update ? update.rawInput : {};

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

  private mapToolCallUpdate(update: Record<string, unknown>): RuntimeSessionEvent[] {
    const toolCallId = readString(update.toolCallId);
    if (!toolCallId) {
      this.debug("tool_call_update:missing_id", update);
      return [];
    }

    const status = readString(update.status)?.toLowerCase();
    const toolName = this.toolNameByCallId.get(toolCallId) ?? "unknown";
    const events: RuntimeSessionEvent[] = [];

    if (status === "in_progress") {
      if ("rawOutput" in update) {
        events.push({
          type: "tool_execution_update",
          toolName,
          toolCallId,
          partialResult: update.rawOutput
        });
      }
      return events;
    }

    if (status === "completed") {
      const result = "rawOutput" in update
        ? update.rawOutput
        : "content" in update
          ? {
              status: "completed",
              content: update.content
            }
          : { status: "completed" };
      this.completedToolResults.push(result);
      this.startedToolCallIds.delete(toolCallId);
      this.toolNameByCallId.delete(toolCallId);

      events.push({
        type: "tool_execution_end",
        toolName,
        toolCallId,
        result,
        isError: inferToolError(result)
      });
      return events;
    }

    this.debug("tool_call_update:unrecognized_status", update);
    return [];
  }

  private resetTurnState(): void {
    this.assistantMessageStarted = false;
    this.assistantText = "";
    this.startedToolCallIds.clear();
    this.toolNameByCallId.clear();
    this.completedToolResults.length = 0;
  }

  private debug(message: string, details?: unknown): void {
    if (!this.options.debug) {
      return;
    }

    this.options.logDebug?.(message, details);
  }
}

function resolveToolName(update: Record<string, unknown>): string {
  const kind = readString(update.kind)?.trim().toLowerCase();
  const title = readString(update.title)?.trim();
  const rawInput = readObject(update.rawInput);

  const serverName =
    readString(rawInput?.serverName)
    ?? readString(rawInput?.server)
    ?? readString(rawInput?.mcpServer)
    ?? readString(rawInput?.mcpServerName);
  const explicitToolName =
    readString(rawInput?.toolName)
    ?? readString(rawInput?.tool)
    ?? readString(rawInput?.name)
    ?? readString(rawInput?.command);

  if (kind === "mcp" || serverName) {
    return `mcp:${normalizeToolToken(serverName ?? "unknown")}/${normalizeToolToken(explicitToolName ?? title ?? "unknown")}`;
  }

  const candidate = `${explicitToolName ?? ""} ${title ?? ""} ${kind ?? ""}`.toLowerCase();
  if (candidate.includes("read")) {
    return "read_file";
  }

  if (candidate.includes("edit")) {
    return "edit";
  }

  if (candidate.includes("write")) {
    return "write";
  }

  if (
    candidate.includes("execute")
    || candidate.includes("command")
    || candidate.includes("shell")
    || candidate.includes("terminal")
    || candidate.includes("bash")
    || candidate.includes("run")
  ) {
    return "execute";
  }

  return normalizeToolToken(explicitToolName ?? title ?? kind ?? "unknown");
}

function inferToolError(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }

  const maybe = result as {
    isError?: unknown;
    error?: unknown;
    success?: unknown;
    status?: unknown;
  };

  if (maybe.isError === true) {
    return true;
  }

  if (typeof maybe.error === "string" && maybe.error.trim().length > 0) {
    return true;
  }

  if (maybe.success === false) {
    return true;
  }

  const status = readString(maybe.status)?.toLowerCase();
  return status === "error" || status === "failed" || status === "declined" || status === "denied";
}

function extractTextContent(content: Record<string, unknown> | undefined): string {
  if (!content || content.type !== "text") {
    return "";
  }

  return typeof content.text === "string" ? content.text : "";
}

function normalizeToolToken(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return normalized.replace(/^_+|_+$/g, "") || "unknown";
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
