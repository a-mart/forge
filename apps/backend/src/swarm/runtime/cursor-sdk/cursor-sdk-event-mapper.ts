import type { RuntimeSessionEvent } from "../../runtime-contracts.js";

export interface CursorSdkEventMapperOptions {
  debug?: boolean;
  logDebug?: (message: string, details?: unknown) => void;
}

export class CursorSdkEventMapper {
  private readonly startedToolCallIds = new Set<string>();
  private readonly toolNameByCallId = new Map<string, string>();
  private readonly completedToolCallIds = new Set<string>();
  private readonly completedToolResults: unknown[] = [];

  private assistantMessageStarted = false;
  private assistantText = "";
  private terminalStatus: string | undefined;

  constructor(private readonly options: CursorSdkEventMapperOptions = {}) {}

  beginPrompt(): RuntimeSessionEvent[] {
    this.resetTurnState();
    return [{ type: "agent_start" }, { type: "turn_start" }];
  }

  completePrompt(): RuntimeSessionEvent[] {
    const events: RuntimeSessionEvent[] = [];
    if (this.assistantMessageStarted) {
      events.push({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: this.assistantText }]
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

  getTerminalStatus(): string | undefined {
    return this.terminalStatus;
  }

  mapSdkMessage(rawMessage: unknown): RuntimeSessionEvent[] {
    const message = readObject(rawMessage);
    if (!message) {
      this.debug("sdk_message:invalid", rawMessage);
      return [];
    }

    const type = readString(message.type);
    switch (type) {
      case "assistant":
        return this.mapAssistantMessage(message);
      case "tool_call":
        return this.mapToolCallMessage(message);
      case "status":
        return this.mapStatusMessage(message);
      case "thinking":
      case "system":
      case "user":
      case "request":
      case "task":
        return [];
      default:
        this.debug("sdk_message:unrecognized", message);
        return [];
    }
  }

  mapDelta(rawUpdate: unknown): RuntimeSessionEvent[] {
    const update = readObject(rawUpdate);
    if (!update) {
      this.debug("delta:invalid", rawUpdate);
      return [];
    }

    const type = readString(update.type);
    switch (type) {
      case "text-delta":
        return this.appendAssistantText(readString(update.text) ?? "");
      case "tool-call-started":
      case "partial-tool-call":
      case "tool-call-completed":
        return this.mapDeltaToolCall(update, type);
      case "thinking-delta":
      case "thinking-completed":
      case "summary":
      case "summary-started":
      case "summary-completed":
      case "user-message-appended":
      case "turn-ended":
        return [];
      default:
        this.debug("delta:unrecognized", update);
        return [];
    }
  }

  private mapAssistantMessage(message: Record<string, unknown>): RuntimeSessionEvent[] {
    const sdkMessage = readObject(message.message);
    const content = Array.isArray(sdkMessage?.content) ? sdkMessage.content : [];
    const events: RuntimeSessionEvent[] = [];
    const text = content.map((block) => readTextBlock(block)).join("");
    events.push(...this.appendAssistantText(text));

    for (const block of content) {
      const toolUseEvents = this.mapToolUseBlock(block);
      if (toolUseEvents.length > 0) {
        events.push(...toolUseEvents);
      }
    }

    return events;
  }

  private mapToolUseBlock(block: unknown): RuntimeSessionEvent[] {
    const toolUse = readObject(block);
    if (!toolUse || readString(toolUse.type) !== "tool_use") {
      return [];
    }

    const callId = readString(toolUse.id) ?? readString(toolUse.call_id) ?? readString(toolUse.callId);
    const rawToolName = readString(toolUse.name);
    if (!callId || !rawToolName) {
      this.debug("assistant_tool_use:missing_fields", toolUse);
      return [];
    }

    return this.mapToolCall({
      callId,
      toolName: normalizeCursorToolName(rawToolName),
      status: "running",
      args: toolUse.input ?? toolUse.args,
      result: undefined
    });
  }

  private appendAssistantText(text: string): RuntimeSessionEvent[] {
    if (!text) {
      return [];
    }

    const events: RuntimeSessionEvent[] = [];
    if (!this.assistantMessageStarted) {
      this.assistantMessageStarted = true;
      this.assistantText = "";
      events.push({
        type: "message_start",
        message: { role: "assistant", content: "" }
      });
    }

    this.assistantText += text;
    events.push({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: this.assistantText }]
      }
    });
    return events;
  }

  private mapToolCallMessage(message: Record<string, unknown>): RuntimeSessionEvent[] {
    const callId = readString(message.call_id);
    const toolName = readString(message.name);
    const status = readString(message.status);
    if (!callId || !toolName || !status) {
      this.debug("tool_call:missing_fields", message);
      return [];
    }

    return this.mapToolCall({
      callId,
      toolName: normalizeCursorToolName(toolName),
      status,
      args: message.args,
      result: message.result
    });
  }

  private mapDeltaToolCall(update: Record<string, unknown>, updateType: string): RuntimeSessionEvent[] {
    const toolCall = readObject(update.toolCall) ?? update;
    const callId = readString(update.callId) ?? readString(toolCall.callId) ?? readString(toolCall.id);
    const rawToolName = readString(toolCall.name) ?? readString(toolCall.type) ?? readString(update.name);
    if (!callId || !rawToolName) {
      this.debug("delta_tool_call:missing_fields", update);
      return [];
    }

    const status = readString(toolCall.status)
      ?? (updateType === "tool-call-completed" ? "completed" : "running");

    return this.mapToolCall({
      callId,
      toolName: normalizeCursorToolName(rawToolName),
      status,
      args: toolCall.args,
      result: toolCall.result ?? update.result
    });
  }

  private mapToolCall(input: {
    callId: string;
    toolName: string;
    status: string;
    args: unknown;
    result: unknown;
  }): RuntimeSessionEvent[] {
    const normalizedStatus = input.status.toLowerCase();
    const events: RuntimeSessionEvent[] = [];

    if (!this.startedToolCallIds.has(input.callId) && !this.completedToolCallIds.has(input.callId)) {
      this.startedToolCallIds.add(input.callId);
      this.toolNameByCallId.set(input.callId, input.toolName);
      events.push({
        type: "tool_execution_start",
        toolName: input.toolName,
        toolCallId: input.callId,
        args: input.args ?? {}
      });
    }

    if (normalizedStatus !== "completed" && normalizedStatus !== "error") {
      return events;
    }

    if (this.completedToolCallIds.has(input.callId)) {
      return events;
    }

    const result = input.result ?? { status: normalizedStatus };
    const toolName = this.toolNameByCallId.get(input.callId) ?? input.toolName;
    this.completedToolResults.push(result);
    this.completedToolCallIds.add(input.callId);
    this.startedToolCallIds.delete(input.callId);
    this.toolNameByCallId.delete(input.callId);
    events.push({
      type: "tool_execution_end",
      toolName,
      toolCallId: input.callId,
      result,
      isError: normalizedStatus === "error" || inferToolResultError(result)
    });
    return events;
  }

  private mapStatusMessage(message: Record<string, unknown>): RuntimeSessionEvent[] {
    const status = readString(message.status);
    if (status === "ERROR" || status === "CANCELLED" || status === "EXPIRED" || status === "FINISHED") {
      this.terminalStatus = status;
    }
    return [];
  }

  private resetTurnState(): void {
    this.startedToolCallIds.clear();
    this.toolNameByCallId.clear();
    this.completedToolCallIds.clear();
    this.completedToolResults.length = 0;
    this.assistantMessageStarted = false;
    this.assistantText = "";
    this.terminalStatus = undefined;
  }

  private debug(message: string, details?: unknown): void {
    if (!this.options.debug) {
      return;
    }

    this.options.logDebug?.(message, details);
  }
}

function normalizeCursorToolName(name: string): string {
  const normalized = name.trim();
  const lower = normalized.toLowerCase();
  if (lower === "shell" || lower.includes("shell") || lower.includes("terminal") || lower.includes("command")) {
    return "execute";
  }
  if (lower === "read" || lower.includes("read")) {
    return "read_file";
  }
  if (lower === "write" || lower.includes("write")) {
    return "write";
  }
  if (lower === "edit" || lower.includes("edit")) {
    return "edit";
  }
  if (lower.startsWith("mcp:")) {
    return normalized;
  }
  return normalized || "unknown";
}

function inferToolResultError(result: unknown): boolean {
  const object = readObject(result);
  if (!object) {
    return false;
  }

  if (object.isError === true || object.error !== undefined || object.success === false) {
    return true;
  }

  const status = readString(object.status)?.trim().toLowerCase();
  if (!status) {
    return false;
  }

  return ["error", "failed", "failure", "denied", "permission_denied", "rejected", "cancelled"].includes(status);
}

function readTextBlock(value: unknown): string {
  const block = readObject(value);
  if (!block || readString(block.type) !== "text") {
    return "";
  }
  return readString(block.text) ?? "";
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
