import type { ConversationEntryEvent } from "../types.js";
import { isCodexStreamDetailToolName } from "../codex-app-server/codex-app-server-event-normalizer.js";
import {
  collectKnownWorkerIds,
  inferManagerAliasIds,
  isProtectedManagerContextEntry
} from "@forge/protocol";

export const MAX_CONVERSATION_HISTORY = 2000;

export function shouldPersistConversationEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type === "conversation_log") {
    return false;
  }

  if (entry.type === "agent_tool_call") {
    if (entry.kind === "tool_execution_update") {
      return false;
    }

    if (isCodexStreamDetailToolName(entry.toolName)) {
      return false;
    }

    return true;
  }

  return true;
}

export function shouldWriteConversationHistoryCacheEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type === "agent_tool_call" && isCodexStreamDetailToolName(entry.toolName)) {
    return false;
  }

  return true;
}

export function isProtectedTranscriptEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type === "work_plan_created") {
    return true;
  }

  return isProtectedWebTranscriptEntry(entry);
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

  const channel = entry.sourceContext?.channel ?? "web";
  return channel === "web" || channel === "cli";
}

export function isProtectedManagerContextHistoryEntry(
  entry: ConversationEntryEvent,
  managerAliasIds: ReadonlySet<string>,
  knownWorkerIds: ReadonlySet<string>
): boolean {
  return isProtectedManagerContextEntry(entry, managerAliasIds, knownWorkerIds);
}

export function trimConversationHistory(
  entries: ConversationEntryEvent[],
  managerId?: string
): void {
  const overflow = entries.length - MAX_CONVERSATION_HISTORY;
  if (overflow <= 0) {
    return;
  }

  const knownWorkerIds = managerId ? inferKnownWorkerIdsFromHistory(entries, managerId) : new Set<string>();
  const managerAliasIds = managerId
    ? inferManagerAliasIds(entries, managerId, knownWorkerIds)
    : new Set<string>();

  const removableIndexes: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (removableIndexes.length >= overflow) {
      break;
    }

    const entry = entries[index];
    if (isProtectedTranscriptEntry(entry)) {
      continue;
    }

    if (
      managerId &&
      isProtectedManagerContextHistoryEntry(entry, managerAliasIds, knownWorkerIds)
    ) {
      continue;
    }

    removableIndexes.push(index);
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
  managerId?: string;
  requestedMessageCount?: number;
  includeDiagnosticEntries?: boolean;
  isWithinBudget: (messages: Entry[]) => boolean;
}): BootstrapConversationHistorySelection<Entry> {
  const {
    fullHistory,
    managerId,
    requestedMessageCount,
    includeDiagnosticEntries = true,
    isWithinBudget,
  } = options;
  const selectableHistory = includeDiagnosticEntries
    ? fullHistory
    : fullHistory.filter((entry) => !isBootstrapDiagnosticEntry(entry));
  const requestedHistory = requestedMessageCount !== undefined
    ? selectableHistory.slice(-requestedMessageCount)
    : selectableHistory;

  if (isWithinBudget(requestedHistory)) {
    return {
      history: requestedHistory,
      requestedHistoryLength: requestedHistory.length,
      trimmed: false
    };
  }

  const knownWorkerIds = managerId ? inferKnownWorkerIdsFromHistory(requestedHistory, managerId) : new Set<string>();
  const managerAliasIds = managerId
    ? inferManagerAliasIds(requestedHistory, managerId, knownWorkerIds)
    : new Set<string>();

  const conversationEntries = requestedHistory.filter(isBootstrapTranscriptEntry);
  const activityEntries = requestedHistory.filter(isBootstrapActivityEntry);
  const diagnosticEntries = requestedHistory.filter(isBootstrapDiagnosticEntry);
  const protectedActivityEntries = managerId
    ? activityEntries.filter((entry) =>
        isProtectedManagerContextHistoryEntry(entry, managerAliasIds, knownWorkerIds)
      )
    : [];
  const unprotectedActivityEntries = managerId
    ? activityEntries.filter(
        (entry) => !isProtectedManagerContextHistoryEntry(entry, managerAliasIds, knownWorkerIds)
      )
    : activityEntries;

  if (!isWithinBudget(conversationEntries)) {
    const trimmedConversationEntries = trimBootstrapConversationHistoryTailToBudget(conversationEntries, isWithinBudget);
    const history = appendBootstrapDiagnosticEntriesIfBudgetAllows(
      requestedHistory,
      trimmedConversationEntries,
      diagnosticEntries,
      isWithinBudget,
    );
    return {
      history,
      requestedHistoryLength: requestedHistory.length,
      trimmed: history.length !== requestedHistory.length,
    };
  }

  const selectedBootstrapEntries = selectBootstrapActivityEntriesWithinBudget(
    requestedHistory,
    conversationEntries,
    protectedActivityEntries,
    unprotectedActivityEntries,
    isWithinBudget
  );
  const trimmedHistory = mergeBootstrapConversationHistory(
    requestedHistory,
    selectedBootstrapEntries.conversationEntries,
    selectedBootstrapEntries.activityEntries
  );
  const history = appendBootstrapDiagnosticEntriesIfBudgetAllows(
    requestedHistory,
    trimmedHistory,
    diagnosticEntries,
    isWithinBudget,
  );

  return {
    history,
    requestedHistoryLength: requestedHistory.length,
    trimmed: history.length !== requestedHistory.length,
  };
}

function inferKnownWorkerIdsFromHistory(
  history: readonly ConversationEntryEvent[],
  managerId: string
): Set<string> {
  const workerIds = collectKnownWorkerIds([], managerId);

  for (const entry of history) {
    if (entry.type !== "agent_tool_call") {
      continue;
    }

    const agentId = entry.agentId.trim();
    const actorAgentId = entry.actorAgentId.trim();
    if (agentId === managerId && actorAgentId.length > 0 && actorAgentId !== agentId) {
      workerIds.add(actorAgentId);
    }
  }

  return workerIds;
}

interface BootstrapActivitySelection<Entry extends ConversationEntryEvent> {
  conversationEntries: Entry[];
  activityEntries: Entry[];
}

function selectBootstrapActivityEntriesWithinBudget<Entry extends ConversationEntryEvent>(
  sourceHistory: Entry[],
  conversationEntries: Entry[],
  protectedActivityEntries: Entry[],
  unprotectedActivityEntries: Entry[],
  isWithinBudget: (messages: Entry[]) => boolean
): BootstrapActivitySelection<Entry> {
  const buildHistory = (transcript: Entry[], activity: Entry[]) =>
    mergeBootstrapConversationHistory(sourceHistory, transcript, activity);

  let selectedConversation = conversationEntries;
  let selectedActivity = protectedActivityEntries;

  if (!isWithinBudget(buildHistory(selectedConversation, selectedActivity))) {
    selectedConversation = trimBootstrapConversationHistoryTailToBudget(
      conversationEntries,
      (candidateConversationEntries) =>
        isWithinBudget(buildHistory(candidateConversationEntries, protectedActivityEntries))
    );
    selectedActivity = protectedActivityEntries;

    if (!isWithinBudget(buildHistory(selectedConversation, selectedActivity))) {
      selectedActivity = trimBootstrapProtectedActivityPrefixToBudget(
        sourceHistory,
        selectedConversation,
        protectedActivityEntries,
        isWithinBudget
      );
    }
  } else if (unprotectedActivityEntries.length > 0) {
    let low = 0;
    let high = unprotectedActivityEntries.length;

    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      const candidateUnprotectedEntries = unprotectedActivityEntries.slice(-mid);
      const candidateHistory = buildHistory(selectedConversation, [
        ...protectedActivityEntries,
        ...candidateUnprotectedEntries
      ]);

      if (isWithinBudget(candidateHistory)) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    selectedActivity = [
      ...protectedActivityEntries,
      ...unprotectedActivityEntries.slice(unprotectedActivityEntries.length - low)
    ];
  }

  while (
    selectedActivity.length > 0 &&
    !isWithinBudget(buildHistory(selectedConversation, selectedActivity))
  ) {
    selectedActivity = selectedActivity.slice(0, -1);
  }

  while (
    selectedConversation.length > 0 &&
    !isWithinBudget(buildHistory(selectedConversation, selectedActivity))
  ) {
    selectedConversation = selectedConversation.slice(1);
  }

  return {
    conversationEntries: selectedConversation,
    activityEntries: selectedActivity
  };
}

function trimBootstrapProtectedActivityPrefixToBudget<Entry extends ConversationEntryEvent>(
  sourceHistory: Entry[],
  conversationEntries: Entry[],
  protectedActivityEntries: Entry[],
  isWithinBudget: (messages: Entry[]) => boolean
): Entry[] {
  if (protectedActivityEntries.length === 0) {
    return [];
  }

  let low = 0;
  let high = protectedActivityEntries.length;

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const candidateActivityEntries = protectedActivityEntries.slice(0, mid);
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

  return protectedActivityEntries.slice(0, low);
}

function isBootstrapTranscriptEntry<Entry extends ConversationEntryEvent>(entry: Entry): boolean {
  return (
    entry.type === "conversation_message" ||
    entry.type === "choice_request" ||
    entry.type === "work_plan_created"
  );
}

/** Hidden diagnostics — lowest bootstrap priority until header UI consumes them. */
function isBootstrapDiagnosticEntry<Entry extends ConversationEntryEvent>(entry: Entry): boolean {
  return entry.type === "model_cache_observation";
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

function appendBootstrapDiagnosticEntriesIfBudgetAllows<Entry extends ConversationEntryEvent>(
  sourceHistory: Entry[],
  primaryHistory: Entry[],
  diagnosticEntries: Entry[],
  isWithinBudget: (messages: Entry[]) => boolean
): Entry[] {
  if (diagnosticEntries.length === 0) {
    return primaryHistory;
  }

  const selectedDiagnostics = selectTailDiagnosticEntriesWithinBootstrapBudget(
    sourceHistory,
    primaryHistory,
    diagnosticEntries,
    isWithinBudget
  );
  if (selectedDiagnostics.length === 0) {
    return primaryHistory;
  }

  const selectedEntries = new Set<Entry>(primaryHistory);
  for (const entry of selectedDiagnostics) {
    selectedEntries.add(entry);
  }

  return sourceHistory.filter((entry) => selectedEntries.has(entry));
}

function selectTailDiagnosticEntriesWithinBootstrapBudget<Entry extends ConversationEntryEvent>(
  sourceHistory: Entry[],
  primaryHistory: Entry[],
  diagnosticEntries: Entry[],
  isWithinBudget: (messages: Entry[]) => boolean
): Entry[] {
  if (diagnosticEntries.length === 0) {
    return [];
  }

  let low = 0;
  let high = diagnosticEntries.length;

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const candidateDiagnostics = diagnosticEntries.slice(-mid);
    const selectedEntries = new Set<Entry>(primaryHistory);
    for (const entry of candidateDiagnostics) {
      selectedEntries.add(entry);
    }
    const candidateHistory = sourceHistory.filter((entry) => selectedEntries.has(entry));

    if (isWithinBudget(candidateHistory)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return diagnosticEntries.slice(diagnosticEntries.length - low);
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
