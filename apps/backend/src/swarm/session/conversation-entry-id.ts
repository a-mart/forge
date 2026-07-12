import type { ConversationEntryEvent } from "../types.js";

/** Pure, non-mutating compatibility hydration shared by replay and strict readers. */
export function backfillConversationMessageEntryId(
  entry: ConversationEntryEvent,
  wrapperEntryId: unknown,
): ConversationEntryEvent {
  if (entry.type !== "conversation_message" || (typeof entry.id === "string" && entry.id.trim().length > 0)) return entry;
  if (typeof wrapperEntryId !== "string" || wrapperEntryId.trim().length === 0) return entry;
  return { ...entry, id: wrapperEntryId };
}
