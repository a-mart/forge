import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type {
  CodexAppServerClientHandlers,
  CodexAppServerClientPort,
} from "../codex-app-server/types.js";
import { CodexAppServerService } from "../codex-app-server/codex-app-server-service.js";
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
  readonly requests: Array<{ method: string; params?: unknown }> = [];

  constructor(readonly handlers: CodexAppServerClientHandlers) {}

  async connect(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });

    if (method === "thread/start") {
      return { thread: { id: "thread-test" } } as T;
    }

    if (method === "thread/resume") {
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      return { thread: { id: threadId ?? "thread-test" } } as T;
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
  readonly requests: Array<{ method: string; params?: unknown }> = [];

  constructor(readonly handlers: CodexAppServerClientHandlers) {}

  async connect(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });

    if (method === "thread/start") {
      return { thread: { id: "thread-busy" } } as T;
    }

    if (method === "thread/resume") {
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      return { thread: { id: threadId ?? "thread-busy" } } as T;
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
  let fakeClient: FakeCodexAppServerClient | undefined;
  const manager = new TestSwarmManager(config, {
    codexAppServerServiceOptions: {
      turnCompletionGraceMs: 25,
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        return fakeClient;
      },
    },
  });
  return { manager, getFakeClient: () => fakeClient };
}

function createCodexEnabledManagerOnly(config: Awaited<ReturnType<typeof createTempConfig>>["config"]) {
  return createCodexEnabledTestManager(config).manager;
}

function createBusyCodexTestManager(config: Awaited<ReturnType<typeof createTempConfig>>["config"]) {
  let busyClient: BusyCodexAppServerClient | undefined;
  const manager = new TestSwarmManager(config, {
    codexAppServerServiceOptions: {
      turnCompletionGraceMs: 25,
      createClient: (handlers) => {
        busyClient = new BusyCodexAppServerClient(handlers);
        return busyClient;
      },
    },
  });
  return { manager, getBusyClient: () => busyClient };
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
    const manager = createCodexEnabledManagerOnly(config);
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
    const manager = createCodexEnabledManagerOnly(config);
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
    const { manager } = createBusyCodexTestManager(config);
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
    const manager = createCodexEnabledManagerOnly(config);
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
    const manager = createCodexEnabledManagerOnly(config);
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
    const manager = createCodexEnabledManagerOnly(config);
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
    const manager = createCodexEnabledManagerOnly(config);
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
    const manager = createCodexEnabledManagerOnly(config);
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
    const manager = createCodexEnabledManagerOnly(config);
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
    const manager = createCodexEnabledManagerOnly(config);
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
    const manager = createCodexEnabledManagerOnly(config);
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
    const manager = createCodexEnabledManagerOnly(config);
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

  it("clears global Codex busy state when an active sidecar is killed without injected cleanup hooks", async () => {
    const { config } = await createTempConfig();
    const { manager } = createBusyCodexTestManager(config);
    await bootWithDefaultManager(manager, config);
    const { sessionAgent: secondManager } = await manager.createSession("manager", { label: "Second" });

    await manager.handleUserMessage("@Codex blocking turn", {
      sourceContext: { channel: "web" },
    });

    expect(manager.getAgent("manager--codex")?.status).toBe("streaming");
    const codexService = (manager as unknown as { codexAppServerService: CodexAppServerService }).codexAppServerService;
    expect(codexService.getRuntimeStateForTest("manager--codex")?.activeTurn).toBeDefined();

    await manager.killAgent("manager", "manager--codex");

    expect(manager.getAgent("manager--codex")?.status).toBe("terminated");
    expect(codexService.getRuntimeStateForTest("manager--codex")?.activeTurn).toBeUndefined();

    await manager.handleUserMessage("@Codex from second manager", {
      targetAgentId: secondManager.agentId,
      sourceContext: { channel: "web" },
    });

    const secondSidecarId = `${secondManager.agentId}--codex`;
    expect(manager.getAgent(secondSidecarId)).toBeDefined();
    expect(codexService.getRuntimeStateForTest(secondSidecarId)?.activeTurn).toBeDefined();
  });

  it("resolves pending parent Codex request card when an active sidecar is killed mid-turn", async () => {
    const { config } = await createTempConfig();
    const { manager } = createBusyCodexTestManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex blocking turn", {
      sourceContext: { channel: "web" },
    });

    const cardsBeforeKill = manager
      .getConversationHistory("manager")
      .filter(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.externalThreadContext?.type === "codex_app_server",
      );
    expect(cardsBeforeKill.some((entry) => entry.externalThreadContext?.status === "sent")).toBe(true);
    expect(cardsBeforeKill.some((entry) => entry.externalThreadContext?.status === "stopped")).toBe(false);

    await manager.killAgent("manager", "manager--codex");

    const cardsAfterKill = manager
      .getConversationHistory("manager")
      .filter(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.externalThreadContext?.type === "codex_app_server",
      );
    expect(cardsAfterKill.some((entry) => entry.externalThreadContext?.status === "sent")).toBe(true);
    expect(cardsAfterKill.some((entry) => entry.externalThreadContext?.status === "stopped")).toBe(true);
    expect(
      manager
        .getConversationHistory("manager--codex")
        .some((entry) => entry.type === "conversation_message" && entry.text === "Codex turn stopped."),
    ).toBe(false);
  });

  it("uses updated manager cwd for Codex direct sends after updateManagerCwd", async () => {
    const { config } = await createTempConfig();
    const { manager, getFakeClient } = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    const nextCwd = join(config.defaultCwd, "updated-cwd-direct");
    await mkdir(nextCwd, { recursive: true });

    await manager.handleUserMessage("@Codex first question", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    await manager.updateManagerCwd("manager", nextCwd);
    const resolvedCwd = manager.getAgent("manager")!.cwd;
    getFakeClient()!.requests.length = 0;

    await manager.handleUserMessage("follow up after cwd change", {
      targetAgentId: "manager--codex",
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    const threadRequest = getFakeClient()!.requests.find(
      (request) => request.method === "thread/start" || request.method === "thread/resume",
    );
    const turnRequest = getFakeClient()!.requests.find((request) => request.method === "turn/start");
    expect(threadRequest?.params).toMatchObject({ cwd: resolvedCwd });
    expect(turnRequest?.params).toMatchObject({ cwd: resolvedCwd });
    expect(manager.getAgent("manager--codex")?.cwd).toBe(resolvedCwd);
  });

  it("uses updated manager cwd for fresh @Codex sends after updateManagerCwd", async () => {
    const { config } = await createTempConfig();
    const { manager, getFakeClient } = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    const nextCwd = join(config.defaultCwd, "updated-cwd-fresh");
    await mkdir(nextCwd, { recursive: true });

    await manager.handleUserMessage("@Codex seed sidecar", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    await manager.updateManagerCwd("manager", nextCwd);
    const resolvedCwd = manager.getAgent("manager")!.cwd;
    getFakeClient()!.requests.length = 0;

    await manager.handleUserMessage("@Codex after cwd change", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    const threadRequest = getFakeClient()!.requests.find(
      (request) => request.method === "thread/start" || request.method === "thread/resume",
    );
    const turnRequest = getFakeClient()!.requests.find((request) => request.method === "turn/start");
    expect(threadRequest?.params).toMatchObject({ cwd: resolvedCwd });
    expect(turnRequest?.params).toMatchObject({ cwd: resolvedCwd });
    expect(manager.getAgent("manager--codex")?.cwd).toBe(resolvedCwd);
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
