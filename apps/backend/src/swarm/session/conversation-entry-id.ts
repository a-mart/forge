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

/** Pure compatibility hydration for canonical identity/order on legacy rows. */
export function backfillConversationTimelineMetadata(
  entry: ConversationEntryEvent,
  wrapperEntryId: unknown,
  timelineSequence: number,
): ConversationEntryEvent {
  const timelineEntryId = typeof entry.timelineEntryId === "string" && entry.timelineEntryId.trim().length > 0
    ? entry.timelineEntryId
    : typeof wrapperEntryId === "string" && wrapperEntryId.trim().length > 0
      ? wrapperEntryId
      : undefined;
  const resolvedSequence = Number.isSafeInteger(entry.timelineSequence) && (entry.timelineSequence ?? -1) >= 0
    ? entry.timelineSequence
    : timelineSequence;

  if (timelineEntryId === entry.timelineEntryId && resolvedSequence === entry.timelineSequence) return entry;
  return {
    ...entry,
    ...(timelineEntryId ? { timelineEntryId } : {}),
    timelineSequence: resolvedSequence,
  };
}
