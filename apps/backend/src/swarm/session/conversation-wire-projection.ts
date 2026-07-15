import type { ConversationMessageAttachment } from "../types.js";
import type { ConversationEntryEvent } from "../types.js";
import { buildActivitySummary } from "./activity-summary.js";

export const MAX_CONVERSATION_WIRE_ENTRY_BYTES = 256 * 1024;
const MAX_WIRE_TEXT_BYTES = 64 * 1024;
const MAX_WIRE_ACTIVITY_TEXT_BYTES = 8 * 1024;
const OMITTED_RAW_ACTIVITY_TEXT = "[Raw activity payload omitted from Builder timeline.]";
const TRUNCATED_WIRE_TEXT_SUFFIX =
  "\n\n[Content truncated in timeline; the full entry remains in canonical session history.]";

/**
 * The single backend boundary for canonical/live Builder wire records. It
 * preserves event identity and semantics while removing inline binary bodies,
 * raw tool payloads, and other unbounded display fields.
 */
export function projectConversationEntryForBuilderWire(
  entry: ConversationEntryEvent,
): ConversationEntryEvent {
  const activitySummary =
    entry.type === "conversation_log" || entry.type === "agent_tool_call"
      ? buildActivitySummary(entry)
      : undefined;
  if (activitySummary) {
    return {
      ...activitySummary,
      ...(entry.timelineEntryId ? { timelineEntryId: `summary:${entry.timelineEntryId}` } : {}),
      ...(entry.timelineSequence !== undefined ? { timelineSequence: entry.timelineSequence } : {}),
    };
  }

  let projected: ConversationEntryEvent = entry;
  if (entry.type === "conversation_message") {
    projected = {
      ...entry,
      text: truncateUtf8(entry.text, MAX_WIRE_TEXT_BYTES),
      ...(entry.attachments
        ? { attachments: entry.attachments.map(projectAttachmentMetadata) }
        : {}),
      ...(entry.replyTo
        ? { replyTo: { ...entry.replyTo, text: truncateUtf8(entry.replyTo.text, MAX_WIRE_ACTIVITY_TEXT_BYTES) } }
        : {}),
      ...(entry.externalThreadContext
        ? {
            externalThreadContext: {
              ...entry.externalThreadContext,
              ...(entry.externalThreadContext.promptPreview
                ? { promptPreview: truncateUtf8(entry.externalThreadContext.promptPreview, MAX_WIRE_ACTIVITY_TEXT_BYTES) }
                : {}),
              ...(entry.externalThreadContext.resultPreview
                ? { resultPreview: truncateUtf8(entry.externalThreadContext.resultPreview, MAX_WIRE_ACTIVITY_TEXT_BYTES) }
                : {}),
            },
          }
        : {}),
    };
  } else if (entry.type === "conversation_log" || entry.type === "agent_tool_call") {
    projected = { ...entry, text: OMITTED_RAW_ACTIVITY_TEXT };
  } else if (entry.type === "agent_message") {
    projected = { ...entry, text: truncateUtf8(entry.text, MAX_WIRE_TEXT_BYTES) };
  }

  if (serializedBytes(projected) <= MAX_CONVERSATION_WIRE_ENTRY_BYTES) return projected;

  // Rare deeply nested legacy records can still exceed the page cap. Preserve
  // their event shape and identifiers while bounding strings/arrays instead of
  // silently dropping the canonical item.
  const bounded = boundUnknownValue(projected, 0) as ConversationEntryEvent;
  if (serializedBytes(bounded) <= MAX_CONVERSATION_WIRE_ENTRY_BYTES) return bounded;

  const timelineEntryId = entry.timelineEntryId ?? `oversized-wire-entry:${entry.agentId}:${entry.timestamp}`;
  return {
    type: "conversation_message",
    id: timelineEntryId,
    timelineEntryId,
    ...(entry.timelineSequence !== undefined ? { timelineSequence: entry.timelineSequence } : {}),
    agentId: entry.agentId,
    role: "system",
    text: "This history item is too large to display inline. The full entry remains in canonical session history.",
    timestamp: entry.timestamp,
    source: "system",
  };
}

function projectAttachmentMetadata(attachment: ConversationMessageAttachment) {
  const sizeBytes = "sizeBytes" in attachment && typeof attachment.sizeBytes === "number"
    ? attachment.sizeBytes
    : "text" in attachment && typeof attachment.text === "string"
      ? Buffer.byteLength(attachment.text, "utf8")
      : "data" in attachment && typeof attachment.data === "string"
        ? decodedBase64Bytes(attachment.data)
        : undefined;

  return {
    ...(attachment.type ? { type: attachment.type } : {}),
    mimeType: attachment.mimeType,
    ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
    ...(attachment.filePath ? { filePath: attachment.filePath } : {}),
    ...("fileRef" in attachment && attachment.fileRef ? { fileRef: attachment.fileRef } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(TRUNCATED_WIRE_TEXT_SUFFIX, "utf8");
  const prefix = Buffer.from(value, "utf8")
    .subarray(0, Math.max(0, maxBytes - suffixBytes))
    .toString("utf8")
    .replace(/\uFFFD+$/u, "");
  return `${prefix}${TRUNCATED_WIRE_TEXT_SUFFIX}`;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundUnknownValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return truncateUtf8(value, depth <= 1 ? 2048 : 512);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[Nested content omitted from timeline]";
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => boundUnknownValue(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, boundUnknownValue(item, depth + 1)]),
  );
}
