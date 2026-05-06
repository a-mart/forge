import type { ConversationEntryEvent } from "../types.js";

export function applyPinOverlay(
  entries: ConversationEntryEvent[],
  pinnedMessageIds?: ReadonlySet<string>
): void {
  for (const entry of entries) {
    if (entry.type !== "conversation_message") {
      continue;
    }

    if (entry.id && pinnedMessageIds?.has(entry.id)) {
      entry.pinned = true;
    } else {
      delete entry.pinned;
    }
  }
}

export function setPinnedFlagInMemory(
  entries: ConversationEntryEvent[],
  messageId: string,
  pinned: boolean
): void {
  for (const entry of entries) {
    if (entry.type !== "conversation_message" || entry.id !== messageId) {
      continue;
    }

    if (pinned) {
      entry.pinned = true;
    } else {
      delete entry.pinned;
    }
  }
}
