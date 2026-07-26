import { describe, expect, it, vi } from "vitest";
import type { AgentDescriptor, ManagerProfile } from "../../../../swarm/types.js";
import {
  buildStreamDeckSnapshot,
  compareSessionAttention,
  executeStreamDeckAction,
  parseStreamDeckAction,
} from "../stream-deck-routes.js";

describe("Stream Deck routes", () => {
  it("ranks questions, errors, unread work, running work, and recency for dynamic keys", () => {
    const session = (
      agentId: string,
      overrides: Partial<Parameters<typeof compareSessionAttention>[0]>,
    ): Parameters<typeof compareSessionAttention>[0] => ({
      agentId,
      profileId: "forge",
      profileName: "Forge",
      label: agentId,
      status: "idle",
      updatedAt: "2026-07-25T00:00:00.000Z",
      contextPercent: 0,
      workerCount: 0,
      activeWorkerCount: 0,
      pendingChoiceCount: 0,
      unreadCount: 0,
      compactionCount: 0,
      ...overrides,
    });

    const ranked = [
      session("idle", {}),
      session("running", { status: "streaming" }),
      session("unread", { unreadCount: 2 }),
      session("error", { status: "error" }),
      session("question", { pendingChoiceCount: 1 }),
    ].sort(compareSessionAttention);

    expect(ranked.map((entry) => entry.agentId)).toEqual([
      "question",
      "error",
      "unread",
      "running",
      "idle",
    ]);
  });

  it("builds a compact live snapshot with unread, choices, workers, context, and stats", async () => {
    const profile: ManagerProfile = {
      profileId: "forge",
      displayName: "Forge",
      defaultSessionAgentId: "forge",
      defaultModel: { provider: "openai-codex", modelId: "gpt-5.6", thinkingLevel: "high" },
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T01:00:00.000Z",
    };
    const agents: AgentDescriptor[] = [
      manager("forge", { status: "idle", sessionLabel: "Main" }),
      manager("forge--s2", {
        status: "streaming",
        sessionLabel: "Deck Lab",
        contextUsage: { tokens: 70, contextWindow: 100, percent: 70 },
        workerCount: 3,
        activeWorkerCount: 2,
      }),
    ];
    const options = {
      runtimeTarget: "builder",
      cliAccessService: {},
      swarmManager: {
        listProfiles: () => [profile],
        listAgents: () => agents,
        getAgent: (agentId: string) => agents.find((agent) => agent.agentId === agentId),
        getPendingChoiceIdsForSession: (agentId: string) => agentId === "forge--s2" ? ["choice-1"] : [],
      },
      unreadTracker: {
        getSnapshot: () => ({ "forge--s2": 2 }),
        markRead: vi.fn(),
      },
      statsService: {
        getSnapshot: vi.fn().mockResolvedValue({
          tokens: { today: 1200, last7Days: 9100 },
          cache: { hitRate: 64 },
          workers: { currentlyActive: 2, totalWorkersRun: 12 },
          sessions: { activeSessions: 1 },
          code: { linesAdded: 420, linesDeleted: 17, commits: 4 },
        }),
      },
      broadcastEvent: vi.fn(),
    };

    const snapshot = await buildStreamDeckSnapshot(options as never, null);

    expect(snapshot.focusSessionAgentId).toBe("forge--s2");
    expect(snapshot.summary).toMatchObject({
      sessionCount: 2,
      runningSessionCount: 1,
      activeWorkerCount: 2,
      pendingChoiceCount: 1,
      unreadCount: 2,
    });
    expect(snapshot.sessions[0]).toMatchObject({
      agentId: "forge--s2",
      contextPercent: 70,
      activeWorkerCount: 2,
      pendingChoiceCount: 1,
      unreadCount: 2,
    });
    expect(snapshot.stats).toMatchObject({
      tokensToday: 1200,
      cacheHitRate: 64,
      currentlyActiveWorkers: 2,
      commits: 4,
    });
  });

  it("accepts typed safe actions and rejects malformed or oversized prompts", () => {
    expect(parseStreamDeckAction({
      requestId: "deck-nav",
      type: "navigate",
      sessionAgentId: "forge--s2",
      surface: "browser",
    })).toEqual({
      ok: true,
      action: {
        requestId: "deck-nav",
        type: "navigate",
        sessionAgentId: "forge--s2",
        surface: "browser",
      },
    });

    expect(parseStreamDeckAction({
      requestId: "deck-1",
      type: "smart_compact",
      sessionAgentId: "forge--s2",
    })).toEqual({
      ok: true,
      action: {
        requestId: "deck-1",
        type: "smart_compact",
        sessionAgentId: "forge--s2",
      },
    });

    expect(parseStreamDeckAction({
      requestId: "deck-2",
      type: "delete_session",
      sessionAgentId: "forge--s2",
    })).toMatchObject({ ok: false, error: { code: "invalid_action" } });

    expect(parseStreamDeckAction({
      requestId: "deck-3",
      type: "send_prompt",
      sessionAgentId: "forge--s2",
      text: "x".repeat(8_001),
    })).toMatchObject({ ok: false, error: { code: "invalid_action" } });
  });

  it("broadcasts authenticated navigation into the connected Forge UI", async () => {
    const broadcastEvent = vi.fn();
    const agent = manager("forge--s2", {});
    const result = await executeStreamDeckAction({
      swarmManager: {
        listAgents: () => [agent],
        getAgent: (agentId: string) => agentId === agent.agentId ? agent : undefined,
      },
      broadcastEvent,
    } as never, {
      requestId: "deck-nav",
      type: "navigate",
      sessionAgentId: agent.agentId,
      surface: "terminal",
    });

    expect(result).toMatchObject({
      ok: true,
      requestId: "deck-nav",
      type: "navigate",
      sessionAgentId: agent.agentId,
    });
    expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "stream_deck_navigation_requested",
      requestId: "deck-nav",
      sessionAgentId: agent.agentId,
      surface: "terminal",
    }));
  });
});

function manager(agentId: string, overrides: Partial<AgentDescriptor>): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: "manager",
    status: "idle",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T01:00:00.000Z",
    cwd: "/tmp/forge",
    model: { provider: "openai-codex", modelId: "gpt-5.6", thinkingLevel: "high" },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId: "forge",
    ...overrides,
  };
}
