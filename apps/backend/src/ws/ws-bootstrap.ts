import { performance } from "node:perf_hooks";
import {
  isSystemProfile,
  type BuilderTimelineChannelView,
  type SecureSessionSnapshot,
  type ServerEvent,
  type TerminalDescriptor,
} from "@forge/protocol";
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
import type { BrowserAutomationService } from "../swarm/browser-automation/index.js";
import { isBuilderRuntimeTarget } from "../runtime-target.js";
import { filterBuilderVisibleAgents, filterBuilderVisibleProfiles } from "./builder-visibility.js";
import { MAX_WS_EVENT_BYTES } from "./ws-send.js";
import { warnWsThrottled } from "./ws-log-throttle.js";
import { WebSocket } from "ws";
import { projectConversationEntryForBuilderWire } from "../swarm/session/conversation-wire-projection.js";
import type { ConversationEntryEvent } from "../swarm/types.js";
import { projectConversationPageMetadataForWire } from "./conversation-page-wire.js";
import { projectConversationEntryForSubscriptionWire } from "./conversation-subscription-projection.js";

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

export async function sendSubscriptionBootstrap(options: {
  socket: WebSocket;
  targetAgentId: string;
  requestedMessageCount?: number;
  supportsConversationPaging?: boolean;
  conversationView?: BuilderTimelineChannelView;
  supportsGoalControlRequestId?: boolean;
  swarmManager: SwarmManager;
  terminalService: TerminalService | null;
  listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
  unreadTracker: UnreadTracker | null;
  browserAutomationService?: BrowserAutomationService | null;
  perf: SidebarPerfRecorder;
  send: (socket: WebSocket, event: ServerEvent) => number | null | Promise<number | null>;
  resolveTerminalScopeAgentId: (subscribedAgentId: string) => string | undefined;
  resolvePlanSnapshotSessionAgentId: (subscribedAgentId: string) => string | undefined;
  resolveBrowserSessionAgentId?: (subscribedAgentId: string) => string | undefined;
  includeAgentsSnapshot?: boolean;
  includeProfilesSnapshot?: boolean;
  remoteUpdateAwarenessEvent?: Extract<ServerEvent, { type: "remote_update_awareness_project_changed" | "remote_update_awareness_project_cleared" }> | null;
  shouldContinue?: () => boolean;
}): Promise<SubscriptionBootstrapSendResult> {
  const {
    socket,
    targetAgentId,
    requestedMessageCount,
    supportsConversationPaging = false,
    conversationView = "all",
    supportsGoalControlRequestId = false,
    swarmManager,
    terminalService,
    listTerminalsForSession,
    unreadTracker,
    browserAutomationService,
    perf,
    send,
    resolveTerminalScopeAgentId,
    resolvePlanSnapshotSessionAgentId,
    resolveBrowserSessionAgentId = resolvePlanSnapshotSessionAgentId,
    includeAgentsSnapshot = true,
    includeProfilesSnapshot = true,
    remoteUpdateAwarenessEvent,
    shouldContinue,
  } = options;

  const canContinue = (): boolean => shouldContinue?.() !== false;

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

  // Awaits `send`, which for bootstrap-critical events flow-controls (awaits socket drain) before
  // sending. Sending sequentially with `await` lets the socket buffer drain between events so the
  // whole bootstrap completes without overflowing the 1 MB buffer and dropping later events.
  const sendMeasured = async (fieldPrefix: string, event: ServerEvent): Promise<number | null> => {
    if (!canContinue()) {
      return null;
    }

    const sendStartedAtMs = performance.now();
    const payloadBytes = await send(socket, event);
    metricFields[`${fieldPrefix}SendMs`] = performance.now() - sendStartedAtMs;
    metricFields[`${fieldPrefix}PayloadBytes`] = payloadBytes;
    if (typeof payloadBytes === "number") {
      payloadBytesTotal += payloadBytes;
    }
    return payloadBytes;
  };

  await sendMeasured("ready", {
    type: "ready",
    serverTime: new Date().toISOString(),
    subscribedAgentId: targetAgentId,
    ...(supportsGoalControlRequestId ? { goalControlRequestId: true as const } : {}),
  });

  if (!canContinue()) {
    return {
      agentsSnapshotSent: false,
      profilesSnapshotSent: false,
    };
  }

  metricFields.snapshotSkipped = !includeAgentsSnapshot;

  let agentsSnapshotSent = false;
  if (includeAgentsSnapshot) {
    const agentsSnapshotBuildStartedAtMs = performance.now();
    const allAgents = swarmManager.listBootstrapAgents();
    const selectedAgent = swarmManager.getAgent?.(targetAgentId);
    const snapshotCandidates =
      selectedAgent && !allAgents.some((agent) => agent.agentId === selectedAgent.agentId)
        ? [...allAgents, selectedAgent]
        : allAgents;
    const agents = filterBuilderVisibleAgents(snapshotCandidates, systemProfileIds);
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
      (await sendMeasured("agentsSnapshot", {
        type: "agents_snapshot",
        agents
      })) !== null;
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
      (await sendMeasured("profilesSnapshot", {
        type: "profiles_snapshot",
        profiles
      })) !== null;
  } else {
    metricFields.profilesSnapshotBuildMs = 0;
    metricFields.profilesSnapshotSendMs = 0;
    metricFields.profilesSnapshotPayloadBytes = 0;
    metricFields.profilesReturned = 0;
  }

  if (remoteUpdateAwarenessEvent) {
    await sendMeasured("remoteUpdateAwareness", remoteUpdateAwarenessEvent);
  }

  const secureSnapshotProvider = swarmManager as unknown as {
    getSecureSessionSnapshot?: (
      sessionAgentId: string,
    ) => SecureSessionSnapshot | Promise<SecureSessionSnapshot>;
    listSecureSessionTeamSnapshots?: (
      managerAgentId: string,
    ) => SecureSessionSnapshot[] | Promise<SecureSessionSnapshot[]>;
  };
  const secureTarget = swarmManager.getAgent(targetAgentId);
  if (
    secureTarget
    && isBuilderRuntimeTarget(swarmManager.getConfig().runtimeTarget)
  ) {
    try {
      const snapshots = secureTarget.role === "manager"
        && typeof secureSnapshotProvider.listSecureSessionTeamSnapshots === "function"
        ? await secureSnapshotProvider.listSecureSessionTeamSnapshots(secureTarget.agentId)
        : typeof secureSnapshotProvider.getSecureSessionSnapshot === "function"
          ? [await secureSnapshotProvider.getSecureSessionSnapshot(secureTarget.agentId)]
          : [];
      for (const snapshot of snapshots) {
        await sendMeasured("secureSessionSnapshot", {
          ...snapshot,
          type: "secure_session_snapshot",
        });
      }
    } catch {
      // These snapshots are metadata-only and must never surface a
      // vault/provider exception through bootstrap logs. The HTTP endpoint
      // remains available for a fixed-code retry.
      metricFields.secureSessionSnapshotUnavailable = true;
    }
  }

  const browserSessionAgentId = resolveBrowserSessionAgentId(targetAgentId);
  if (browserAutomationService && browserSessionAgentId) {
    const descriptor = swarmManager.getAgent(browserSessionAgentId);
    if (descriptor?.role === "manager") {
      const snapshot = await browserAutomationService.getSessionSnapshot(
        descriptor.profileId ?? descriptor.agentId,
        descriptor.agentId,
      );
      await sendMeasured("browserSessionSnapshot", {
        type: "browser_session_snapshot",
        snapshot,
      });
    }
  }

  const historyMessageCount = requestedMessageCount !== undefined
    ? normalizeSubscribeMessageCount(requestedMessageCount)
    : undefined;
  metricFields.requestedMessageCount = historyMessageCount ?? null;

  const pendingChoicesStartedAtMs = performance.now();
  const pendingChoices = (swarmManager.getPendingChoiceRequestsForSession?.(targetAgentId) ?? [])
    .map((choice) => projectConversationEntryForBuilderWire(choice) as typeof choice);
  const pendingChoiceIds =
    pendingChoices.length > 0
      ? pendingChoices.map((choice) => choice.choiceId)
      : swarmManager.getPendingChoiceIdsForSession(targetAgentId);
  metricFields.pendingChoiceCount = pendingChoiceIds.length;
  metricFields.pendingChoicesLookupMs = performance.now() - pendingChoicesStartedAtMs;

  const historyLoadStartedAtMs = performance.now();
  const legacyHistoryResult = supportsConversationPaging
    ? undefined
    : swarmManager.getConversationHistoryWithDiagnostics(targetAgentId);
  const historyPageResult = supportsConversationPaging
    ? swarmManager.getConversationHistoryPage(targetAgentId, {
        limit: historyMessageCount,
        view: conversationView,
      })
    : {
        messages: legacyHistoryResult?.history ?? [],
        page: {
          hasOlder: false,
          completeness: "complete" as const,
          source: "memory" as const,
          sourceRevision: "legacy_bootstrap",
          pageBytes: 0,
          scanBytes: legacyHistoryResult?.diagnostics.fsReadBytes ?? 0,
        },
      };
  const projectedHistory = historyPageResult.messages.flatMap((entry) => {
    const projected = projectConversationEntryForSubscriptionWire(
      entry as ConversationEntryEvent,
      supportsConversationPaging,
    );
    return projected ? [projected] : [];
  });
  // A canonical page and its cursor are one atomic result. Applying the
  // legacy bootstrap selector afterward could discard a returned row while
  // leaving the cursor advanced past it. Paging clients receive the page
  // unchanged; pending choices arrive in their dedicated snapshot below.
  const conversationHistorySelection = supportsConversationPaging
    ? {
        history: projectedHistory,
        requestedHistoryLength: projectedHistory.length,
        trimmed: false,
      }
    : selectBootstrapConversationHistoryByPolicy({
        fullHistory: projectedHistory,
        managerId: targetAgentId,
        requestedMessageCount: historyMessageCount,
        pendingChoiceRequests: pendingChoices,
        includeDiagnosticEntries: swarmManager.isModelCacheVisualizationEnabled?.() ?? false,
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
  metricFields.fsReadBytes = historyPageResult.page.scanBytes;
  if (legacyHistoryResult) {
    metricFields.fsReadOps = legacyHistoryResult.diagnostics.fsReadOps;
    metricFields.sessionFileBytes = legacyHistoryResult.diagnostics.sessionFileBytes;
    metricFields.cacheFileBytes = legacyHistoryResult.diagnostics.cacheFileBytes;
    metricFields.persistedEntryCount = legacyHistoryResult.diagnostics.persistedEntryCount;
    metricFields.cachedEntryCount = legacyHistoryResult.diagnostics.cachedEntryCount;
    metricFields.sessionSummaryBytesScanned = legacyHistoryResult.diagnostics.sessionSummaryBytesScanned;
    metricFields.cacheReadMs = legacyHistoryResult.diagnostics.cacheReadMs;
    metricFields.sessionSummaryReadMs = legacyHistoryResult.diagnostics.sessionSummaryReadMs;
    metricFields.historyDetail = legacyHistoryResult.diagnostics.detail ?? undefined;
  }
  metricFields.historyPageSource = historyPageResult.page.source;
  metricFields.historyPageCompleteness = historyPageResult.page.completeness;
  metricFields.historyPageHasOlder = historyPageResult.page.hasOlder;
  await sendMeasured("conversationHistory", {
    type: "conversation_history",
    agentId: targetAgentId,
    messages: conversationHistory,
    mode: "replace",
    ...(supportsConversationPaging
      ? { page: projectConversationPageMetadataForWire(historyPageResult.page) }
      : {}),
  });

  const pendingChoicesSnapshot = buildPendingChoicesSnapshot(
    targetAgentId,
    pendingChoiceIds,
    pendingChoices,
  );
  metricFields.pendingChoiceDetailsReturned = pendingChoicesSnapshot.choices?.length ?? 0;
  await sendMeasured("pendingChoicesSnapshot", pendingChoicesSnapshot);
  // Elicitations are deliberately ephemeral (never conversation history), but a reconnecting
  // owner must be able to answer the still-live app-server request.
  for (const elicitation of swarmManager.getPendingCodexElicitationsForManager?.(targetAgentId) ?? []) {
    await sendMeasured("codexElicitation", {
      type: "codex_elicitation_request",
      elicitationId: elicitation.elicitationId,
      agentId: elicitation.managerAgentId,
      sidecarAgentId: elicitation.sidecarAgentId,
      mode: elicitation.mode,
      ...(elicitation.title ? { title: elicitation.title } : {}),
      message: elicitation.message,
      ...(elicitation.fields ? { fields: elicitation.fields } : {}),
      // The full (often tokenized) URL is only sent in the initial live event.
      ...(elicitation.urlOrigin ? { urlOrigin: elicitation.urlOrigin } : {}),
      persistScopes: elicitation.persistScopes,
    });
  }
  metricFields.pendingChoicesMs = performance.now() - pendingChoicesStartedAtMs;

  await sendMeasured("restartRecoverySnapshot", {
    type: "restart_recovery_snapshot",
    snapshot: swarmManager.getRestartRecoverySnapshot?.() ?? null,
  });

  const planSnapshotSessionAgentId = resolvePlanSnapshotSessionAgentId(targetAgentId);
  metricFields.planSnapshotSessionAgentId = planSnapshotSessionAgentId ?? null;
  if (planSnapshotSessionAgentId) {
    const planSnapshotStartedAtMs = performance.now();
    const planSnapshotBuildStartedAtMs = performance.now();
    const planSnapshot = await swarmManager.getSessionPlanSnapshot(planSnapshotSessionAgentId);
    metricFields.planSnapshotBuildMs = performance.now() - planSnapshotBuildStartedAtMs;
    metricFields.planSnapshotRevision = planSnapshot.revision;
    metricFields.planSnapshotStepCount = planSnapshot.plan.length;
    await sendMeasured("planSnapshot", planSnapshot);
    metricFields.planSnapshotMs = performance.now() - planSnapshotStartedAtMs;
  } else {
    metricFields.planSnapshotBuildMs = 0;
    metricFields.planSnapshotSendMs = 0;
    metricFields.planSnapshotPayloadBytes = 0;
    metricFields.planSnapshotRevision = null;
    metricFields.planSnapshotStepCount = 0;
    metricFields.planSnapshotMs = 0;
  }

  if (planSnapshotSessionAgentId) {
    await sendMeasured(
      "goalSnapshot",
      await swarmManager.getSessionGoalSnapshot(planSnapshotSessionAgentId),
    );
  }

  const terminalsSnapshotStartedAtMs = performance.now();
  const effectiveTerminalSessionId = resolveTerminalScopeAgentId(targetAgentId) ?? targetAgentId;
  const terminals =
    listTerminalsForSession?.(effectiveTerminalSessionId) ??
    terminalService?.listTerminals(effectiveTerminalSessionId) ??
    [];
  metricFields.terminalCount = terminals.length;
  await sendMeasured("terminalsSnapshot", {
    type: "terminals_snapshot",
    sessionAgentId: effectiveTerminalSessionId,
    terminals,
  });
  metricFields.terminalsSnapshotMs = performance.now() - terminalsSnapshotStartedAtMs;

  if (unreadTracker) {
    const unreadSnapshotStartedAtMs = performance.now();
    await sendMeasured("unreadCountsSnapshot", {
      type: "unread_counts_snapshot",
      counts: unreadTracker.getSnapshot(),
    });
    metricFields.unreadSnapshotMs = performance.now() - unreadSnapshotStartedAtMs;
  }

  metricFields.payloadBytesTotal = payloadBytesTotal;
  const totalMs = performance.now() - startedAtMs;
  metricFields.totalMs = totalMs;

  perf.recordDuration(SIDEBAR_BOOTSTRAP_METRIC, totalMs, {
    labels: {
      historySource:
        legacyHistoryResult?.diagnostics.historySource ??
        (historyPageResult.page.source === "legacy_cache" ? "cache_hit" : "full_parse"),
      cacheState:
        legacyHistoryResult?.diagnostics.cacheState ??
        (historyPageResult.page.source === "legacy_cache" ? "hit" : "absent"),
      buildMode
    },
    fields: metricFields
  });

  if (!canContinue()) {
    return {
      agentsSnapshotSent: false,
      profilesSnapshotSent: false,
    };
  }

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

function buildPendingChoicesSnapshot(
  agentId: string,
  choiceIds: string[],
  choices: Extract<ServerEvent, { type: "choice_request" }>[],
): Extract<ServerEvent, { type: "pending_choices_snapshot" }> {
  const base = {
    type: "pending_choices_snapshot" as const,
    agentId,
    choiceIds,
  };
  if (choices.length === 0) return base;

  const full = { ...base, choices };
  if (isEventWithinBootstrapBudget(full)) return full;

  const selected: typeof choices = [];
  for (let index = choices.length - 1; index >= 0; index -= 1) {
    const candidate = [choices[index], ...selected];
    if (isEventWithinBootstrapBudget({ ...base, choices: candidate })) {
      selected.unshift(choices[index]);
    }
  }

  return selected.length > 0 ? { ...base, choices: selected } : base;
}

function isEventWithinBootstrapBudget(event: ServerEvent): boolean {
  const eventBytes = measureEventBytes(event);
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
