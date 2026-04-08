import type { ServerEvent, TerminalDescriptor } from "@forge/protocol";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import type { PlaywrightDiscoveryService } from "../playwright/playwright-discovery-service.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import type { UnreadTracker } from "../swarm/unread-tracker.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { MAX_WS_EVENT_BYTES } from "./ws-send.js";
import { WebSocket } from "ws";

export const DEFAULT_SUBSCRIBE_MESSAGE_COUNT = 200;
export const MAX_SUBSCRIBE_MESSAGE_COUNT = 2000;
export const BOOTSTRAP_HISTORY_BYTE_BUDGET = MAX_WS_EVENT_BYTES - 16 * 1024;

export type BootstrapConversationHistory = ReturnType<SwarmManager["getConversationHistory"]>;
type BootstrapConversationEntry = BootstrapConversationHistory[number];

export function normalizeSubscribeMessageCount(messageCount: number | undefined): number | undefined {
  if (messageCount === undefined || messageCount === null) {
    return undefined;
  }

  if (typeof messageCount !== "number" || Number.isNaN(messageCount) || !Number.isFinite(messageCount)) {
    return undefined;
  }

  const rounded = Math.floor(messageCount);
  if (rounded <= 0) {
    return DEFAULT_SUBSCRIBE_MESSAGE_COUNT;
  }

  if (rounded > MAX_SUBSCRIBE_MESSAGE_COUNT) {
    return MAX_SUBSCRIBE_MESSAGE_COUNT;
  }

  return rounded;
}

export function sendSubscriptionBootstrap(options: {
  socket: WebSocket;
  targetAgentId: string;
  requestedMessageCount?: number;
  swarmManager: SwarmManager;
  integrationRegistry: IntegrationRegistryService | null;
  playwrightDiscovery: PlaywrightDiscoveryService | null;
  terminalService: TerminalService | null;
  listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
  unreadTracker: UnreadTracker | null;
  send: (socket: WebSocket, event: ServerEvent) => void;
  resolveTerminalScopeAgentId: (subscribedAgentId: string) => string | undefined;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
}): void {
  const {
    socket,
    targetAgentId,
    requestedMessageCount,
    swarmManager,
    integrationRegistry,
    playwrightDiscovery,
    terminalService,
    listTerminalsForSession,
    unreadTracker,
    send,
    resolveTerminalScopeAgentId,
    resolveManagerContextAgentId,
  } = options;

  send(socket, {
    type: "ready",
    serverTime: new Date().toISOString(),
    subscribedAgentId: targetAgentId
  });
  send(socket, {
    type: "agents_snapshot",
    agents: swarmManager.listBootstrapAgents()
  });
  send(socket, {
    type: "profiles_snapshot",
    profiles: swarmManager.listProfiles()
  });

  if (playwrightDiscovery) {
    send(socket, {
      type: "playwright_discovery_snapshot",
      snapshot: playwrightDiscovery.getSnapshot()
    });
    send(socket, {
      type: "playwright_discovery_settings_updated",
      settings: playwrightDiscovery.getSettings()
    });
  }

  const historyMessageCount = requestedMessageCount !== undefined
    ? normalizeSubscribeMessageCount(requestedMessageCount)
    : undefined;
  const conversationHistory = selectBootstrapConversationHistory(swarmManager, targetAgentId, historyMessageCount);

  send(socket, {
    type: "conversation_history",
    agentId: targetAgentId,
    messages: conversationHistory
  });

  const pendingChoiceIds = swarmManager.getPendingChoiceIdsForSession(targetAgentId);
  send(socket, {
    type: "pending_choices_snapshot",
    agentId: targetAgentId,
    choiceIds: pendingChoiceIds,
  });

  const effectiveTerminalSessionId = resolveTerminalScopeAgentId(targetAgentId) ?? targetAgentId;
  send(socket, {
    type: "terminals_snapshot",
    sessionAgentId: effectiveTerminalSessionId,
    terminals:
      listTerminalsForSession?.(effectiveTerminalSessionId) ??
      terminalService?.listTerminals(effectiveTerminalSessionId) ??
      [],
  });

  if (unreadTracker) {
    send(socket, {
      type: "unread_counts_snapshot",
      counts: unreadTracker.getSnapshot(),
    });
  }

  const managerContextId = resolveManagerContextAgentId(targetAgentId);
  if (integrationRegistry && managerContextId) {
    send(socket, integrationRegistry.getStatus(managerContextId, "telegram"));
  }
}

export function selectBootstrapConversationHistory(
  swarmManager: SwarmManager,
  targetAgentId: string,
  requestedMessageCount?: number,
): BootstrapConversationHistory {
  const fullHistory = swarmManager.getConversationHistory(targetAgentId);
  const requestedHistory = requestedMessageCount !== undefined
    ? fullHistory.slice(-requestedMessageCount)
    : fullHistory;

  if (isBootstrapConversationHistoryWithinBudget(targetAgentId, requestedHistory)) {
    return requestedHistory;
  }

  const conversationEntries = requestedHistory.filter(
    (entry) =>
      entry.type === "conversation_message" ||
      entry.type === "conversation_log" ||
      entry.type === "choice_request",
  );
  const activityEntries = requestedHistory.filter(
    (entry) => entry.type === "agent_message" || entry.type === "agent_tool_call",
  );

  if (!isBootstrapConversationHistoryWithinBudget(targetAgentId, conversationEntries)) {
    const trimmedConversationEntries = trimBootstrapConversationHistoryTailToBudget(targetAgentId, conversationEntries);
    logBootstrapHistoryTrim(targetAgentId, requestedHistory.length, trimmedConversationEntries.length);
    return trimmedConversationEntries;
  }

  const selectedActivityEntries = selectTailActivityEntriesWithinBootstrapBudget(
    targetAgentId,
    requestedHistory,
    conversationEntries,
    activityEntries,
  );
  const trimmedHistory = mergeBootstrapConversationHistory(
    requestedHistory,
    conversationEntries,
    selectedActivityEntries,
  );

  logBootstrapHistoryTrim(targetAgentId, requestedHistory.length, trimmedHistory.length);
  return trimmedHistory;
}

function isBootstrapConversationHistoryWithinBudget(
  targetAgentId: string,
  messages: BootstrapConversationHistory,
): boolean {
  const eventBytes = measureEventBytes({
    type: "conversation_history",
    agentId: targetAgentId,
    messages,
  });

  return eventBytes !== null && eventBytes <= BOOTSTRAP_HISTORY_BYTE_BUDGET;
}

function trimBootstrapConversationHistoryTailToBudget(
  targetAgentId: string,
  history: BootstrapConversationHistory,
): BootstrapConversationHistory {
  let low = 0;
  let high = history.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = history.slice(mid);

    if (isBootstrapConversationHistoryWithinBudget(targetAgentId, candidate)) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return history.slice(low);
}

function selectTailActivityEntriesWithinBootstrapBudget(
  targetAgentId: string,
  sourceHistory: BootstrapConversationHistory,
  conversationEntries: BootstrapConversationHistory,
  activityEntries: BootstrapConversationHistory,
): BootstrapConversationHistory {
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
      candidateActivityEntries,
    );

    if (isBootstrapConversationHistoryWithinBudget(targetAgentId, candidateHistory)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return activityEntries.slice(-low);
}

function mergeBootstrapConversationHistory(
  sourceHistory: BootstrapConversationHistory,
  conversationEntries: BootstrapConversationHistory,
  activityEntries: BootstrapConversationHistory,
): BootstrapConversationHistory {
  if (conversationEntries.length === 0) {
    return activityEntries;
  }

  if (activityEntries.length === 0) {
    return conversationEntries;
  }

  const selectedEntries = new Set<BootstrapConversationEntry>();
  for (const entry of conversationEntries) {
    selectedEntries.add(entry);
  }
  for (const entry of activityEntries) {
    selectedEntries.add(entry);
  }

  return sourceHistory.filter((entry) => selectedEntries.has(entry));
}

function logBootstrapHistoryTrim(targetAgentId: string, originalCount: number, trimmedCount: number): void {
  if (trimmedCount === originalCount) {
    return;
  }

  console.warn("[swarm] ws:trim_bootstrap_history", {
    agentId: targetAgentId,
    originalCount,
    trimmedCount,
    maxEventBytes: BOOTSTRAP_HISTORY_BYTE_BUDGET,
  });
}

function measureEventBytes(event: ServerEvent): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    return null;
  }
}
