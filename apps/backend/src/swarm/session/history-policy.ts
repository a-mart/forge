import type { ChoiceRequestEvent, ConversationEntryEvent } from "../types.js";
import { isCodexStreamDetailToolName } from "../codex-app-server/codex-app-server-event-normalizer.js";
import {
  collectKnownWorkerIds,
  inferManagerAliasIds,
  isProtectedManagerContextEntry,
  normalizePlanSummaryEntries,
  isUserVisibleAssistantConversationMessage
} from "@forge/protocol";

export const MAX_CONVERSATION_HISTORY = 2000;

export function shouldPersistConversationEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type === "conversation_log") {
    if (entry.kind !== "tool_execution_start") {
      return false;
    }

    return !isCodexStreamDetailToolName(entry.toolName);
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
  return isProtectedWebTranscriptEntry(entry);
}

export function isProtectedWebTranscriptEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type !== "conversation_message") {
    return false;
  }

  if (entry.source === "project_agent_input") {
    return true;
  }

  if (entry.source === "worker_report") {
    return true;
  }

  if (entry.source !== "user_input" && !isUserVisibleAssistantConversationMessage(entry)) {
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
  managerId?: string,
  options: { normalizePlanSummaries?: boolean } = {}
): void {
  if (options.normalizePlanSummaries !== false) {
    const normalizedEntries = normalizePlanSummaryEntries(entries);
    if (
      normalizedEntries.length !== entries.length ||
      normalizedEntries.some((entry, index) => entry !== entries[index])
    ) {
      entries.splice(0, entries.length, ...normalizedEntries);
    }
  }

  const overflow = entries.length - MAX_CONVERSATION_HISTORY;
  if (overflow <= 0) {
    return;
  }

  const knownWorkerIds = managerId ? inferKnownWorkerIdsFromHistory(entries, managerId) : new Set<string>();
  const managerAliasIds = managerId
    ? inferManagerAliasIds(entries, managerId, knownWorkerIds)
    : new Set<string>();

  const removableIndexes = collectRetentionTrimIndexes(
    entries,
    overflow,
    managerAliasIds,
    knownWorkerIds,
    Boolean(managerId),
    collectLatestPendingChoiceIds(entries)
  );
  if (removableIndexes.length === 0) {
    return;
  }

  for (let index = removableIndexes.length - 1; index >= 0; index -= 1) {
    entries.splice(removableIndexes[index], 1);
  }
}

function collectRetentionTrimIndexes(
  entries: ConversationEntryEvent[],
  overflow: number,
  managerAliasIds: ReadonlySet<string>,
  knownWorkerIds: ReadonlySet<string>,
  hasManagerContext: boolean,
  activePendingChoiceIds: ReadonlySet<string>
): number[] {
  const removableIndexes: number[] = [];
  const addTier = (
    predicate: (entry: ConversationEntryEvent) => boolean,
    allowAuthoritativeActivePlan = false
  ) => {
    for (let index = 0; index < entries.length && removableIndexes.length < overflow; index += 1) {
      if (removableIndexes.includes(index)) {
        continue;
      }

      if (
        !allowAuthoritativeActivePlan &&
        isAuthoritativeActivePlanSummaryEntry(entries[index])
      ) {
        continue;
      }

      if (predicate(entries[index])) {
        removableIndexes.push(index);
      }
    }
  };

  addTier((entry) =>
    !isActivePendingChoiceRequestEntry(entry, activePendingChoiceIds) &&
    !isAnsweredOrCancelledChoiceRequestEntry(entry) &&
    !isProtectedTranscriptEntry(entry) &&
    !(hasManagerContext && isProtectedManagerContextHistoryEntry(entry, managerAliasIds, knownWorkerIds))
  );

  addTier((entry) =>
    !isActivePendingChoiceRequestEntry(entry, activePendingChoiceIds) &&
    hasManagerContext &&
    isProtectedManagerContextHistoryEntry(entry, managerAliasIds, knownWorkerIds)
  );

  addTier(isAnsweredOrCancelledChoiceRequestEntry);
  addTier((entry) => isProtectedTranscriptEntry(entry) && !isChoiceRequestEntry(entry));
  addTier((entry) => isActivePendingChoiceRequestEntry(entry, activePendingChoiceIds));
  addTier(isAuthoritativeActivePlanSummaryEntry, true);

  return removableIndexes;
}

export interface BootstrapConversationHistorySelection<Entry extends ConversationEntryEvent = ConversationEntryEvent> {
  history: Entry[];
  requestedHistoryLength: number;
  trimmed: boolean;
}

export function selectBootstrapConversationHistory(options: {
  fullHistory: ConversationEntryEvent[];
  managerId?: string;
  requestedMessageCount?: number;
  pendingChoiceRequests?: ChoiceRequestEvent[];
  includeDiagnosticEntries?: boolean;
  isWithinBudget: (messages: ConversationEntryEvent[]) => boolean;
}): BootstrapConversationHistorySelection {
  const {
    fullHistory,
    managerId,
    requestedMessageCount,
    pendingChoiceRequests = [],
    includeDiagnosticEntries = true,
    isWithinBudget,
  } = options;
  const normalizedHistory = normalizePlanSummaryEntries(fullHistory);
  const selectableHistory = includeDiagnosticEntries
    ? normalizedHistory
    : normalizedHistory.filter((entry) => !isBootstrapDiagnosticEntry(entry));
  const countedHistory = requestedMessageCount !== undefined
    ? retainAuthoritativeActivePlanSummary(
        selectableHistory.slice(-requestedMessageCount),
        selectableHistory
      )
    : selectableHistory;
  const requestedHistory = upsertPendingChoiceRequests(countedHistory, pendingChoiceRequests);

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
  const activePendingChoiceIds = collectLatestPendingChoiceIds(requestedHistory);

  const pendingChoiceEntries = requestedHistory.filter((entry) =>
    isActivePendingChoiceRequestEntry(entry, activePendingChoiceIds)
  );
  const activePlanSummaryEntries = requestedHistory.filter(isAuthoritativeActivePlanSummaryEntry);
  const stalePendingChoiceEntries = requestedHistory.filter((entry) =>
    isStalePendingChoiceRequestEntry(entry, activePendingChoiceIds)
  );
  const visibleTranscriptEntries = requestedHistory.filter(
    (entry) => !isChoiceRequestEntry(entry) && isProtectedTranscriptEntry(entry)
  );
  const remainingTranscriptEntries = requestedHistory.filter(
    (entry) =>
      isBootstrapTranscriptEntry(entry) &&
      !isActivePendingChoiceRequestEntry(entry, activePendingChoiceIds) &&
      !isStalePendingChoiceRequestEntry(entry, activePendingChoiceIds) &&
      !isAuthoritativeActivePlanSummaryEntry(entry) &&
      !isProtectedTranscriptEntry(entry)
  );
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

  const selectedTranscriptEntries = selectBootstrapTranscriptEntriesWithinBudget(
    requestedHistory,
    [...pendingChoiceEntries, ...activePlanSummaryEntries],
    visibleTranscriptEntries,
    remainingTranscriptEntries,
    isWithinBudget
  );
  const selectedActivityEntries = selectBootstrapEntriesWithinBudget(
    requestedHistory,
    selectedTranscriptEntries,
    protectedActivityEntries,
    isWithinBudget
  );
  const selectedUnprotectedActivityEntries = selectBootstrapEntriesWithinBudget(
    requestedHistory,
    [...selectedTranscriptEntries, ...selectedActivityEntries],
    unprotectedActivityEntries,
    isWithinBudget
  );
  const selectedStalePendingChoiceEntries = selectBootstrapEntriesWithinBudget(
    requestedHistory,
    [...selectedTranscriptEntries, ...selectedActivityEntries, ...selectedUnprotectedActivityEntries],
    stalePendingChoiceEntries,
    isWithinBudget
  );
  const primaryHistory = mergeBootstrapConversationHistory(
    requestedHistory,
    selectedTranscriptEntries,
    [...selectedActivityEntries, ...selectedUnprotectedActivityEntries, ...selectedStalePendingChoiceEntries]
  );
  const history = appendBootstrapDiagnosticEntriesIfBudgetAllows(
    requestedHistory,
    primaryHistory,
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

function upsertPendingChoiceRequests(
  countedHistory: ConversationEntryEvent[],
  pendingChoiceRequests: ChoiceRequestEvent[]
): ConversationEntryEvent[] {
  if (pendingChoiceRequests.length === 0) {
    return countedHistory;
  }

  const pendingByChoiceId = new Map<string, ChoiceRequestEvent>();
  for (const pendingChoice of pendingChoiceRequests) {
    const choiceId = pendingChoice.choiceId.trim();
    if (choiceId.length === 0) {
      continue;
    }
    pendingByChoiceId.set(choiceId, pendingChoice);
  }

  if (pendingByChoiceId.size === 0) {
    return countedHistory;
  }

  const upsertedHistory: ConversationEntryEvent[] = [];
  const seenChoiceIds = new Set<string>();
  for (const entry of countedHistory) {
    if (entry.type !== "choice_request") {
      upsertedHistory.push(entry);
      continue;
    }

    const choiceId = entry.choiceId.trim();
    const pendingChoice = pendingByChoiceId.get(choiceId);
    if (!pendingChoice) {
      upsertedHistory.push(entry);
      continue;
    }

    if (seenChoiceIds.has(choiceId)) {
      continue;
    }

    upsertedHistory.push(pendingChoice);
    seenChoiceIds.add(choiceId);
  }

  for (const pendingChoice of pendingByChoiceId.values()) {
    if (!seenChoiceIds.has(pendingChoice.choiceId.trim())) {
      upsertedHistory.push(pendingChoice);
    }
  }

  return upsertedHistory;
}

function selectBootstrapTranscriptEntriesWithinBudget(
  sourceHistory: ConversationEntryEvent[],
  pendingChoiceEntries: ConversationEntryEvent[],
  visibleTranscriptEntries: ConversationEntryEvent[],
  remainingTranscriptEntries: ConversationEntryEvent[],
  isWithinBudget: (messages: ConversationEntryEvent[]) => boolean
): ConversationEntryEvent[] {
  const pendingEntries = isWithinBudget(pendingChoiceEntries)
    ? pendingChoiceEntries
    : selectBootstrapEntriesWithinBudget(sourceHistory, [], pendingChoiceEntries, isWithinBudget);

  const pendingAndVisibleEntries = mergeBootstrapConversationHistory(
    sourceHistory,
    pendingEntries,
    visibleTranscriptEntries
  );
  if (!isWithinBudget(pendingAndVisibleEntries)) {
    const selectedVisibleEntries = selectBootstrapEntriesWithinBudget(
      sourceHistory,
      pendingEntries,
      visibleTranscriptEntries,
      isWithinBudget
    );
    return mergeBootstrapConversationHistory(sourceHistory, pendingEntries, selectedVisibleEntries);
  }

  const allTranscriptEntries = mergeBootstrapConversationHistory(
    sourceHistory,
    pendingAndVisibleEntries,
    remainingTranscriptEntries
  );
  if (isWithinBudget(allTranscriptEntries)) {
    return allTranscriptEntries;
  }

  const selectedRemainingTranscriptEntries = selectBootstrapEntriesWithinBudget(
    sourceHistory,
    pendingAndVisibleEntries,
    remainingTranscriptEntries,
    isWithinBudget
  );
  return mergeBootstrapConversationHistory(
    sourceHistory,
    pendingAndVisibleEntries,
    selectedRemainingTranscriptEntries
  );
}

function selectBootstrapEntriesWithinBudget(
  sourceHistory: ConversationEntryEvent[],
  fixedEntries: ConversationEntryEvent[],
  candidateEntries: ConversationEntryEvent[],
  isWithinBudget: (messages: ConversationEntryEvent[]) => boolean
): ConversationEntryEvent[] {
  if (candidateEntries.length === 0) {
    return [];
  }

  let low = 0;
  let high = candidateEntries.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const candidateTailEntries = candidateEntries.slice(-mid);
    const candidateHistory = mergeBootstrapConversationHistory(
      sourceHistory,
      fixedEntries,
      candidateTailEntries
    );

    if (isWithinBudget(candidateHistory)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return candidateEntries.slice(candidateEntries.length - low);
}

function retainAuthoritativeActivePlanSummary(
  countedHistory: ConversationEntryEvent[],
  fullHistory: ConversationEntryEvent[]
): ConversationEntryEvent[] {
  const activePlanSummary = [...fullHistory].reverse().find(isAuthoritativeActivePlanSummaryEntry);
  if (!activePlanSummary || countedHistory.includes(activePlanSummary)) return countedHistory;

  const selected = new Set(countedHistory);
  selected.add(activePlanSummary);
  return fullHistory.filter((entry) => selected.has(entry));
}

function isAuthoritativeActivePlanSummaryEntry(
  entry: ConversationEntryEvent
): entry is Extract<ConversationEntryEvent, { type: "plan_summary" }> {
  return entry.type === "plan_summary" && entry.state === "active";
}

function isBootstrapTranscriptEntry<Entry extends ConversationEntryEvent>(entry: Entry): boolean {
  return (
    entry.type === "conversation_message" ||
    entry.type === "choice_request" ||
    entry.type === "plan_summary"
  );
}

function collectLatestPendingChoiceIds(entries: readonly ConversationEntryEvent[]): Set<string> {
  const latestChoiceStatusById = new Map<string, ChoiceRequestEvent["status"]>();
  for (const entry of entries) {
    if (!isChoiceRequestEntry(entry)) {
      continue;
    }

    const choiceId = entry.choiceId.trim();
    if (choiceId.length === 0) {
      continue;
    }

    latestChoiceStatusById.set(choiceId, entry.status);
  }

  const pendingChoiceIds = new Set<string>();
  for (const [choiceId, status] of latestChoiceStatusById) {
    if (status === "pending") {
      pendingChoiceIds.add(choiceId);
    }
  }

  return pendingChoiceIds;
}

function isChoiceRequestEntry(entry: ConversationEntryEvent): entry is ChoiceRequestEvent {
  return entry.type === "choice_request";
}

function isActivePendingChoiceRequestEntry(
  entry: ConversationEntryEvent,
  activePendingChoiceIds: ReadonlySet<string>
): boolean {
  return (
    isChoiceRequestEntry(entry) &&
    entry.status === "pending" &&
    activePendingChoiceIds.has(entry.choiceId.trim())
  );
}

function isStalePendingChoiceRequestEntry(
  entry: ConversationEntryEvent,
  activePendingChoiceIds: ReadonlySet<string>
): boolean {
  return (
    isChoiceRequestEntry(entry) &&
    entry.status === "pending" &&
    !activePendingChoiceIds.has(entry.choiceId.trim())
  );
}

function isAnsweredOrCancelledChoiceRequestEntry(entry: ConversationEntryEvent): boolean {
  return isChoiceRequestEntry(entry) && entry.status !== "pending";
}

/** Hidden diagnostics — lowest bootstrap priority until header UI consumes them. */
function isBootstrapDiagnosticEntry<Entry extends ConversationEntryEvent>(entry: Entry): boolean {
  return entry.type === "model_cache_observation";
}

function isBootstrapActivityEntry<Entry extends ConversationEntryEvent>(entry: Entry): boolean {
  return entry.type === "agent_message" || entry.type === "agent_tool_call" || entry.type === "activity_summary";
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
