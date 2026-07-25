import { describe, expect, it, vi } from "vitest";
import type { ManagerProfile } from "@forge/protocol";
import { handleSessionCommand } from "../ws/commands/session-command-handler.js";

const DEFAULT_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-5.5",
  thinkingLevel: "medium",
} as const;

const ALL_PROFILES: ManagerProfile[] = [
  {
    profileId: "manager",
    displayName: "Manager",
    defaultSessionAgentId: "manager",
    defaultModel: { ...DEFAULT_MODEL },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profileType: "user",
  },
  {
    profileId: "_collaboration",
    displayName: "Collaboration",
    defaultSessionAgentId: "_collaboration",
    defaultModel: { ...DEFAULT_MODEL },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profileType: "system",
  },
];

describe("session command handler", () => {
  it("updates session posture and roster with request-correlated effective state", async () => {
    const send = vi.fn();
    const session = {
      agentId: "manager--s2",
      role: "manager",
      profileId: "manager",
      managerPosture: "hands_on",
      managerPostureOrigin: "session_override",
      delegationRosterId: "diverse",
      delegationRosterOrigin: "session_override",
    } as const;
    const updateSessionDelegation = vi.fn(async () => undefined);
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn(() => session),
      updateSessionDelegation,
    };

    const handled = await handleSessionCommand({
      command: {
        type: "update_session_delegation",
        sessionAgentId: session.agentId,
        managerPosture: { mode: "override", value: "hands_on" },
        delegationRoster: { mode: "override", rosterId: "diverse" },
        requestId: "delegation-1",
      },
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(updateSessionDelegation).toHaveBeenCalledWith(session.agentId, {
      managerPosture: { mode: "override", value: "hands_on" },
      delegationRoster: { mode: "override", rosterId: "diverse" },
    });
    expect(send).toHaveBeenCalledWith(expect.anything(), {
      type: "session_delegation_updated",
      sessionAgentId: session.agentId,
      managerPosture: "hands_on",
      managerPostureOrigin: "session_override",
      delegationRosterId: "diverse",
      delegationRosterOrigin: "session_override",
      requestId: "delegation-1",
    });
  });

  it("routes user goal controls to the scoped Builder session", async () => {
    const send = vi.fn();
    const controlSessionGoal = vi.fn(async () => undefined);
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) => ({ agentId, role: "manager", profileId: "manager" })),
      controlSessionGoal,
    };

    const handled = await handleSessionCommand({
      command: {
        type: "session_goal_control",
        agentId: "manager--s2",
        action: "edit",
        objective: "Refined outcome",
        tokenBudget: 20_000,
      },
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(controlSessionGoal).toHaveBeenCalledWith("manager--s2", expect.objectContaining({
      action: "edit",
      objective: "Refined outcome",
      tokenBudget: 20_000,
    }));
    expect(send).not.toHaveBeenCalled();
  });

  it("delivers negotiated goal-control success directly to its captured origin", async () => {
    const send = vi.fn();
    const controlSessionGoal = vi.fn(async () => ({
      revision: 2,
      measuredAt: "2026-07-22T00:00:00.000Z",
      goal: null,
    }));
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) => ({ agentId, role: "manager", profileId: "manager" })),
      controlSessionGoal,
    };

    await handleSessionCommand({
      command: {
        type: "session_goal_control",
        agentId: "manager--s2",
        action: "pause",
        requestId: "goal-control-1",
      },
      socket: {} as never,
      subscribedAgentId: "manager--s2",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
      supportsGoalControlRequestId: true,
    });

    expect(controlSessionGoal).toHaveBeenCalledWith(
      "manager--s2",
      expect.objectContaining({ action: "pause", requestId: "goal-control-1" }),
    );
    expect(send).toHaveBeenCalledWith(expect.anything(), {
      type: "session_goal_snapshot",
      sessionAgentId: "manager--s2",
      profileId: "manager",
      revision: 2,
      measuredAt: "2026-07-22T00:00:00.000Z",
      goal: null,
      requestId: "goal-control-1",
    });
  });

  it("echoes goal-control failure correlation only when negotiated", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) => ({ agentId, role: "manager", profileId: "manager" })),
      controlSessionGoal: vi.fn(async () => { throw new Error("No active goal"); }),
    };
    const command = {
      type: "session_goal_control" as const,
      agentId: "manager--s2",
      action: "pause" as const,
      requestId: "goal-control-failure",
    };
    const common = {
      command,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    };

    await handleSessionCommand({ ...common, supportsGoalControlRequestId: true });
    await handleSessionCommand({ ...common, supportsGoalControlRequestId: false });

    expect(send.mock.calls[0]?.[1]).toMatchObject({
      type: "error",
      code: "SESSION_GOAL_CONTROL_FAILED",
      requestId: "goal-control-failure",
    });
    expect(send.mock.calls[1]?.[1]).toEqual({
      type: "error",
      code: "SESSION_GOAL_CONTROL_FAILED",
      message: "No active goal",
    });
  });

  it("handles archive_session and restore_session commands with request-correlated events", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) => ({ agentId, role: "manager", profileId: "manager" })),
      archiveSession: vi.fn(async () => ({
        agentId: "manager--s2",
        profileId: "manager",
        archivedAt: "2026-05-20T00:00:00.000Z",
        terminatedWorkerIds: ["worker-1", "worker-2"],
      })),
      restoreSession: vi.fn(async () => ({
        agentId: "manager--s2",
        profileId: "manager",
        openAgentId: "manager--s2",
      })),
    };

    const handleDeletedAgentSubscriptions = vi.fn();

    await handleSessionCommand({
      command: { type: "archive_session", agentId: "manager--s2", requestId: "req-archive" } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions,
    });

    await handleSessionCommand({
      command: { type: "restore_session", agentId: "manager--s2", requestId: "req-restore" } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions,
    });

    expect(swarmManager.archiveSession).toHaveBeenCalledWith("manager--s2");
    expect(swarmManager.restoreSession).toHaveBeenCalledWith("manager--s2");
    expect(handleDeletedAgentSubscriptions).toHaveBeenCalledWith(new Set(["worker-1", "worker-2"]));
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_archived",
        agentId: "manager--s2",
        profileId: "manager",
        archivedAt: "2026-05-20T00:00:00.000Z",
        requestId: "req-archive",
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_restored",
        agentId: "manager--s2",
        profileId: "manager",
        openAgentId: "manager--s2",
        requestId: "req-restore",
      }),
    );
  });

  it("stop_session does not unsubscribe preserved Codex external-thread sidecar ids", async () => {
    const send = vi.fn();
    const handleDeletedAgentSubscriptions = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) => ({ agentId, role: "manager", profileId: "manager" })),
      stopSession: vi.fn(async () => ({ terminatedWorkerIds: [] })),
    };

    await handleSessionCommand({
      command: { type: "stop_session", agentId: "manager", requestId: "req-stop" } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions,
    });

    expect(handleDeletedAgentSubscriptions).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_stopped",
        agentId: "manager",
        terminatedWorkerIds: [],
        requestId: "req-stop",
      }),
    );
  });

  it("archive_session unsubscribes only truly deleted worker ids", async () => {
    const send = vi.fn();
    const handleDeletedAgentSubscriptions = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) => ({ agentId, role: "manager", profileId: "manager" })),
      archiveSession: vi.fn(async () => ({
        agentId: "manager--s2",
        profileId: "manager",
        archivedAt: "2026-05-20T00:00:00.000Z",
        terminatedWorkerIds: ["worker-1"],
      })),
    };

    await handleSessionCommand({
      command: { type: "archive_session", agentId: "manager--s2", requestId: "req-archive-stop" } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions,
    });

    expect(handleDeletedAgentSubscriptions).toHaveBeenCalledWith(new Set(["worker-1"]));
  });

  it("rejects archive_session and restore_session inside system-managed profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) => ({ agentId, role: "manager", profileId: "_collaboration" })),
      archiveSession: vi.fn(async () => ({
        agentId: "_collaboration--s2",
        profileId: "_collaboration",
        archivedAt: "2026-05-20T00:00:00.000Z",
      })),
      restoreSession: vi.fn(async () => ({
        agentId: "_collaboration--s2",
        profileId: "_collaboration",
        openAgentId: "_collaboration--s2",
      })),
    };

    await handleSessionCommand({
      command: { type: "archive_session", agentId: "_collaboration--s2", requestId: "req-system-archive" } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    await handleSessionCommand({
      command: { type: "restore_session", agentId: "_collaboration--s2", requestId: "req-system-restore" } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.archiveSession).not.toHaveBeenCalled();
    expect(swarmManager.restoreSession).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "ARCHIVE_SESSION_FAILED",
        message: "Cannot modify sessions in system-managed profiles",
        requestId: "req-system-archive",
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "RESTORE_SESSION_FAILED",
        message: "Cannot modify sessions in system-managed profiles",
        requestId: "req-system-restore",
      }),
    );
  });

  it("updates session model overrides with exact manager model selections while keeping legacy event fields stable", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) => ({ agentId, role: "manager", profileId: "manager" })),
      updateSessionExactModel: vi.fn(async () => ({
        provider: "claude-sdk",
        modelId: "claude-opus-4-7",
        thinkingLevel: "high",
      })),
    };

    await handleSessionCommand({
      command: {
        type: "update_session_model",
        sessionAgentId: "manager--s2",
        mode: "override",
        modelSelection: { provider: "claude-sdk", modelId: "claude-opus-4-7" },
        requestId: "req-session-model-exact",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.updateSessionExactModel).toHaveBeenCalledWith(
      "manager--s2",
      { provider: "claude-sdk", modelId: "claude-opus-4-7" },
      undefined,
    );
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_model_updated",
        sessionAgentId: "manager--s2",
        mode: "override",
        model: "sdk-opus",
        requestId: "req-session-model-exact",
      }),
    );
  });

  it("updates session model overrides with the explicit session command", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) => ({ agentId, role: "manager", profileId: "manager" })),
      updateSessionModel: vi.fn(async () => undefined),
    };

    await handleSessionCommand({
      command: {
        type: "update_session_model",
        sessionAgentId: "manager--s2",
        mode: "override",
        model: "pi-5.4",
        requestId: "req-session-model",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.updateSessionModel).toHaveBeenCalledWith("manager--s2", "override", "pi-5.4", undefined);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_model_updated",
        sessionAgentId: "manager--s2",
        mode: "override",
        model: "pi-5.4",
        requestId: "req-session-model",
      }),
    );
  });

  it("canonicalizes removed Cursor ACP session model aliases before updating and emitting", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) => ({ agentId, role: "manager", profileId: "manager" })),
      updateSessionModel: vi.fn(async () => undefined),
    };

    await handleSessionCommand({
      command: {
        type: "update_session_model",
        sessionAgentId: "manager--s2",
        mode: "override",
        model: "cursor-acp",
        requestId: "req-session-model-cursor-acp",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.updateSessionModel).toHaveBeenCalledWith("manager--s2", "override", "cursor-composer", undefined);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_model_updated",
        sessionAgentId: "manager--s2",
        mode: "override",
        model: "cursor-composer",
        requestId: "req-session-model-cursor-acp",
      }),
    );
  });

  it("rejects session model changes inside system-managed profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) => ({ agentId, role: "manager", profileId: "_collaboration" })),
      updateSessionModel: vi.fn(async () => undefined),
    };

    await handleSessionCommand({
      command: {
        type: "update_session_model",
        sessionAgentId: "_collaboration--s2",
        mode: "inherit",
        requestId: "req-system-session-model",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.updateSessionModel).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "UPDATE_SESSION_MODEL_FAILED",
        message: "Cannot modify sessions in system-managed profiles",
        requestId: "req-system-session-model",
      }),
    );
  });
});
