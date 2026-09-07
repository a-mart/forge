import { createHash } from "node:crypto";
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
  contextWindowIdForCompaction,
  INITIAL_WINDOW_ID,
  type ProjectedCanonicalRecord,
  type ProjectedHistoryEntry,
  type ProjectionMode,
  type ProjectorState,
} from "./types.js";

export function createProjectorState(options?: { provisional?: boolean; windowId?: string }): ProjectorState {
  return {
    windowId: options?.windowId ?? INITIAL_WINDOW_ID,
    seenContentKeys: new Map(),
    provisional: options?.provisional,
  };
}

export function projectCanonicalLine(
  line: string,
  byteOffset: number,
  state: ProjectorState,
  mode: ProjectionMode = "index",
): ProjectedHistoryEntry | undefined {
  const record = projectCanonicalRecord(line, byteOffset, state, mode);
  if (!record) {
    return undefined;
  }
  const combined = combineProjectedRecord(record);
  if (mode === "index" && combined.text.length > MAX_INDEX_TEXT_CHARS) {
    return {
      ...combined,
      text: clipText(combined.text, MAX_INDEX_TEXT_CHARS),
      extra: clipText(combined.extra, MAX_INDEX_TEXT_CHARS),
    };
  }
  return combined;
}

export function projectCanonicalRecord(
  line: string,
  byteOffset: number,
  state: ProjectorState,
  mode: ProjectionMode = "index",
): ProjectedCanonicalRecord | undefined {
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
    const entry = projectCompaction(parsed, byteOffset, state, mode);
    return entry ? recordFromParts([entry], mode) : undefined;
  }

  if (wrapperType === "custom" && stringValue(parsed.customType) === CONVERSATION_ENTRY_TYPE) {
    const entry = projectForgeConversationEntry(parsed, byteOffset, state, mode);
    return entry ? recordFromParts([entry], mode) : undefined;
  }

  if (wrapperType === "message") {
    return projectNativeMessage(parsed, byteOffset, state, mode);
  }

  return undefined;
}

export function combineProjectedRecord(record: ProjectedCanonicalRecord): ProjectedHistoryEntry {
  const [first, ...rest] = record.parts;
  if (!first || rest.length === 0) {
    return first ?? {
      entryId: record.entryId,
      partId: "message",
      chunkIndex: 0,
      kind: "message",
      windowId: record.windowId,
      text: "",
      extra: "",
      contentKey: contentKeyForRecord("message", undefined, undefined, "", record.entryId),
      origin: "native",
      byteOffset: 0,
      parentId: null,
    };
  }
  return {
    ...first,
    text: record.parts.map((part) => part.text).filter(Boolean).join(first.origin === "native" ? "\n" : "\n"),
    extra: record.parts.map((part) => part.extra).filter(Boolean).join("\n"),
    retainsFromEntryId: record.retainsFromEntryId ?? first.retainsFromEntryId,
  };
}

function recordFromParts(parts: ProjectedHistoryEntry[], mode: ProjectionMode = "index"): ProjectedCanonicalRecord | undefined {
  if (parts.length === 0) {
    return undefined;
  }
  const expanded = mode === "index"
    ? parts.flatMap((part) => chunkProjected(part, mode))
    : parts.map((part) => ({ ...part, chunkIndex: 0 }));
  return {
    entryId: expanded[0]!.entryId,
    windowId: expanded[0]!.windowId,
    parts: expanded,
    retainsFromEntryId: expanded[0]!.retainsFromEntryId,
  };
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
  if (!state.provisional) {
    if (firstKeptEntryId) {
      state.windowId = contextWindowIdForCompaction(entryId, modeName);
    }
    state.pendingBoundaryId = undefined;
  }

  const summary = finalizeText(rawString(parsed.summary) ?? "", mode);
  if (!summary) {
    return undefined;
  }
  return acceptProjected(state, makeEntry({
    entryId,
    partId: "checkpoint",
    kind: "checkpoint",
    timestamp: stringValue(parsed.timestamp),
    windowId: state.provisional ? unresolvedWindowId(state.windowId) : state.windowId,
    text: summary,
    origin: "native",
    byteOffset,
    parentId: nullableString(parsed.parentId),
    retainsFromEntryId: firstKeptEntryId,
    mode,
  }), mode);
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
  const windowId = projectionWindowId(state);

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
      partId: "message",
      kind: "message",
      role,
      timestamp,
      windowId,
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
      partId: "message",
      kind: "message",
      role: "user",
      timestamp,
      windowId,
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
    const toolCallId = stringValue(data.toolCallId);
    return acceptProjected(state, makeEntry({
      entryId,
      partId: partIdFor(kind, toolCallId, 0),
      kind,
      toolName,
      timestamp,
      windowId,
      text,
      origin: "forge_custom",
      byteOffset,
      parentId,
      toolCallId,
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
): ProjectedCanonicalRecord | undefined {
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
  const extracted = extractNativeParts(message.content, role, message, mode);
  if (extracted.hidden || extracted.parts.length === 0) {
    return undefined;
  }
  const windowId = projectionWindowId(state);
  const parts: ProjectedHistoryEntry[] = [];
  for (const [index, part] of extracted.parts.entries()) {
    if (isSecretToolName(part.toolName)) {
      continue;
    }
    const mappedRole = part.kind === "message" ? asUserAssistantRole(role) : undefined;
    if (part.kind === "message" && !mappedRole) {
      continue;
    }
    const projected = acceptProjected(state, makeEntry({
      entryId,
      partId: partIdFor(part.kind, part.toolCallId, index),
      kind: part.kind,
      role: mappedRole,
      toolName: part.toolName,
      timestamp,
      windowId,
      text: part.text,
      origin: "native",
      byteOffset,
      parentId,
      toolCallId: part.toolCallId,
      mode,
    }), mode);
    if (projected) {
      parts.push(projected);
    }
  }
  return recordFromParts(parts, mode);
}

function extractNativeParts(
  content: unknown,
  role: string | undefined,
  message: Record<string, unknown>,
  mode: ProjectionMode,
): { parts: Array<{ kind: HistoryEntryKind; text: string; toolName?: string; toolCallId?: string }>; hidden?: boolean } {
  if (role === "toolResult") {
    const text = extractRenderableText(content, mode);
    if (!text) {
      return { parts: [] };
    }
    return {
      parts: [{
        kind: "tool_result",
        text,
        toolName: stringValue(message.toolName) ?? stringValue(message.name),
        toolCallId: stringValue(message.toolCallId) ?? stringValue(message.id),
      }],
    };
  }

  if (typeof content === "string") {
    const text = finalizeText(content, mode);
    return text ? { parts: [{ kind: "message", text }] } : { parts: [] };
  }
  if (!Array.isArray(content)) {
    return { parts: [] };
  }

  const parts: Array<{ kind: HistoryEntryKind; text: string; toolName?: string; toolCallId?: string }> = [];
  const textParts: string[] = [];
  let thinkingOnly = true;

  const flushText = (): void => {
    if (textParts.length === 0) {
      return;
    }
    const text = finalizeText(textParts.join("\n"), mode);
    textParts.length = 0;
    if (text) {
      parts.push({ kind: "message", text });
    }
  };

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
      flushText();
      const toolCall = {
        name: stringValue(item.name) ?? stringValue(item.toolName),
        id: stringValue(item.id) ?? stringValue(item.toolCallId) ?? stringValue(item.callId),
        args: stringifyRedacted(item.arguments ?? item.input ?? item.args),
      };
      const text = finalizeText([toolCall.name, toolCall.args].filter(Boolean).join(mode === "read" ? "\n" : " "), mode);
      if (text) {
        parts.push({ kind: "tool_call", text, toolName: toolCall.name, toolCallId: toolCall.id });
      }
      continue;
    }
    if (itemType === "toolResult" || itemType === "tool_result" || itemType === "functionResult" || itemType === "function_result") {
      flushText();
      const toolResult = {
        name: stringValue(item.name) ?? stringValue(item.toolName),
        id: stringValue(item.id) ?? stringValue(item.toolCallId) ?? stringValue(item.callId),
        text: extractRenderableText(item.content ?? item.text ?? item.output, mode),
      };
      const text = finalizeText(toolResult.text ?? "", mode);
      if (text) {
        parts.push({ kind: "tool_result", text, toolName: toolResult.name, toolCallId: toolResult.id });
      }
    }
  }
  flushText();

  if (thinkingOnly && parts.length === 0) {
    return { parts: [], hidden: true };
  }
  return { parts };
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
  partId: string;
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
  retainsFromEntryId?: string;
  mode: ProjectionMode;
}): ProjectedHistoryEntry {
  return {
    entryId: input.entryId,
    partId: input.partId,
    chunkIndex: 0,
    kind: input.kind,
    role: input.role,
    toolName: input.toolName,
    timestamp: input.timestamp,
    windowId: input.windowId,
    text: input.text,
    extra: input.mode === "index" ? expandCodeTokens(input.text) : "",
    contentKey: contentKeyForRecord(input.kind, input.role, input.toolName, input.text, input.toolCallId ?? input.partId),
    origin: input.origin,
    byteOffset: input.byteOffset,
    parentId: input.parentId,
    retainsFromEntryId: input.retainsFromEntryId,
    provisional: undefined,
  };
}

function chunkProjected(entry: ProjectedHistoryEntry, mode: ProjectionMode): ProjectedHistoryEntry[] {
  if (mode !== "index" || entry.text.length <= MAX_INDEX_TEXT_CHARS) {
    return [{ ...entry, chunkIndex: 0 }];
  }
  const chunks: ProjectedHistoryEntry[] = [];
  const maxChunks = Math.ceil(entry.text.length / MAX_INDEX_TEXT_CHARS);
  for (let index = 0; index < maxChunks; index += 1) {
    const start = index * MAX_INDEX_TEXT_CHARS;
    // Cover the maximum accepted query across the chunk seam; canonical rows already bound total work.
    const text = entry.text.slice(start, start + MAX_INDEX_TEXT_CHARS + 2000);
    chunks.push({
      ...entry,
      chunkIndex: index,
      text,
      extra: expandCodeTokens(text),
      contentKey: `${entry.contentKey}:chunk:${index}`,
    });
  }
  return chunks;
}

function acceptProjected(
  state: ProjectorState,
  entry: ProjectedHistoryEntry,
  mode: ProjectionMode,
): ProjectedHistoryEntry | undefined {
  const stamped = {
    ...entry,
    provisional: state.provisional || undefined,
    windowId: state.provisional ? unresolvedWindowId(entry.windowId) : entry.windowId,
  };
  if (mode === "read") {
    return stamped;
  }
  if (state.provisional) {
    return stamped;
  }
  const textHash = createHash("sha256").update(entry.text, "utf16le").digest("hex");
  const existing = state.seenContentKeys.get(entry.contentKey);
  // Only pair adjacent projected mirror occurrences. Repeated text is not an
  // identity: preserve later messages, other windows, and every checkpoint.
  state.seenContentKeys.clear();
  if (entry.kind === "checkpoint") return stamped;
  const sameOccurrence = existing && existing.origin !== entry.origin
    && existing.windowId === entry.windowId && existing.textHash === textHash
    && (entry.kind !== "message" || (entry.timestamp !== undefined && entry.timestamp === existing.timestamp));
  if (sameOccurrence) {
    return entry.origin === "native" ? undefined : { ...stamped, replacesEntryId: existing.entryId };
  }
  state.seenContentKeys.set(entry.contentKey, {
    entryId: entry.entryId, origin: entry.origin, textHash,
    windowId: entry.windowId, timestamp: entry.timestamp,
  });
  return stamped;
}

function finalizeText(value: string, mode: ProjectionMode): string {
  if (mode === "read") {
    return value;
  }
  return normalizeSearchText(value);
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
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
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

function partIdFor(kind: HistoryEntryKind, toolCallId: string | undefined, index: number): string {
  if (kind === "message") {
    return index === 0 ? "message" : `message:${index}`;
  }
  if (kind === "checkpoint") {
    return "checkpoint";
  }
  const prefix = kind === "tool_call" ? "toolCall" : "toolResult";
  return toolCallId ? `${prefix}:${toolCallId}` : `${prefix}:${index}`;
}

function projectionWindowId(state: ProjectorState): string {
  return state.provisional ? unresolvedWindowId(state.windowId) : state.windowId;
}

function unresolvedWindowId(windowId: string): string {
  return windowId.startsWith("window:provisional") ? windowId : "window:provisional";
}

export function isProvisionalWindowId(windowId: string): boolean {
  return windowId === "window:provisional" || windowId.startsWith("window:provisional:");
}
