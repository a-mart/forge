import { describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@forge/protocol";
import { handleSessionCommand } from "../ws/routes/session-routes.js";

const DEFAULT_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-5.3-codex",
  thinkingLevel: "medium",
} as const;

const USER_PROFILES = [
  {
    profileId: "profile-a",
    displayName: "Profile A",
    defaultSessionAgentId: "profile-a",
    defaultModel: { ...DEFAULT_MODEL },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profileType: "user" as const,
  },
];

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
      listProfiles: vi.fn(() => USER_PROFILES),
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

  it("rejects create_session for system-managed profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => [
        ...USER_PROFILES,
        {
          profileId: "_collaboration",
          displayName: "Collaboration",
          defaultSessionAgentId: "_collaboration",
          defaultModel: { ...DEFAULT_MODEL },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          profileType: "system" as const,
        },
      ]),
      createSession: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    };

    await handleSessionCommand({
      command: { type: "create_session", profileId: "_collaboration", requestId: "req-system-create" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.createSession).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "CREATE_SESSION_FAILED",
        message: "Cannot modify system-managed profile",
        requestId: "req-system-create",
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
      listProfiles: vi.fn(() => USER_PROFILES),
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

  it("rejects delete_session for system-managed profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => [
        ...USER_PROFILES,
        {
          profileId: "_collaboration",
          displayName: "Collaboration",
          defaultSessionAgentId: "_collaboration",
          defaultModel: { ...DEFAULT_MODEL },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          profileType: "system" as const,
        },
      ]),
      getAgent: vi.fn(() => ({ agentId: "collab-session", role: "manager", profileId: "_collaboration" })),
      deleteSession: vi.fn(async () => ({ terminatedWorkerIds: [] })),
    };

    await handleSessionCommand({
      command: { type: "delete_session", agentId: "collab-session", requestId: "req-system-delete" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.deleteSession).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "DELETE_SESSION_FAILED",
        message: "Cannot modify sessions in system-managed profiles",
        requestId: "req-system-delete",
      }),
    );
  });

  it("clears Builder sessions and resets unread state", async () => {
    const send = vi.fn();
    const clearSession = vi.fn();
    const broadcastUnreadCountUpdate = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => USER_PROFILES),
      getAgent: vi.fn(() => ({ agentId: "session-1", role: "manager", profileId: "profile-a" })),
      clearSessionConversation: vi.fn(async () => undefined),
    };

    await handleSessionCommand({
      command: { type: "clear_session", agentId: "session-1", requestId: "req-clear" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
      unreadTracker: { clearSession } as never,
      broadcastUnreadCountUpdate,
    });

    expect(swarmManager.clearSessionConversation).toHaveBeenCalledWith("session-1");
    expect(clearSession).toHaveBeenCalledWith("profile-a", "session-1");
    expect(broadcastUnreadCountUpdate).toHaveBeenCalledWith("session-1", 0);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_cleared",
        agentId: "session-1",
        requestId: "req-clear",
      }),
    );
  });

  it("rejects clear_session for system-managed profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => [
        ...USER_PROFILES,
        {
          profileId: "_collaboration",
          displayName: "Collaboration",
          defaultSessionAgentId: "_collaboration",
          defaultModel: { ...DEFAULT_MODEL },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          profileType: "system" as const,
        },
      ]),
      getAgent: vi.fn(() => ({ agentId: "collab-session", role: "manager", profileId: "_collaboration" })),
      clearSessionConversation: vi.fn(async () => undefined),
    };

    await handleSessionCommand({
      command: { type: "clear_session", agentId: "collab-session", requestId: "req-system-clear" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.clearSessionConversation).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "CLEAR_SESSION_FAILED",
        message: "Cannot modify sessions in system-managed profiles",
        requestId: "req-system-clear",
      }),
    );
  });

  it("renames Builder sessions", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => USER_PROFILES),
      getAgent: vi.fn(() => ({ agentId: "session-1", role: "manager", profileId: "profile-a" })),
      renameSession: vi.fn(async () => undefined),
    };

    await handleSessionCommand({
      command: { type: "rename_session", agentId: "session-1", label: "Renamed", requestId: "req-rename-ok" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.renameSession).toHaveBeenCalledWith("session-1", "Renamed");
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session_renamed",
        agentId: "session-1",
        label: "Renamed",
        requestId: "req-rename-ok",
      }),
    );
  });

  it("rejects rename_session for system-managed profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => [
        ...USER_PROFILES,
        {
          profileId: "_collaboration",
          displayName: "Collaboration",
          defaultSessionAgentId: "_collaboration",
          defaultModel: { ...DEFAULT_MODEL },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          profileType: "system" as const,
        },
      ]),
      getAgent: vi.fn(() => ({ agentId: "collab-session", role: "manager", profileId: "_collaboration" })),
      renameSession: vi.fn(async () => undefined),
    };

    await handleSessionCommand({
      command: { type: "rename_session", agentId: "collab-session", label: "Renamed", requestId: "req-system-rename" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.renameSession).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "RENAME_SESSION_FAILED",
        message: "Cannot modify sessions in system-managed profiles",
        requestId: "req-system-rename",
      }),
    );
  });

  it("returns rename failures with the RENAME_SESSION_FAILED error code", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => USER_PROFILES),
      getAgent: vi.fn((agentId: string) => {
        if (agentId === "session-1") {
          return { agentId: "session-1", role: "manager", profileId: "profile-a" };
        }
        return undefined;
      }),
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
      listProfiles: vi.fn(() => USER_PROFILES),
      getAgent: vi.fn(() => ({ agentId: "session-1", role: "manager", profileId: "profile-a" })),
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

  it("rejects pin_session for system-managed profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => [
        ...USER_PROFILES,
        {
          profileId: "_collaboration",
          displayName: "Collaboration",
          defaultSessionAgentId: "_collaboration",
          defaultModel: { ...DEFAULT_MODEL },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          profileType: "system" as const,
        },
      ]),
      getAgent: vi.fn(() => ({ agentId: "collab-session", role: "manager", profileId: "_collaboration" })),
      pinSession: vi.fn(async () => ({ pinnedAt: "2026-04-08T12:00:00.000Z" })),
    };

    await handleSessionCommand({
      command: { type: "pin_session", agentId: "collab-session", pinned: true, requestId: "req-system-pin" } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.pinSession).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "PIN_SESSION_FAILED",
        message: "Cannot modify sessions in system-managed profiles",
        requestId: "req-system-pin",
      }),
    );
  });

  it("forks sessions and preserves the optional fromMessageId in the response", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => USER_PROFILES),
      getAgent: vi.fn((agentId: string) => {
        if (agentId === "session-1") {
          return { agentId: "session-1", role: "manager", profileId: "profile-a" };
        }
        return undefined;
      }),
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

  it("rejects fork_session for system-managed profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => [
        ...USER_PROFILES,
        {
          profileId: "_collaboration",
          displayName: "Collaboration",
          defaultSessionAgentId: "_collaboration",
          defaultModel: { ...DEFAULT_MODEL },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          profileType: "system" as const,
        },
      ]),
      getAgent: vi.fn(() => ({ agentId: "collab-session", role: "manager", profileId: "_collaboration" })),
      forkSession: vi.fn(async () => ({
        sessionAgent: { agentId: "forked", role: "manager", label: "Forked" },
        profile: { profileId: "_collaboration", displayName: "Collaboration" },
      })),
    };

    await handleSessionCommand({
      command: {
        type: "fork_session",
        sourceAgentId: "collab-session",
        requestId: "req-system-fork",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager-1",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager-1"),
      send,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.forkSession).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "FORK_SESSION_FAILED",
        message: "Cannot modify sessions in system-managed profiles",
        requestId: "req-system-fork",
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
