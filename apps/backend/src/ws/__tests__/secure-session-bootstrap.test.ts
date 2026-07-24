import type { ServerEvent } from "@forge/protocol";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { SidebarPerfRecorder } from "../../stats/sidebar-perf-types.js";
import { sendSubscriptionBootstrap } from "../ws-bootstrap.js";

function perf(): SidebarPerfRecorder {
  return {
    recordDuration: vi.fn(),
    increment: vi.fn(),
    readSummary: vi.fn(() => ({ histograms: {}, counters: {} })),
    readRecentSlowEvents: vi.fn(() => []),
  };
}

function manager(options: { secureSnapshotError?: Error } = {}) {
  const agent = {
    agentId: "session",
    managerId: "session",
    displayName: "Session",
    role: "manager" as const,
    status: "idle" as const,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    cwd: "/repo",
    model: {
      provider: "test",
      modelId: "test",
      thinkingLevel: "off" as const,
    },
    sessionFile: "/session.jsonl",
    profileId: "project",
  };
  return {
    getConfig: () => ({ runtimeTarget: "builder" as const }),
    listBootstrapAgents: () => [agent],
    getAgent: () => agent,
    listProfiles: () => [],
    getConversationHistoryWithDiagnostics: () => ({
      history: [],
      diagnostics: {},
    }),
    getPendingChoiceIdsForSession: () => [],
    getPendingChoiceRequestsForSession: () => [],
    getRestartRecoverySnapshot: () => null,
    getSecureSessionSnapshot: vi.fn(async () => {
      if (options.secureSnapshotError) {
        throw options.secureSnapshotError;
      }
      return {
        sessionAgentId: "session",
        profileId: "project",
        revision: 7,
        executionMode: "secure" as const,
        environmentStatus: "ready" as const,
        leases: [],
        pendingRequests: [],
        updatedAt: "2026-07-23T00:00:00.000Z",
      };
    }),
    getSessionPlanSnapshot: async () => ({
      type: "session_plan_snapshot" as const,
      sessionAgentId: "session",
      profileId: "project",
      revision: 0,
      updatedAt: null,
      plan: [],
      diagnostics: { state: "defaulted" as const },
    }),
    getSessionGoalSnapshot: async () => ({
      type: "session_goal_snapshot" as const,
      sessionAgentId: "session",
      profileId: "project",
      revision: 0,
      measuredAt: new Date(0).toISOString(),
      goal: null,
    }),
  };
}

describe("secure session bootstrap projection", () => {
  it("sends the canonical exact-session snapshot for manager and worker subscriptions", async () => {
    const swarmManager = manager();
    const events: ServerEvent[] = [];

    await sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: "worker-1",
      swarmManager: swarmManager as never,
      terminalService: null,
      unreadTracker: null,
      perf: perf(),
      send: (_socket, event) => {
        events.push(event);
        return 1;
      },
      resolveTerminalScopeAgentId: () => "session",
      resolvePlanSnapshotSessionAgentId: () => "session",
    });

    expect(swarmManager.getSecureSessionSnapshot).toHaveBeenCalledWith("session");
    expect(events).toContainEqual({
      type: "secure_session_snapshot",
      sessionAgentId: "session",
      profileId: "project",
      revision: 7,
      executionMode: "secure",
      environmentStatus: "ready",
      leases: [],
      pendingRequests: [],
      updatedAt: "2026-07-23T00:00:00.000Z",
    });
  });

  it("does not expose vault/provider failures while continuing bootstrap", async () => {
    const canary = "RAW-PROVIDER-ERROR-CANARY";
    const swarmManager = manager({ secureSnapshotError: new Error(canary) });
    const events: ServerEvent[] = [];

    await sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: "session",
      swarmManager: swarmManager as never,
      terminalService: null,
      unreadTracker: null,
      perf: perf(),
      send: (_socket, event) => {
        events.push(event);
        return 1;
      },
      resolveTerminalScopeAgentId: () => "session",
      resolvePlanSnapshotSessionAgentId: () => "session",
    });

    expect(events.some((event) => event.type === "conversation_history")).toBe(true);
    expect(events.some((event) => event.type === "secure_session_snapshot")).toBe(false);
    expect(JSON.stringify(events)).not.toContain(canary);
  });
});
