import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type {
  CodexAppServerClientHandlers,
  CodexAppServerClientPort,
} from "../codex-app-server/types.js";
import { buildModelChangeRecoveryContext } from "../runtime/model-change-recovery-context.js";
import { shouldExcludeConversationMessageFromModelContext } from "../external-threads.js";
import {
  getReservedProjectAgentHandleError,
  isReservedProjectAgentHandle,
} from "../agents/project-agents.js";
import type { AgentDescriptor } from "../types.js";
import { TestSwarmManager, bootWithDefaultManager } from "../../test-support/index.js";
import { createTempConfig } from "../../test-support/temp-config.js";

class FakeCodexAppServerClient implements CodexAppServerClientPort {
  constructor(readonly handlers: CodexAppServerClientHandlers) {}

  async connect(): Promise<void> {}

  async request<T>(method: string): Promise<T> {
    if (method === "thread/start") {
      return { thread: { id: "thread-test" } } as T;
    }

    if (method === "turn/start") {
      const turnId = "turn-1";
      queueMicrotask(async () => {
        await this.handlers.onNotification?.("item/completed", {
          turn: { id: turnId },
          item: { type: "agentMessage", text: "Codex says hi" },
        });
        await this.handlers.onNotification?.("turn/completed", { turn: { id: turnId } });
      });
      return { turn: { id: turnId } } as T;
    }

    if (method === "plugin/list") {
      return { plugins: [] } as T;
    }

    throw new Error(`Unexpected fake request: ${method}`);
  }

  notify(): void {}

  dispose(): void {}

  isDisposed(): boolean {
    return false;
  }
}

class BusyCodexAppServerClient implements CodexAppServerClientPort {
  turnCounter = 0;

  constructor(readonly handlers: CodexAppServerClientHandlers) {}

  async connect(): Promise<void> {}

  async request<T>(method: string): Promise<T> {
    if (method === "thread/start") {
      return { thread: { id: "thread-busy" } } as T;
    }

    if (method === "turn/start") {
      this.turnCounter += 1;
      return { turn: { id: `turn-${this.turnCounter}` } } as T;
    }

    if (method === "plugin/list") {
      return { plugins: [] } as T;
    }

    throw new Error(`Unexpected busy fake request: ${method}`);
  }

  notify(): void {}

  dispose(): void {}

  isDisposed(): boolean {
    return false;
  }
}

class FailingConnectCodexAppServerClient implements CodexAppServerClientPort {
  constructor(readonly handlers: CodexAppServerClientHandlers) {}

  async connect(): Promise<void> {
    throw new Error("connect failed");
  }

  async request<T>(method: string): Promise<T> {
    if (method === "plugin/list") {
      return { plugins: [] } as T;
    }

    throw new Error(`Unexpected failing-connect request: ${method}`);
  }

  notify(): void {}

  dispose(): void {}

  isDisposed(): boolean {
    return false;
  }
}

function createCodexEnabledTestManager(config: Awaited<ReturnType<typeof createTempConfig>>["config"]) {
  return new TestSwarmManager(config, {
    codexAppServerServiceOptions: {
      turnCompletionGraceMs: 25,
      createClient: (handlers) => new FakeCodexAppServerClient(handlers),
    },
  });
}

function createBusyCodexTestManager(config: Awaited<ReturnType<typeof createTempConfig>>["config"]) {
  return new TestSwarmManager(config, {
    codexAppServerServiceOptions: {
      turnCompletionGraceMs: 25,
      createClient: (handlers) => new BusyCodexAppServerClient(handlers),
    },
  });
}

function createFailingConnectCodexTestManager(config: Awaited<ReturnType<typeof createTempConfig>>["config"]) {
  return new TestSwarmManager(config, {
    codexAppServerServiceOptions: {
      turnCompletionGraceMs: 25,
      createClient: (handlers) => new FailingConnectCodexAppServerClient(handlers),
    },
  });
}

function createRecoveringConnectCodexTestManager(config: Awaited<ReturnType<typeof createTempConfig>>["config"]) {
  let shouldFailConnect = true;
  return new TestSwarmManager(config, {
    codexAppServerServiceOptions: {
      turnCompletionGraceMs: 25,
      createClient: (handlers) => {
        if (shouldFailConnect) {
          shouldFailConnect = false;
          return new FailingConnectCodexAppServerClient(handlers);
        }
        return new FakeCodexAppServerClient(handlers);
      },
    },
  });
}

describe("SwarmManager Codex mention routing", () => {
  it("routes leading Builder/web @Codex without dispatching to manager runtime", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex summarize my calendar", {
      sourceContext: { channel: "web" },
    });

    expect(manager.runtimeByAgentId.get("manager")?.sendCalls ?? []).toHaveLength(0);
    expect(manager.listAgents().some((descriptor) => descriptor.agentId === "manager--codex")).toBe(true);

    await vi.waitFor(() => {
      const history = manager.getConversationHistory("manager");
      expect(history.some((entry) => entry.type === "conversation_message" && entry.externalThreadContext?.status === "sent")).toBe(true);
      expect(history.some((entry) => entry.type === "conversation_message" && entry.externalThreadContext?.status === "completed")).toBe(true);
    });
  });

  it("routes direct selected Codex sidecar sends without creating a worker runtime", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex first question", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.listAgents().some((descriptor) => descriptor.agentId === "manager--codex")).toBe(true);
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    await manager.handleUserMessage("follow up without mention", {
      targetAgentId: "manager--codex",
      sourceContext: { channel: "web" },
    });

    expect(manager.createdRuntimeIds).not.toContain("manager--codex");
    expect(manager.runtimeByAgentId.has("manager--codex")).toBe(false);
  });

  it("does not bump manager recency when Codex rejects a busy send", async () => {
    const { config } = await createTempConfig();
    const manager = createBusyCodexTestManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex first question", {
      sourceContext: { channel: "web" },
    });

    const managerAfterFirstSend = manager.getAgent("manager");
    expect(managerAfterFirstSend?.lastUserMessageAt).toBeDefined();
    const updatedAtBeforeRejectedSend = managerAfterFirstSend?.updatedAt;
    const lastUserMessageAtBeforeRejectedSend = managerAfterFirstSend?.lastUserMessageAt;

    await expect(
      manager.handleUserMessage("@Codex second question", {
        sourceContext: { channel: "web" },
      }),
    ).rejects.toThrow(/Codex is busy/);

    const managerAfterRejectedSend = manager.getAgent("manager");
    expect(managerAfterRejectedSend?.updatedAt).toBe(updatedAtBeforeRejectedSend);
    expect(managerAfterRejectedSend?.lastUserMessageAt).toBe(lastUserMessageAtBeforeRejectedSend);
  });

  it("does not persist manager-side Codex activity or recency when connect fails before acceptance", async () => {
    const { config } = await createTempConfig();
    const manager = createFailingConnectCodexTestManager(config);
    await bootWithDefaultManager(manager, config);

    await expect(
      manager.handleUserMessage("@Codex hello", {
        sourceContext: { channel: "web" },
      }),
    ).rejects.toThrow(/connect failed/);

    const managerDescriptor = manager.getAgent("manager");
    expect(managerDescriptor?.lastUserMessageAt).toBeUndefined();
    expect(
      manager
        .getConversationHistory("manager")
        .filter((entry) => entry.type === "conversation_message" && entry.externalThreadContext?.type === "codex_app_server"),
    ).toHaveLength(0);
  });

  it("retries a selected Codex sidecar after setup failure instead of rejecting the error target", async () => {
    const { config } = await createTempConfig();
    const manager = createRecoveringConnectCodexTestManager(config);
    await bootWithDefaultManager(manager, config);

    await expect(
      manager.handleUserMessage("@Codex first attempt", {
        sourceContext: { channel: "web" },
      }),
    ).rejects.toThrow(/connect failed/);

    expect(manager.getAgent("manager--codex")?.status).toBe("error");

    await manager.handleUserMessage("retry via selected sidecar", {
      targetAgentId: "manager--codex",
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
      expect(
        manager
          .getConversationHistory("manager")
          .some((entry) => entry.type === "conversation_message" && entry.externalThreadContext?.status === "completed"),
      ).toBe(true);
    });
  });

  it("rejects direct sends to a terminated selected Codex sidecar", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex first question", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    await manager.killAgent("manager", "manager--codex");
    expect(manager.getAgent("manager--codex")?.status).toBe("terminated");

    await expect(
      manager.handleUserMessage("retry after kill", {
        targetAgentId: "manager--codex",
        sourceContext: { channel: "web" },
      }),
    ).rejects.toThrow(/Target agent is not running: manager--codex/);
  });

  it("rejects fresh @Codex after the sidecar was terminated instead of resurrecting it", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex first question", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    await manager.killAgent("manager", "manager--codex");
    expect(manager.getAgent("manager--codex")?.status).toBe("terminated");

    await expect(
      manager.handleUserMessage("@Codex retry after kill", {
        sourceContext: { channel: "web" },
      }),
    ).rejects.toThrow(/cannot be reused/i);

    expect(manager.getAgent("manager--codex")?.status).toBe("terminated");
  });

  it("rejects unroutable direct sends to a selected Codex sidecar before appending history", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex first question", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    const historyBefore = manager.getConversationHistory("manager--codex").length;

    await expect(
      manager.handleUserMessage("cli follow up", {
        targetAgentId: "manager--codex",
        sourceContext: { channel: "cli" },
      }),
    ).rejects.toThrow(/Builder web sessions/);

    expect(manager.getConversationHistory("manager--codex")).toHaveLength(historyBefore);
  });

  it("skips repo project-agent preflight when a leading @Codex message is diverted to Codex", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    const preflightSpy = vi
      .spyOn(
        manager as unknown as {
          preflightRepoProjectAgentRuntime(descriptor: AgentDescriptor): Promise<void>;
        },
        "preflightRepoProjectAgentRuntime",
      )
      .mockRejectedValue(new Error("preflight should not run for routed Codex turns"));

    await manager.handleUserMessage("@Codex bypass manager preflight", {
      sourceContext: { channel: "web" },
    });

    expect(preflightSpy).not.toHaveBeenCalled();
    expect(manager.listAgents().some((descriptor) => descriptor.agentId === "manager--codex")).toBe(true);
  });

  it("rejects leading @Codex routing when a legacy project agent already owns the codex handle", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> };
    const descriptor = state.descriptors.get("manager");
    expect(descriptor?.role).toBe("manager");
    descriptor!.projectAgent = {
      handle: "codex",
      whenToUse: "Legacy Codex project agent",
    };

    await expect(
      manager.handleUserMessage("@Codex hello", {
        sourceContext: { channel: "web" },
      }),
    ).rejects.toThrow(/project agent handle "codex" is already in use/i);

    expect(manager.listAgents().some((entry) => entry.agentId === "manager--codex")).toBe(false);
    expect(manager.runtimeByAgentId.get("manager")?.sendCalls ?? []).toHaveLength(0);
  });

  it("keeps non-leading @Codex on the normal manager runtime path", async () => {
    const { config } = await createTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("please ask @Codex later", {
      sourceContext: { channel: "web" },
    });

    expect(manager.runtimeByAgentId.get("manager")?.sendCalls).toHaveLength(1);
  });

  it("persists parent cards with manager-owned agentId and model-context exclusion", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex hello", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      const cards = manager
        .getConversationHistory("manager")
        .filter((entry) => entry.type === "conversation_message" && entry.externalThreadContext?.type === "codex_app_server");
      expect(cards.length).toBeGreaterThanOrEqual(2);
    });

    const cards = manager
      .getConversationHistory("manager")
      .filter((entry) => entry.type === "conversation_message" && entry.externalThreadContext?.type === "codex_app_server");

    for (const card of cards) {
      expect(card.agentId).toBe("manager");
      expect(card.externalThreadContext?.sidecarAgentId).toBe("manager--codex");
      expect(shouldExcludeConversationMessageFromModelContext(card)).toBe(true);
    }

    const recovery = buildModelChangeRecoveryContext({
      descriptor: { agentId: "manager", role: "manager" },
      entries: manager.getConversationHistory("manager"),
    });
    expect(recovery.bodyText.includes("Sent to Codex")).toBe(false);
  });

  it("schedules repo-root executable trust prompt when manager message is diverted to Codex", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    await mkdir(join(config.defaultCwd, ".forge", "extensions"), { recursive: true });
    await writeFile(join(config.defaultCwd, ".forge", "extensions", "repo.ts"), "export default () => {}\n", "utf8");
    execFileSync("git", ["init"], { cwd: config.defaultCwd, stdio: "ignore" });

    const choiceService = (manager as unknown as {
      choiceService: { requestUserChoice: ReturnType<typeof vi.fn> };
    }).choiceService;
    const choiceSpy = vi.spyOn(choiceService, "requestUserChoice").mockResolvedValue([
      { questionId: "repo_executable_trust", selectedOptionIds: ["manage_later"] },
    ]);

    await manager.handleUserMessage("@Codex check trust prompt", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(choiceSpy).toHaveBeenCalled();
    });
  });

  it("schedules repo-root executable trust prompt for direct selected Codex sidecar sends", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex create sidecar first", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    await mkdir(join(config.defaultCwd, ".forge", "extensions"), { recursive: true });
    await writeFile(join(config.defaultCwd, ".forge", "extensions", "repo.ts"), "export default () => {}\n", "utf8");
    execFileSync("git", ["init"], { cwd: config.defaultCwd, stdio: "ignore" });

    const choiceService = (manager as unknown as {
      choiceService: { requestUserChoice: ReturnType<typeof vi.fn> };
    }).choiceService;
    const choiceSpy = vi.spyOn(choiceService, "requestUserChoice").mockResolvedValue([
      { questionId: "repo_executable_trust", selectedOptionIds: ["manage_later"] },
    ]);

    await manager.handleUserMessage("direct sidecar trust check", {
      targetAgentId: "manager--codex",
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(choiceSpy).toHaveBeenCalled();
    });
  });

  it("rejects empty @Codex and attachment routes before persistence", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    await expect(
      manager.handleUserMessage("@Codex", {
        sourceContext: { channel: "web" },
      }),
    ).rejects.toThrow(/Add a message after @Codex/);

    await expect(
      manager.handleUserMessage("@Codex hello", {
        sourceContext: { channel: "web" },
        attachments: [{ type: "binary", mimeType: "text/plain", data: "aGVsbG8=", fileName: "note.txt" }],
      }),
    ).rejects.toThrow(/text-only/);

    expect(manager.listAgents().some((descriptor) => descriptor.agentId === "manager--codex")).toBe(false);
  });
});

describe("reserved project agent handle codex", () => {
  it("rejects codex case-insensitively", () => {
    expect(isReservedProjectAgentHandle("codex")).toBe(true);
    expect(isReservedProjectAgentHandle("Codex")).toBe(true);
    expect(isReservedProjectAgentHandle("CODEX")).toBe(true);
    expect(getReservedProjectAgentHandleError("Codex")).toMatch(/reserved/i);
  });
});
