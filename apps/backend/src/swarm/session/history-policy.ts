import type { ConversationEntryEvent } from "../types.js";

export const MAX_CONVERSATION_HISTORY = 2000;

export function shouldPersistConversationEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type === "conversation_log") {
    return false;
  }

  if (entry.type === "agent_tool_call") {
    return entry.kind !== "tool_execution_update";
  }

  return true;
}

export function isProtectedWebTranscriptEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type !== "conversation_message") {
    return false;
  }

  if (entry.source === "project_agent_input") {
    return true;
  }

  if (entry.source !== "user_input" && entry.source !== "speak_to_user") {
    return false;
  }

  return (entry.sourceContext?.channel ?? "web") === "web";
}

export function trimConversationHistory(entries: ConversationEntryEvent[]): void {
  const overflow = entries.length - MAX_CONVERSATION_HISTORY;
  if (overflow <= 0) {
    return;
  }

  const removableIndexes: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (removableIndexes.length >= overflow) {
      break;
    }

    if (!isProtectedWebTranscriptEntry(entries[index])) {
      removableIndexes.push(index);
    }
  }

  if (removableIndexes.length === 0) {
    return;
  }

  for (let index = removableIndexes.length - 1; index >= 0; index -= 1) {
    entries.splice(removableIndexes[index], 1);
  }
}

export interface BootstrapConversationHistorySelection<Entry extends ConversationEntryEvent = ConversationEntryEvent> {
  history: Entry[];
  requestedHistoryLength: number;
  trimmed: boolean;
}

export function selectBootstrapConversationHistory<Entry extends ConversationEntryEvent>(options: {
  fullHistory: Entry[];
  requestedMessageCount?: number;
  isWithinBudget: (messages: Entry[]) => boolean;
}): BootstrapConversationHistorySelection<Entry> {
  const { fullHistory, requestedMessageCount, isWithinBudget } = options;
  const requestedHistory = requestedMessageCount !== undefined
    ? fullHistory.slice(-requestedMessageCount)
    : fullHistory;

  if (isWithinBudget(requestedHistory)) {
    return {
      history: requestedHistory,
      requestedHistoryLength: requestedHistory.length,
      trimmed: false
    };
  }

  const conversationEntries = requestedHistory.filter(isBootstrapTranscriptEntry);
  const activityEntries = requestedHistory.filter(isBootstrapActivityEntry);

  if (!isWithinBudget(conversationEntries)) {
    const trimmedConversationEntries = trimBootstrapConversationHistoryTailToBudget(conversationEntries, isWithinBudget);
    return {
      history: trimmedConversationEntries,
      requestedHistoryLength: requestedHistory.length,
      trimmed: trimmedConversationEntries.length !== requestedHistory.length
    };
  }

  const selectedActivityEntries = selectTailActivityEntriesWithinBootstrapBudget(
    requestedHistory,
    conversationEntries,
    activityEntries,
    isWithinBudget
  );
  const trimmedHistory = mergeBootstrapConversationHistory(
    requestedHistory,
    conversationEntries,
    selectedActivityEntries
  );

  return {
    history: trimmedHistory,
    requestedHistoryLength: requestedHistory.length,
    trimmed: trimmedHistory.length !== requestedHistory.length
  };
}

function isBootstrapTranscriptEntry<Entry extends ConversationEntryEvent>(entry: Entry): boolean {
  return (
    entry.type === "conversation_message" ||
    entry.type === "conversation_log" ||
    entry.type === "choice_request"
  );
}

function isBootstrapActivityEntry<Entry extends ConversationEntryEvent>(entry: Entry): boolean {
  return entry.type === "agent_message" || entry.type === "agent_tool_call";
}

function trimBootstrapConversationHistoryTailToBudget<Entry extends ConversationEntryEvent>(
  history: Entry[],
  isWithinBudget: (messages: Entry[]) => boolean
): Entry[] {
  let low = 0;
  let high = history.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = history.slice(mid);

    if (isWithinBudget(candidate)) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return history.slice(low);
}

function selectTailActivityEntriesWithinBootstrapBudget<Entry extends ConversationEntryEvent>(
  sourceHistory: Entry[],
  conversationEntries: Entry[],
  activityEntries: Entry[],
  isWithinBudget: (messages: Entry[]) => boolean
): Entry[] {
  if (activityEntries.length === 0) {
    return [];
  }

  let low = 0;
  let high = activityEntries.length;

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const candidateActivityEntries = activityEntries.slice(-mid);
    const candidateHistory = mergeBootstrapConversationHistory(
      sourceHistory,
      conversationEntries,
      candidateActivityEntries
    );

    if (isWithinBudget(candidateHistory)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return activityEntries.slice(-low);
}

function mergeBootstrapConversationHistory<Entry extends ConversationEntryEvent>(
  sourceHistory: Entry[],
  conversationEntries: Entry[],
  activityEntries: Entry[]
): Entry[] {
  if (conversationEntries.length === 0) {
    return activityEntries;
  }

  if (activityEntries.length === 0) {
    return conversationEntries;
  }

  const selectedEntries = new Set<Entry>();
  for (const entry of conversationEntries) {
    selectedEntries.add(entry);
  }
  for (const entry of activityEntries) {
    selectedEntries.add(entry);
  }

  return sourceHistory.filter((entry) => selectedEntries.has(entry));
}
