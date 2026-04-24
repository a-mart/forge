import { describe, expect, it, vi } from "vitest";
import type { ManagerProfile } from "@forge/protocol";
import { handleManagerCommand } from "../ws/commands/manager-command-handler.js";

const DEFAULT_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-5.3-codex",
  thinkingLevel: "medium",
} as const;

const USER_PROFILES: ManagerProfile[] = [
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
    profileId: "alpha",
    displayName: "Alpha",
    defaultSessionAgentId: "alpha",
    defaultModel: { ...DEFAULT_MODEL },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profileType: "user",
  },
  {
    profileId: "beta",
    displayName: "Beta",
    defaultSessionAgentId: "beta",
    defaultModel: { ...DEFAULT_MODEL },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profileType: "user",
  },
];

const ALL_PROFILES: ManagerProfile[] = [
  ...USER_PROFILES,
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

describe("manager command handler", () => {
  it("deletes user profiles", async () => {
    const send = vi.fn();
    const broadcastToSubscribed = vi.fn();
    const handleDeletedAgentSubscriptions = vi.fn();
    const clearProfile = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      deleteManager: vi.fn(async () => ({ managerId: "alpha", terminatedWorkerIds: ["worker-1"] })),
    };

    await handleManagerCommand({
      command: { type: "delete_manager", managerId: "alpha", requestId: "req-delete" } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      broadcastToSubscribed,
      handleDeletedAgentSubscriptions,
      unreadTracker: { clearProfile } as never,
    });

    expect(swarmManager.deleteManager).toHaveBeenCalledWith("manager", "alpha");
    expect(handleDeletedAgentSubscriptions).toHaveBeenCalledWith(new Set(["alpha", "worker-1"]));
    expect(clearProfile).toHaveBeenCalledWith("alpha");
    expect(broadcastToSubscribed).toHaveBeenCalledWith({
      type: "manager_deleted",
      managerId: "alpha",
      terminatedWorkerIds: ["worker-1"],
      requestId: "req-delete",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects delete_manager for system profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      deleteManager: vi.fn(async () => ({ managerId: "_collaboration", terminatedWorkerIds: [] })),
    };

    await handleManagerCommand({
      command: { type: "delete_manager", managerId: "_collaboration", requestId: "req-system-delete" } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      broadcastToSubscribed: vi.fn(),
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.deleteManager).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "DELETE_MANAGER_FAILED",
        message: "Cannot modify system-managed profile",
        requestId: "req-system-delete",
      }),
    );
  });

  it("renames user profiles", async () => {
    const broadcastToSubscribed = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      renameProfile: vi.fn(async () => undefined),
    };

    await handleManagerCommand({
      command: { type: "rename_profile", profileId: "alpha", displayName: "Alpha Renamed", requestId: "req-rename" } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send: vi.fn(),
      broadcastToSubscribed,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.renameProfile).toHaveBeenCalledWith("alpha", "Alpha Renamed");
    expect(broadcastToSubscribed).toHaveBeenCalledWith({
      type: "profile_renamed",
      profileId: "alpha",
      displayName: "Alpha Renamed",
      requestId: "req-rename",
    });
  });

  it("rejects rename_profile for system profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      renameProfile: vi.fn(async () => undefined),
    };

    await handleManagerCommand({
      command: {
        type: "rename_profile",
        profileId: "_collaboration",
        displayName: "Collab Renamed",
        requestId: "req-system-rename",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      broadcastToSubscribed: vi.fn(),
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.renameProfile).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "RENAME_PROFILE_FAILED",
        message: "Cannot modify system-managed profile",
        requestId: "req-system-rename",
      }),
    );
  });

  it("reorders user profiles", async () => {
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      reorderProfiles: vi.fn(async () => undefined),
    };

    await handleManagerCommand({
      command: { type: "reorder_profiles", profileIds: ["beta", "alpha"], requestId: "req-reorder" } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send: vi.fn(),
      broadcastToSubscribed: vi.fn(),
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.reorderProfiles).toHaveBeenCalledWith(["beta", "alpha"]);
  });

  it("filters system profiles out of reorder lists", async () => {
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      reorderProfiles: vi.fn(async () => undefined),
    };

    await handleManagerCommand({
      command: {
        type: "reorder_profiles",
        profileIds: ["beta", "_collaboration", "alpha"],
        requestId: "req-system-reorder",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send: vi.fn(),
      broadcastToSubscribed: vi.fn(),
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.reorderProfiles).toHaveBeenCalledWith(["beta", "alpha"]);
  });

  it("rejects update_manager_model for system profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn(() => undefined),
      updateManagerModel: vi.fn(async () => undefined),
    };

    await handleManagerCommand({
      command: {
        type: "update_manager_model",
        managerId: "_collaboration",
        model: "balanced",
        requestId: "req-system-model",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      broadcastToSubscribed: vi.fn(),
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.updateManagerModel).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "UPDATE_MANAGER_MODEL_FAILED",
        message: "Cannot modify system-managed profile",
        requestId: "req-system-model",
      }),
    );
  });

  it("updates profile default models with the new explicit command", async () => {
    const broadcastToSubscribed = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      updateProfileDefaultModel: vi.fn(async () => undefined),
    };

    await handleManagerCommand({
      command: {
        type: "update_profile_default_model",
        profileId: "alpha",
        model: "pi-5.4",
        requestId: "req-default-model",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send: vi.fn(),
      broadcastToSubscribed,
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.updateProfileDefaultModel).toHaveBeenCalledWith("alpha", "pi-5.4", undefined);
    expect(broadcastToSubscribed).toHaveBeenCalledWith({
      type: "profile_default_model_updated",
      profileId: "alpha",
      model: "pi-5.4",
      reasoningLevel: undefined,
      requestId: "req-default-model",
    });
  });

  it("rejects update_manager_model when targeting a session inside a system-managed profile", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      getAgent: vi.fn((agentId: string) =>
        agentId === "_collaboration--s2"
          ? { agentId, role: "manager", profileId: "_collaboration" }
          : undefined,
      ),
      updateManagerModel: vi.fn(async () => undefined),
    };

    await handleManagerCommand({
      command: {
        type: "update_manager_model",
        managerId: "_collaboration--s2",
        model: "balanced",
        requestId: "req-system-session-model",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      broadcastToSubscribed: vi.fn(),
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.updateManagerModel).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "UPDATE_MANAGER_MODEL_FAILED",
        message: "Cannot modify sessions in system-managed profiles",
        requestId: "req-system-session-model",
      }),
    );
  });

  it("rejects update_manager_cwd for system profiles", async () => {
    const send = vi.fn();
    const swarmManager = {
      listProfiles: vi.fn(() => ALL_PROFILES),
      updateManagerCwd: vi.fn(async () => "/tmp/collab"),
    };

    await handleManagerCommand({
      command: {
        type: "update_manager_cwd",
        managerId: "_collaboration",
        cwd: "/tmp/collab",
        requestId: "req-system-cwd",
      } as never,
      socket: {} as never,
      subscribedAgentId: "manager",
      swarmManager: swarmManager as never,
      resolveManagerContextAgentId: vi.fn(() => "manager"),
      send,
      broadcastToSubscribed: vi.fn(),
      handleDeletedAgentSubscriptions: vi.fn(),
    });

    expect(swarmManager.updateManagerCwd).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "error",
        code: "UPDATE_MANAGER_CWD_FAILED",
        message: "Cannot modify system-managed profile",
        requestId: "req-system-cwd",
      }),
    );
  });
});
