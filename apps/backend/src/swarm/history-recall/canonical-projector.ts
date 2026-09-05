import type { HistoryEntryKind } from "@forge/protocol";
import { CONVERSATION_ENTRY_TYPE } from "../session/conversation-timeline.js";
import {
  clipText,
  contentKeyForRecord,
  expandCodeTokens,
  isSecretToolName,
  MAX_INDEX_TEXT_CHARS,
  normalizeSearchText,
  redactStructuredValue,
  summarizeAttachments,
} from "./content-policy.js";
import {
  FORGE_CONTEXT_BOUNDARY_TYPE,
  INITIAL_WINDOW_ID,
  type ProjectedHistoryEntry,
  type ProjectionMode,
  type ProjectorState,
} from "./types.js";

export function createProjectorState(): ProjectorState {
  return {
    windowId: INITIAL_WINDOW_ID,
    seenContentKeys: new Map(),
  };
}

export function projectCanonicalLine(
  line: string,
  byteOffset: number,
  state: ProjectorState,
  mode: ProjectionMode = "index",
): ProjectedHistoryEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  const wrapperType = stringValue(parsed.type);
  if (wrapperType === "session" || wrapperType === "label" || wrapperType === "session_info"
    || wrapperType === "thinking_level_change" || wrapperType === "model_change") {
    return undefined;
  }

  if (wrapperType === "custom" && stringValue(parsed.customType) === FORGE_CONTEXT_BOUNDARY_TYPE) {
    const entryId = stringValue(parsed.id);
    if (entryId) {
      state.pendingBoundaryId = entryId;
    }
    return undefined;
  }

  if (wrapperType === "compaction") {
    return projectCompaction(parsed, byteOffset, state, mode);
  }

  if (wrapperType === "custom" && stringValue(parsed.customType) === CONVERSATION_ENTRY_TYPE) {
    return projectForgeConversationEntry(parsed, byteOffset, state, mode);
  }

  if (wrapperType === "message") {
    return projectNativeMessage(parsed, byteOffset, state, mode);
  }

  return undefined;
}

function projectCompaction(
  parsed: Record<string, unknown>,
  byteOffset: number,
  state: ProjectorState,
  mode: ProjectionMode,
): ProjectedHistoryEntry | undefined {
  const entryId = stringValue(parsed.id);
  if (!entryId) {
    return undefined;
  }
  const details = isRecord(parsed.details) ? parsed.details : undefined;
  const forgeContext = details && isRecord(details.forgeContext) ? details.forgeContext : undefined;
  const modeName = stringValue(forgeContext?.mode);
  const firstKeptEntryId = stringValue(parsed.firstKeptEntryId);
  if (firstKeptEntryId) {
    state.windowId = modeName === "fresh"
      ? `window:fresh:${entryId}`
      : `window:compact:${entryId}`;
  }
  state.pendingBoundaryId = undefined;

  const summary = finalizeText(rawString(parsed.summary) ?? "", mode);
  if (!summary) {
    return undefined;
  }
  return acceptProjected(state, {
    entryId,
    kind: "checkpoint",
    timestamp: stringValue(parsed.timestamp),
    windowId: state.windowId,
    text: summary,
    extra: mode === "index" ? expandCodeTokens(summary) : "",
    contentKey: contentKeyForRecord("checkpoint", undefined, undefined, summary, entryId),
    origin: "native",
    byteOffset,
    parentId: nullableString(parsed.parentId),
    retainsFromEntryId: firstKeptEntryId,
  }, mode);
}

function projectForgeConversationEntry(
  parsed: Record<string, unknown>,
  byteOffset: number,
  state: ProjectorState,
  mode: ProjectionMode,
): ProjectedHistoryEntry | undefined {
  const entryId = stringValue(parsed.id);
  const data = parsed.data;
  if (!entryId || !isRecord(data)) {
    return undefined;
  }
  const conversationType = stringValue(data.type);
  const timestamp = stringValue(data.timestamp) ?? stringValue(parsed.timestamp);
  const parentId = nullableString(parsed.parentId);

  if (conversationType === "conversation_message") {
    if (stringValue(data.role) === "system") {
      return undefined;
    }
    const role = asUserAssistantRole(data.role);
    const text = collectMessageText(data, mode);
    if (!text || !role) {
      return undefined;
    }
    return acceptProjected(state, makeEntry({
      entryId,
      kind: "message",
      role,
      timestamp,
      windowId: state.windowId,
      text,
      origin: "forge_custom",
      byteOffset,
      parentId,
      mode,
    }), mode);
  }

  if (conversationType === "agent_message") {
    const text = finalizeText(rawString(data.text) ?? "", mode);
    if (!text) {
      return undefined;
    }
    return acceptProjected(state, makeEntry({
      entryId,
      kind: "message",
      role: "user",
      timestamp,
      windowId: state.windowId,
      text,
      origin: "forge_custom",
      byteOffset,
      parentId,
      mode,
    }), mode);
  }

  if (conversationType === "agent_tool_call" || conversationType === "conversation_log") {
    const toolName = stringValue(data.toolName);
    if (isSecretToolName(toolName)) {
      return undefined;
    }
    const kind = conversationType === "agent_tool_call"
      ? mapToolKind(stringValue(data.kind), rawString(data.text))
      : mapLogKind(stringValue(data.kind));
    if (!kind) {
      return undefined;
    }
    const text = finalizeText(rawString(data.text) ?? "", mode);
    if (!text) {
      return undefined;
    }
    return acceptProjected(state, makeEntry({
      entryId,
      kind,
      toolName,
      timestamp,
      windowId: state.windowId,
      text,
      origin: "forge_custom",
      byteOffset,
      parentId,
      toolCallId: stringValue(data.toolCallId),
      mode,
    }), mode);
  }

  return undefined;
}

function projectNativeMessage(
  parsed: Record<string, unknown>,
  byteOffset: number,
  state: ProjectorState,
  mode: ProjectionMode,
): ProjectedHistoryEntry | undefined {
  const entryId = stringValue(parsed.id);
  const message = parsed.message;
  if (!entryId || !isRecord(message)) {
    return undefined;
  }
  const role = stringValue(message.role);
  if (role === "system") {
    return undefined;
  }
  const timestamp = isoTimestamp(message.timestamp) ?? stringValue(parsed.timestamp);
  const parentId = nullableString(parsed.parentId);
  const extracted = extractNativeContent(message.content, role, message, mode);
  if (!extracted || extracted.hidden) {
    return undefined;
  }
  if (isSecretToolName(extracted.toolName)) {
    return undefined;
  }
  const mappedKind = extracted.kind;
  const mappedRole = mappedKind === "message" ? asUserAssistantRole(role) : undefined;
  if (mappedKind === "message" && !mappedRole) {
    return undefined;
  }
  return acceptProjected(state, makeEntry({
    entryId,
    kind: mappedKind,
    role: mappedRole,
    toolName: extracted.toolName,
    timestamp,
    windowId: state.windowId,
    text: extracted.text,
    origin: "native",
    byteOffset,
    parentId,
    toolCallId: extracted.toolCallId,
    mode,
  }), mode);
}

function extractNativeContent(
  content: unknown,
  role: string | undefined,
  message: Record<string, unknown>,
  mode: ProjectionMode,
): { kind: HistoryEntryKind; text: string; toolName?: string; toolCallId?: string; hidden?: boolean } | undefined {
  if (role === "toolResult") {
    const text = extractRenderableText(content, mode);
    if (!text) {
      return undefined;
    }
    return {
      kind: "tool_result",
      text,
      toolName: stringValue(message.toolName) ?? stringValue(message.name),
      toolCallId: stringValue(message.toolCallId) ?? stringValue(message.id),
    };
  }

  if (typeof content === "string") {
    const text = finalizeText(content, mode);
    return text ? { kind: "message", text } : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts: string[] = [];
  let thinkingOnly = true;
  let toolCall: { name?: string; id?: string; args?: string } | undefined;
  let toolResult: { name?: string; id?: string; text?: string } | undefined;

  for (const item of content) {
    if (typeof item === "string") {
      thinkingOnly = false;
      textParts.push(item);
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    const itemType = stringValue(item.type);
    if (itemType === "thinking") {
      continue;
    }
    thinkingOnly = false;
    if (itemType === "text" || (!itemType && typeof item.text === "string")) {
      const text = rawString(item.text);
      if (text) {
        textParts.push(text);
      }
      continue;
    }
    if (itemType === "image" || itemType === "binary") {
      textParts.push(summarizeAttachments([item], mode === "read"));
      continue;
    }
    if (itemType === "toolCall" || itemType === "tool_call" || itemType === "functionCall" || itemType === "function_call") {
      toolCall = {
        name: stringValue(item.name) ?? stringValue(item.toolName),
        id: stringValue(item.id) ?? stringValue(item.toolCallId) ?? stringValue(item.callId),
        args: stringifyRedacted(item.arguments ?? item.input ?? item.args),
      };
      continue;
    }
    if (itemType === "toolResult" || itemType === "tool_result" || itemType === "functionResult" || itemType === "function_result") {
      toolResult = {
        name: stringValue(item.name) ?? stringValue(item.toolName),
        id: stringValue(item.id) ?? stringValue(item.toolCallId) ?? stringValue(item.callId),
        text: extractRenderableText(item.content ?? item.text ?? item.output, mode),
      };
    }
  }

  if (thinkingOnly && textParts.length === 0 && !toolCall && !toolResult) {
    return { kind: "message", text: "", hidden: true };
  }
  if (toolCall) {
    const text = finalizeText([toolCall.name, toolCall.args].filter(Boolean).join(mode === "read" ? "\n" : " "), mode);
    return text ? { kind: "tool_call", text, toolName: toolCall.name, toolCallId: toolCall.id } : undefined;
  }
  if (toolResult) {
    const text = finalizeText(toolResult.text ?? "", mode);
    return text ? { kind: "tool_result", text, toolName: toolResult.name, toolCallId: toolResult.id } : undefined;
  }
  const text = finalizeText(textParts.join("\n"), mode);
  return text ? { kind: "message", text } : undefined;
}

function extractRenderableText(content: unknown, mode: ProjectionMode): string {
  if (typeof content === "string") {
    return finalizeText(content, mode);
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (!isRecord(item)) {
        continue;
      }
      const itemType = stringValue(item.type);
      if (itemType === "thinking") {
        continue;
      }
      if (itemType === "text" || typeof item.text === "string") {
        const text = rawString(item.text);
        if (text) {
          parts.push(text);
        }
        continue;
      }
      if (itemType === "image" || itemType === "binary") {
        parts.push(summarizeAttachments([item], mode === "read"));
      }
    }
    return finalizeText(parts.join("\n"), mode);
  }
  if (isRecord(content)) {
    return finalizeText(stringifyRedacted(content), mode);
  }
  return "";
}

function collectMessageText(data: Record<string, unknown>, mode: ProjectionMode): string {
  const parts = [
    rawString(data.text) ?? "",
    summarizeAttachments(data.attachments, mode === "read"),
  ].filter(Boolean);
  return finalizeText(parts.join("\n"), mode);
}

function makeEntry(input: {
  entryId: string;
  kind: HistoryEntryKind;
  role?: "user" | "assistant";
  toolName?: string;
  timestamp?: string;
  windowId: string;
  text: string;
  origin: ProjectedHistoryEntry["origin"];
  byteOffset: number;
  parentId: string | null;
  toolCallId?: string;
  mode: ProjectionMode;
}): ProjectedHistoryEntry {
  return {
    entryId: input.entryId,
    kind: input.kind,
    role: input.role,
    toolName: input.toolName,
    timestamp: input.timestamp,
    windowId: input.windowId,
    text: input.text,
    extra: input.mode === "index" ? expandCodeTokens(input.text) : "",
    contentKey: contentKeyForRecord(input.kind, input.role, input.toolName, input.text, input.toolCallId),
    origin: input.origin,
    byteOffset: input.byteOffset,
    parentId: input.parentId,
  };
}

function acceptProjected(
  state: ProjectorState,
  entry: ProjectedHistoryEntry,
  mode: ProjectionMode,
): ProjectedHistoryEntry | undefined {
  if (mode === "read") {
    return entry;
  }
  const existing = state.seenContentKeys.get(entry.contentKey);
  if (existing) {
    if (existing.origin === "forge_custom" && entry.origin === "native") {
      return undefined;
    }
    if (existing.origin === "native" && entry.origin === "forge_custom") {
      state.seenContentKeys.set(entry.contentKey, { entryId: entry.entryId, origin: entry.origin });
      return { ...entry, replacesEntryId: existing.entryId };
    }
    return undefined;
  }
  state.seenContentKeys.set(entry.contentKey, { entryId: entry.entryId, origin: entry.origin });
  return entry;
}

function finalizeText(value: string, mode: ProjectionMode): string {
  if (mode === "read") {
    return value;
  }
  return clipText(normalizeSearchText(value), MAX_INDEX_TEXT_CHARS);
}

function mapToolKind(kind: string | undefined, text: string | undefined): HistoryEntryKind | undefined {
  if (kind === "tool_execution_start") {
    return "tool_call";
  }
  if (kind === "tool_execution_end") {
    return "tool_result";
  }
  if (kind === "tool_execution_update") {
    return text ? "tool_result" : undefined;
  }
  return undefined;
}

function mapLogKind(kind: string | undefined): HistoryEntryKind | undefined {
  if (kind === "tool_execution_start") {
    return "tool_call";
  }
  if (kind === "tool_execution_end" || kind === "tool_execution_update") {
    return "tool_result";
  }
  return undefined;
}

function stringifyRedacted(value: unknown): string {
  try {
    return JSON.stringify(redactStructuredValue(value)) ?? "";
  } catch {
    return "";
  }
}

function asUserAssistantRole(value: unknown): "user" | "assistant" | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function rawString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
