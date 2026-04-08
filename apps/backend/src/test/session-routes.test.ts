import { describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@forge/protocol";
import { handleSessionCommand } from "../ws/routes/session-routes.js";

describe("session routes", () => {
  it("returns false for non-session commands", async () => {
    const send = vi.fn();

    const handled = await handleSessionCommand({
      command: { type: "send_message", requestId: "req-1" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: {} as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(handled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("emits UNKNOWN_AGENT when the subscribed manager context cannot be resolved", async () => {
    const send = vi.fn();

    const handled = await handleSessionCommand({
      command: { type: "create_session", profileId: "profile-a", requestId: "req-1" } as never,
      socket: {} as never,
      subscribedAgentId: "missing-manager",
      swarmManager: {} as never,
      resolveManagerContextAgentId: vi.fn(() => undefined),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "UNKNOWN_AGENT",
        message: "Agent missing-manager does not exist.",
        requestId: "req-1",
      }),
    );
  });

  it("creates sessions and returns profile and sessionAgent payloads", async () => {
    const send = vi.fn();
    const created = {
      profile: { profileId: "profile-a", displayName: "Profile A" },
      sessionAgent: { agentId: "session-1", role: "manager", label: "Session 1" },
    };
    const swarmManager = {
      createSession: vi.fn(async () => created),
    };

    const handled = await handleSessionCommand({
      command: {
        type: "create_session",
        profileId: "profile-a",
        label: "Session 1",
        name: "Session 1",
        sessionPurpose: "general",
        requestId: "req-2",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(swarmManager.createSession).toHaveBeenCalledWith("profile-a", {
      label: "Session 1",
      name: "Session 1",
      sessionPurpose: "general",
    });
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_created",
        profile: created.profile,
        sessionAgent: created.sessionAgent,
        requestId: "req-2",
      }),
    );
  });

  it("stops worker sessions using stopWorker and resolves the manager profile id", async () => {
    const send = vi.fn();
    const swarmManager = {
      getAgent: vi.fn((agentId: string) => {
        if (agentId === "worker-1") {
          return { agentId: "worker-1", role: "worker", managerId: "manager-1" };
        }
        if (agentId === "manager-1") {
          return { agentId: "manager-1", role: "manager", profileId: "profile-a" };
        }
        return undefined;
      }),
      stopWorker: vi.fn(async () => undefined),
    };

    await handleSessionCommand({
      command: { type: "stop_session", agentId: "worker-1", requestId: "req-3" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.stopWorker).toHaveBeenCalledWith("worker-1");
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_stopped",
        agentId: "worker-1",
        profileId: "profile-a",
        terminatedWorkerIds: [],
        requestId: "req-3",
      }),
    );
  });

  it("deletes sessions, clears unread state, and removes subscriptions for the session and workers", async () => {
    const send = vi.fn();
    const clearSession = vi.fn();
    const broadcastUnreadCountUpdate = vi.fn();
    const handleDeletedAgentSubscriptions = vi.fn();
    const swarmManager = {
      getAgent: vi.fn((agentId: string) => {
        if (agentId === "session-1") {
          return { agentId: "session-1", role: "manager", profileId: "profile-a" };
        }
        return undefined;
      }),
      deleteSession: vi.fn(async () => ({ terminatedWorkerIds: ["worker-1", "worker-2"] })),
    };

    await handleSessionCommand({
      command: { type: "delete_session", agentId: "session-1", requestId: "req-4" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions,
      unreadTracker: { clearSession } as never,
      broadcastUnreadCountUpdate,
    });

    expect(swarmManager.deleteSession).toHaveBeenCalledWith("session-1");
    expect(handleDeletedAgentSubscriptions).toHaveBeenCalledWith(new Set(["session-1", "worker-1", "worker-2"]));
    expect(clearSession).toHaveBeenCalledWith("profile-a", "session-1");
    expect(broadcastUnreadCountUpdate).toHaveBeenCalledWith("session-1", 0);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_deleted",
        agentId: "session-1",
        profileId: "profile-a",
        terminatedWorkerIds: ["worker-1", "worker-2"],
        requestId: "req-4",
      }),
    );
  });

  it("returns rename failures with the RENAME_SESSION_FAILED error code", async () => {
    const send = vi.fn();
    const swarmManager = {
      renameSession: vi.fn(async () => {
        throw new Error("rename exploded");
      }),
    };

    await handleSessionCommand({
      command: { type: "rename_session", agentId: "session-1", label: "Renamed", requestId: "req-5" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "RENAME_SESSION_FAILED",
        message: "rename exploded",
        requestId: "req-5",
      }),
    );
  });

  it("pins sessions and returns pinnedAt metadata", async () => {
    const send = vi.fn();
    const swarmManager = {
      pinSession: vi.fn(async () => ({ pinnedAt: "2026-04-08T12:00:00.000Z" })),
    };

    await handleSessionCommand({
      command: { type: "pin_session", agentId: "session-1", pinned: true, requestId: "req-6" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.pinSession).toHaveBeenCalledWith("session-1", true);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_pinned",
        agentId: "session-1",
        pinned: true,
        pinnedAt: "2026-04-08T12:00:00.000Z",
        requestId: "req-6",
      }),
    );
  });

  it("forks sessions and preserves the optional fromMessageId in the response", async () => {
    const send = vi.fn();
    const swarmManager = {
      forkSession: vi.fn(async () => ({
        sessionAgent: { agentId: "session-2", role: "manager", label: "Fork" },
        profile: { profileId: "profile-a", displayName: "Profile A" },
      })),
    };

    await handleSessionCommand({
      command: {
        type: "fork_session",
        sourceAgentId: "session-1",
        label: "Fork",
        fromMessageId: "message-42",
        requestId: "req-7",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.forkSession).toHaveBeenCalledWith("session-1", {
      label: "Fork",
      fromMessageId: "message-42",
    });
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_forked",
        sourceAgentId: "session-1",
        newSessionAgent: expect.objectContaining({ agentId: "session-2" }),
        profile: expect.objectContaining({ profileId: "profile-a" }),
        fromMessageId: "message-42",
        requestId: "req-7",
      }),
    );
  });

  it("emits merge start and projects diagnostics onto session_memory_merge_failed", async () => {
    const send = vi.fn<(socket: unknown, event: ServerEvent) => void>();
    const swarmManager = {
      mergeSessionMemory: vi.fn(async () => {
        const error = new Error("merge failed");
        Object.assign(error, {
          strategy: "llm_review",
          stage: "merge",
          auditPath: "/tmp/audit.md",
        });
        throw error;
      }),
    };

    await handleSessionCommand({
      command: { type: "merge_session_memory", agentId: "session-1", requestId: "req-8" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(send.mock.calls[0]?.[1]).toEqual({
      type: "session_memory_merge_started",
      agentId: "session-1",
      requestId: "req-8",
    });
    expect(send.mock.calls[1]?.[1]).toEqual({
      type: "session_memory_merge_failed",
      agentId: "session-1",
      message: "merge failed",
      status: "failed",
      strategy: "llm_review",
      stage: "merge",
      auditPath: "/tmp/audit.md",
      requestId: "req-8",
    });
  });
});
