import type { ServerEvent } from "@forge/protocol";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { SidebarPerfRecorder } from "../../stats/sidebar-perf-types.js";
import { sendSubscriptionBootstrap } from "../ws-bootstrap.js";

function perf(): SidebarPerfRecorder {
  return {
    recordDuration: vi.fn(), increment: vi.fn(),
    readSummary: vi.fn(() => ({ histograms: {}, counters: {} })),
    readRecentSlowEvents: vi.fn(() => []),
  };
}

function manager() {
  const agent = {
    agentId: "session", managerId: "session", displayName: "Session", role: "manager" as const,
    status: "idle" as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    cwd: "/repo", model: { provider: "test", modelId: "test", thinkingLevel: "off" as const },
    sessionFile: "/session.jsonl", profileId: "project",
  };
  return {
    listBootstrapAgents: () => [agent], getAgent: () => agent,
    listProfiles: () => [], getConversationHistoryWithDiagnostics: () => ({ history: [], diagnostics: {} }),
    getPendingChoiceIdsForSession: () => [], getPendingChoiceRequestsForSession: () => [],
    getRestartRecoverySnapshot: () => null,
    getSessionPlanSnapshot: async () => ({ type: "session_plan_snapshot", sessionAgentId: "session", profileId: "project", revision: 0, updatedAt: null, plan: [], diagnostics: { state: "defaulted" } }),
    getSessionGoalSnapshot: async () => ({ type: "session_goal_snapshot", sessionAgentId: "session", profileId: "project", revision: 0, measuredAt: new Date(0).toISOString(), goal: null }),
  };
}

const awareness = {
  type: "remote_update_awareness_project_changed" as const,
  snapshot: {
    projectId: "project", override: "inherit" as const, globalEnabled: true, effectiveEnabled: true,
    state: "update_available" as const, lastObservedAt: "2026-07-20T00:00:00.000Z",
    failureCode: null, attentionRequired: true, dismissalTarget: { generation: 2 },
  },
};

describe("remote update awareness bootstrap projection", () => {
  it("sends the active project's sanitized snapshot during bootstrap", async () => {
    const events: ServerEvent[] = [];
    await sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: "session",
      swarmManager: manager() as never,
      terminalService: null,
      unreadTracker: null,
      perf: perf(),
      send: (_socket, event) => { events.push(event); return 1; },
      resolveTerminalScopeAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: () => undefined,
      remoteUpdateAwarenessEvent: awareness,
    });
    expect(events).toContainEqual(awareness);
    expect(JSON.stringify(awareness)).not.toContain("/repo");
    expect(JSON.stringify(awareness)).not.toContain("refs/heads");
  });

  it("sends a clear projection when the active project is excluded", async () => {
    const events: ServerEvent[] = [];
    const cleared = { type: "remote_update_awareness_project_cleared" as const, projectId: "archived" };
    await sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: "session",
      swarmManager: manager() as never,
      terminalService: null,
      unreadTracker: null,
      perf: perf(),
      send: (_socket, event) => { events.push(event); return 1; },
      resolveTerminalScopeAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: () => undefined,
      remoteUpdateAwarenessEvent: cleared,
    });
    expect(events).toContainEqual(cleared);
  });
});
