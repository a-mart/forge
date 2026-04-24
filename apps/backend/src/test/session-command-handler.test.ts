import { describe, expect, it, vi } from "vitest";
import type { ManagerProfile } from "@forge/protocol";
import { handleSessionCommand } from "../ws/commands/session-command-handler.js";

const DEFAULT_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-5.3-codex",
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
