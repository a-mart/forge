import { CONVERSATION_ENTRY_TYPE } from "../../../session/conversation-timeline.js";
import { FORGE_CONTEXT_BOUNDARY_TYPE } from "../../../history-recall/types.js";

export function sessionHeader(id: string, cwd: string, timestamp: string): string {
  return JSON.stringify({
    type: "session",
    id,
    version: 3,
    timestamp,
    cwd,
  });
}

export function nativeMessage(
  id: string,
  message: Record<string, unknown>,
  timestamp: string,
  parentId: string | null = null,
): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp,
    message,
  });
}

export function nativeUser(id: string, text: string, timestamp: string, parentId: string | null = null): string {
  return nativeMessage(id, { role: "user", content: [{ type: "text", text }] }, timestamp, parentId);
}

export function nativeAssistant(id: string, text: string, timestamp: string, parentId: string | null = null): string {
  return nativeMessage(id, { role: "assistant", content: [{ type: "text", text }] }, timestamp, parentId);
}

export function conversation(
  id: string,
  data: Record<string, unknown>,
  timestamp: string,
  parentId: string | null = null,
): string {
  return JSON.stringify({
    type: "custom",
    customType: CONVERSATION_ENTRY_TYPE,
    id,
    parentId,
    timestamp,
    data: { timestamp, ...data },
  });
}

export function conversationMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  timestamp: string,
  parentId: string | null = null,
): string {
  return conversation(id, { type: "conversation_message", role, text }, timestamp, parentId);
}

export function agentToolCall(
  id: string,
  kind: "tool_execution_start" | "tool_execution_end",
  toolName: string,
  toolCallId: string,
  text: string,
  timestamp: string,
): string {
  return conversation(id, {
    type: "agent_tool_call",
    kind,
    toolName,
    toolCallId,
    text,
  }, timestamp);
}

export function contextBoundary(id: string, mode: "fresh" | "summary"): string {
  return JSON.stringify({
    type: "custom",
    customType: FORGE_CONTEXT_BOUNDARY_TYPE,
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: { mode },
  });
}

export function compaction(
  id: string,
  firstKeptEntryId: string,
  summary: string,
  timestamp: string,
  mode?: "fresh" | "summary",
): string {
  return JSON.stringify({
    type: "compaction",
    id,
    parentId: null,
    timestamp,
    summary,
    firstKeptEntryId,
    tokensBefore: 10,
    ...(mode ? { details: { forgeContext: { mode } } } : {}),
  });
}

export function fillerUser(id: string, needle: string, timestamp: string, padChars: number): string {
  return nativeUser(id, `${needle} ${"x".repeat(Math.max(0, padChars))}`, timestamp);
}

export function joinJsonl(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}
