import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ManagerBootstrapCoordinator } from "../manager-bootstrap-coordinator.js";
import type { AgentDescriptor } from "../types.js";

function manager(
  agentId = "manager",
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId: "profile",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/repo/forge",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  };
}

async function createHarness(options?: {
  descriptor?: AgentDescriptor;
  hasRuntime?: boolean;
  resolvePrompt?: (category: string, promptId: string, profileId?: string) => Promise<string>;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-manager-bootstrap-"));
  const descriptor = options?.descriptor ?? manager();
  const descriptors = new Map([[descriptor.agentId, descriptor]]);
  const resolve = vi.fn(
    options?.resolvePrompt ??
      (async (_category: string, promptId: string) => `resolved:${promptId}`),
  );
  const sendMessage = vi.fn(async (_from: string, targetAgentId: string) => ({
    targetAgentId,
    deliveryId: "delivery-1",
    acceptedMode: "queued" as const,
  }));
  const logDebug = vi.fn();
  const coordinator = new ManagerBootstrapCoordinator({
    dataDir,
    descriptors,
    promptRegistry: { resolve },
    hasRuntime: () => options?.hasRuntime ?? true,
    sendMessage,
    logDebug,
  });
  return { coordinator, resolve, sendMessage, logDebug };
}

describe("ManagerBootstrapCoordinator", () => {
  it("sends the resolved project bootstrap as an internal manager turn", async () => {
    const harness = await createHarness();

    await harness.coordinator.sendManagerBootstrapMessage("manager");

    expect(harness.resolve).toHaveBeenNthCalledWith(
      1,
      "operational",
      "bootstrap",
      "profile",
    );
    expect(harness.sendMessage).toHaveBeenCalledWith(
      "manager",
      "manager",
      "resolved:bootstrap",
      "auto",
      { origin: "internal", internalDeliveryKind: "bootstrap" },
    );
    expect(harness.logDebug).toHaveBeenCalledWith("manager:bootstrap_message:sent", {
      managerId: "manager",
    });
  });

  it("does not bootstrap missing, non-running, or runtime-less managers", async () => {
    const stopped = await createHarness({
      descriptor: manager("stopped", { status: "stopped" }),
    });
    const runtimeLess = await createHarness({ hasRuntime: false });

    await stopped.coordinator.sendManagerBootstrapMessage("stopped");
    await runtimeLess.coordinator.sendManagerBootstrapMessage("manager");
    await runtimeLess.coordinator.sendManagerBootstrapMessage("missing");

    expect(stopped.resolve).not.toHaveBeenCalled();
    expect(stopped.sendMessage).not.toHaveBeenCalled();
    expect(runtimeLess.resolve).not.toHaveBeenCalled();
    expect(runtimeLess.sendMessage).not.toHaveBeenCalled();
  });

  it("returns the exact fallback and records prompt resolution failures", async () => {
    const harness = await createHarness({
      resolvePrompt: async () => {
        throw new Error("prompt unavailable");
      },
    });

    await expect(
      harness.coordinator.resolvePromptWithFallback(
        "operational",
        "custom",
        "profile",
        "fallback text",
      ),
    ).resolves.toBe("fallback text");
    expect(harness.logDebug).toHaveBeenCalledWith("prompt:resolve:fallback", {
      category: "operational",
      promptId: "custom",
      profileId: "profile",
      message: "prompt unavailable",
    });
  });

  it("gathers and injects bounded agent-creator seed context as an internal turn", async () => {
    const harness = await createHarness({
      descriptor: manager("creator-session"),
    });

    await harness.coordinator.injectAgentCreatorContext("creator-session", "profile");

    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      "creator-session",
      "creator-session",
      expect.stringContaining("<agent_creator_seed_context>"),
      "auto",
      { origin: "internal", internalDeliveryKind: "agent_creator_bootstrap" },
    );
    expect(harness.sendMessage.mock.calls[0]?.[2]).toContain("projectCwd: /repo/forge");
    expect(harness.logDebug).toHaveBeenCalledWith("agent_creator:context:injected", {
      sessionAgentId: "creator-session",
      profileId: "profile",
      agentCount: 0,
      recentSessionCount: 0,
    });
  });

  it("contains delivery failures and reports them without failing manager creation", async () => {
    const harness = await createHarness();
    harness.sendMessage.mockRejectedValueOnce(new Error("delivery failed"));

    await expect(
      harness.coordinator.sendManagerBootstrapMessage("manager"),
    ).resolves.toBeUndefined();
    expect(harness.logDebug).toHaveBeenCalledWith("manager:bootstrap_message:error", {
      managerId: "manager",
      message: "delivery failed",
    });
  });
});
