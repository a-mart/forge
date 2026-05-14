import { performance } from "node:perf_hooks";
import { isSystemProfile, type ServerEvent, type TerminalDescriptor } from "@forge/protocol";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import {
  SIDEBAR_BOOTSTRAP_METRIC,
  SIDEBAR_SNAPSHOT_BUILD_METRIC,
  resolveBackendSidebarPerfBuildMode
} from "../stats/sidebar-perf-metrics.js";
import type { SidebarPerfRecorder } from "../stats/sidebar-perf-types.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import type { UnreadTracker } from "../swarm/unread-tracker.js";
import {
  selectBootstrapConversationHistory as selectBootstrapConversationHistoryByPolicy
} from "../swarm/session/history-policy.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { filterBuilderVisibleAgents, filterBuilderVisibleProfiles } from "./builder-visibility.js";
import { MAX_WS_EVENT_BYTES } from "./ws-send.js";
import { warnWsThrottled } from "./ws-log-throttle.js";
import { WebSocket } from "ws";

export const DEFAULT_SUBSCRIBE_MESSAGE_COUNT = 200;
const MAX_SUBSCRIBE_MESSAGE_COUNT = 2000;
const BOOTSTRAP_HISTORY_BYTE_BUDGET = MAX_WS_EVENT_BYTES - 16 * 1024;

export type BootstrapConversationHistory = ReturnType<SwarmManager["getConversationHistory"]>;
export interface SubscriptionBootstrapSendResult {
  agentsSnapshotSent: boolean;
  profilesSnapshotSent: boolean;
}

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
  terminalService: TerminalService | null;
  listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
  unreadTracker: UnreadTracker | null;
  perf: SidebarPerfRecorder;
  send: (socket: WebSocket, event: ServerEvent) => number | null;
  resolveTerminalScopeAgentId: (subscribedAgentId: string) => string | undefined;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
  includeAgentsSnapshot?: boolean;
  includeProfilesSnapshot?: boolean;
}): SubscriptionBootstrapSendResult {
  const {
    socket,
    targetAgentId,
    requestedMessageCount,
    swarmManager,
    integrationRegistry,
    terminalService,
    listTerminalsForSession,
    unreadTracker,
    perf,
    send,
    resolveTerminalScopeAgentId,
    resolveManagerContextAgentId,
    includeAgentsSnapshot = true,
    includeProfilesSnapshot = true,
  } = options;

  const buildMode = resolveBackendSidebarPerfBuildMode();
  const startedAtMs = performance.now();
  const metricFields: Record<string, unknown> = {
    targetAgentId,
  };
  let payloadBytesTotal = 0;

  const allProfiles = swarmManager.listProfiles();
  const systemProfileIds = new Set(
    allProfiles.filter((profile) => isSystemProfile(profile)).map((profile) => profile.profileId),
  );

  const sendMeasured = (fieldPrefix: string, event: ServerEvent): number | null => {
    const sendStartedAtMs = performance.now();
    const payloadBytes = send(socket, event);
    metricFields[`${fieldPrefix}SendMs`] = performance.now() - sendStartedAtMs;
    metricFields[`${fieldPrefix}PayloadBytes`] = payloadBytes;
    if (typeof payloadBytes === "number") {
      payloadBytesTotal += payloadBytes;
    }
    return payloadBytes;
  };

  sendMeasured("ready", {
    type: "ready",
    serverTime: new Date().toISOString(),
    subscribedAgentId: targetAgentId
  });

  metricFields.snapshotSkipped = !includeAgentsSnapshot;

  let agentsSnapshotSent = false;
  if (includeAgentsSnapshot) {
    const agentsSnapshotBuildStartedAtMs = performance.now();
    const allAgents = swarmManager.listBootstrapAgents();
    const agents = filterBuilderVisibleAgents(allAgents, systemProfileIds);
    const agentsSnapshotBuildMs = performance.now() - agentsSnapshotBuildStartedAtMs;
    metricFields.agentsSnapshotBuildMs = agentsSnapshotBuildMs;
    metricFields.agentsCount = allAgents.length;
    metricFields.agentsReturned = agents.length;
    perf.recordDuration(SIDEBAR_SNAPSHOT_BUILD_METRIC, agentsSnapshotBuildMs, {
      labels: {
        includeStreamingWorkers: false,
        buildMode
      },
      fields: {
        managerCountReturned: agents.filter((descriptor) => descriptor.role === "manager").length,
        totalDescriptorCount: allAgents.length
      }
    });
    agentsSnapshotSent =
      sendMeasured("agentsSnapshot", {
        type: "agents_snapshot",
        agents
      }) !== null;
  } else {
    metricFields.agentsSnapshotBuildMs = 0;
    metricFields.agentsSnapshotSendMs = 0;
    metricFields.agentsSnapshotPayloadBytes = 0;
    metricFields.agentsCount = 0;
    metricFields.agentsReturned = 0;
  }

  let profilesSnapshotSent = false;
  if (includeProfilesSnapshot) {
    const profilesSnapshotBuildStartedAtMs = performance.now();
    const profiles = filterBuilderVisibleProfiles(allProfiles);
    const profilesSnapshotBuildMs = performance.now() - profilesSnapshotBuildStartedAtMs;
    metricFields.profilesSnapshotBuildMs = profilesSnapshotBuildMs;
    metricFields.profilesReturned = profiles.length;
    profilesSnapshotSent =
      sendMeasured("profilesSnapshot", {
        type: "profiles_snapshot",
        profiles
      }) !== null;
  } else {
    metricFields.profilesSnapshotBuildMs = 0;
    metricFields.profilesSnapshotSendMs = 0;
    metricFields.profilesSnapshotPayloadBytes = 0;
    metricFields.profilesReturned = 0;
  }

  const historyMessageCount = requestedMessageCount !== undefined
    ? normalizeSubscribeMessageCount(requestedMessageCount)
    : undefined;
  metricFields.requestedMessageCount = historyMessageCount ?? null;

  const historyLoadStartedAtMs = performance.now();
  const historyResult = swarmManager.getConversationHistoryWithDiagnostics(targetAgentId);
  const conversationHistorySelection = selectBootstrapConversationHistoryByPolicy({
    fullHistory: historyResult.history,
    requestedMessageCount: historyMessageCount,
    isWithinBudget: (messages) => isBootstrapConversationHistoryWithinBudget(targetAgentId, messages)
  });
  const conversationHistory = conversationHistorySelection.history;
  if (conversationHistorySelection.trimmed) {
    logBootstrapHistoryTrim(
      targetAgentId,
      conversationHistorySelection.requestedHistoryLength,
      conversationHistory.length
    );
  }
  const historyLoadMs = performance.now() - historyLoadStartedAtMs;
  metricFields.historyLoadMs = historyLoadMs;
  metricFields.historyEntriesReturned = conversationHistory.length;
  metricFields.fsReadOps = historyResult.diagnostics.fsReadOps;
  metricFields.fsReadBytes = historyResult.diagnostics.fsReadBytes;
  metricFields.sessionFileBytes = historyResult.diagnostics.sessionFileBytes;
  metricFields.cacheFileBytes = historyResult.diagnostics.cacheFileBytes;
  metricFields.persistedEntryCount = historyResult.diagnostics.persistedEntryCount;
  metricFields.cachedEntryCount = historyResult.diagnostics.cachedEntryCount;
  metricFields.sessionSummaryBytesScanned = historyResult.diagnostics.sessionSummaryBytesScanned;
  metricFields.cacheReadMs = historyResult.diagnostics.cacheReadMs;
  metricFields.sessionSummaryReadMs = historyResult.diagnostics.sessionSummaryReadMs;
  metricFields.historyDetail = historyResult.diagnostics.detail ?? undefined;
  sendMeasured("conversationHistory", {
    type: "conversation_history",
    agentId: targetAgentId,
    messages: conversationHistory
  });

  const pendingChoicesStartedAtMs = performance.now();
  const pendingChoiceIds = swarmManager.getPendingChoiceIdsForSession(targetAgentId);
  metricFields.pendingChoiceCount = pendingChoiceIds.length;
  sendMeasured("pendingChoicesSnapshot", {
    type: "pending_choices_snapshot",
    agentId: targetAgentId,
    choiceIds: pendingChoiceIds,
  });
  metricFields.pendingChoicesMs = performance.now() - pendingChoicesStartedAtMs;

  const terminalsSnapshotStartedAtMs = performance.now();
  const effectiveTerminalSessionId = resolveTerminalScopeAgentId(targetAgentId) ?? targetAgentId;
  const terminals =
    listTerminalsForSession?.(effectiveTerminalSessionId) ??
    terminalService?.listTerminals(effectiveTerminalSessionId) ??
    [];
  metricFields.terminalCount = terminals.length;
  sendMeasured("terminalsSnapshot", {
    type: "terminals_snapshot",
    sessionAgentId: effectiveTerminalSessionId,
    terminals,
  });
  metricFields.terminalsSnapshotMs = performance.now() - terminalsSnapshotStartedAtMs;

  if (unreadTracker) {
    const unreadSnapshotStartedAtMs = performance.now();
    sendMeasured("unreadCountsSnapshot", {
      type: "unread_counts_snapshot",
      counts: unreadTracker.getSnapshot(),
    });
    metricFields.unreadSnapshotMs = performance.now() - unreadSnapshotStartedAtMs;
  }

  const managerContextId = resolveManagerContextAgentId(targetAgentId);
  if (integrationRegistry && managerContextId) {
    const integrationStatusStartedAtMs = performance.now();
    sendMeasured("integrationStatus", integrationRegistry.getStatus(managerContextId, "telegram"));
    metricFields.integrationStatusMs = performance.now() - integrationStatusStartedAtMs;
  }

  metricFields.payloadBytesTotal = payloadBytesTotal;
  const totalMs = performance.now() - startedAtMs;
  metricFields.totalMs = totalMs;

  perf.recordDuration(SIDEBAR_BOOTSTRAP_METRIC, totalMs, {
    labels: {
      historySource: historyResult.diagnostics.historySource,
      cacheState: historyResult.diagnostics.cacheState,
      buildMode
    },
    fields: metricFields
  });

  return {
    agentsSnapshotSent,
    profilesSnapshotSent,
  };
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

function logBootstrapHistoryTrim(targetAgentId: string, originalCount: number, trimmedCount: number): void {
  if (trimmedCount === originalCount) {
    return;
  }

  warnWsThrottled(`trim_bootstrap_history:${targetAgentId}`, "[swarm] ws:trim_bootstrap_history", {
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
