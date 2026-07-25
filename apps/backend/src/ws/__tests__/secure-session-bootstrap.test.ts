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
  const worker = {
    ...agent,
    agentId: "worker-1",
    managerId: "session",
    displayName: "Worker 1",
    role: "worker" as const,
  };
  const secureSnapshot = (sessionAgentId: "session" | "worker-1") => ({
    sessionAgentId,
    profileId: "project",
    principalKind: sessionAgentId === "session" ? "manager" as const : "worker" as const,
    ownerManagerAgentId: sessionAgentId === "session" ? null : "session",
    workerAssignmentId: sessionAgentId === "session" ? null : "assignment-1",
    revision: 7,
    executionMode: "secure" as const,
    environmentStatus: "ready" as const,
    leases: [{
      leaseId: `lease-${sessionAgentId}`,
      secretId: "secret-1",
      displayAlias: "DEPLOY_TOKEN",
      leaseKind: "task" as const,
      exposures: [{
        deliveryKind: "environment" as const,
        targetName: "DEPLOY_TOKEN",
      }],
      status: "active" as const,
      expiresAt: null,
      lastUsedAt: null,
      remainingUses: null,
      grantSource: "project_default" as const,
    }],
    pendingRequests: [],
    projectDefaults: [{
      secretId: "secret-1",
      displayAlias: "DEPLOY_TOKEN",
      state: "active" as const,
      statusCode: "ok" as const,
    }],
    updatedAt: "2026-07-23T00:00:00.000Z",
  });
  const getSecureSessionSnapshot = vi.fn(async (sessionAgentId: string) => {
    if (options.secureSnapshotError) {
      throw options.secureSnapshotError;
    }
    return secureSnapshot(sessionAgentId === "worker-1" ? "worker-1" : "session");
  });
  const listSecureSessionTeamSnapshots = vi.fn(async () => {
    if (options.secureSnapshotError) {
      throw options.secureSnapshotError;
    }
    return [secureSnapshot("session"), secureSnapshot("worker-1")];
  });
  return {
    getConfig: () => ({ runtimeTarget: "builder" as const }),
    listBootstrapAgents: () => [agent, worker],
    getAgent: (agentId: string) =>
      agentId === worker.agentId ? worker : agentId === agent.agentId ? agent : undefined,
    listProfiles: () => [],
    getConversationHistoryWithDiagnostics: () => ({
      history: [],
      diagnostics: {},
    }),
    getPendingChoiceIdsForSession: () => [],
    getPendingChoiceRequestsForSession: () => [],
    getRestartRecoverySnapshot: () => null,
    getSecureSessionSnapshot,
    listSecureSessionTeamSnapshots,
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
  it("sends only the worker principal snapshot to a worker subscription", async () => {
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

    expect(swarmManager.getSecureSessionSnapshot).toHaveBeenCalledWith("worker-1");
    expect(swarmManager.listSecureSessionTeamSnapshots).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "secure_session_snapshot"))
      .toEqual([
        expect.objectContaining({
          type: "secure_session_snapshot",
          sessionAgentId: "worker-1",
          principalKind: "worker",
          ownerManagerAgentId: "session",
          workerAssignmentId: "assignment-1",
        }),
      ]);
  });

  it("sends existing team principal snapshots to the manager subscription", async () => {
    const swarmManager = manager();
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

    expect(swarmManager.listSecureSessionTeamSnapshots).toHaveBeenCalledWith("session");
    expect(swarmManager.getSecureSessionSnapshot).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "secure_session_snapshot")
      .map((event) => event.type === "secure_session_snapshot"
        ? event.sessionAgentId
        : null))
      .toEqual(["session", "worker-1"]);
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
