import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  turnCounter = 0;
  lastTurnId = "";
  autoCompleteTurn = true;
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
      this.turnCounter += 1;
      const turnId = `turn-${this.turnCounter}`;
      this.lastTurnId = turnId;
      if (this.autoCompleteTurn) {
        queueMicrotask(async () => {
          await this.completeTurn(turnId);
        });
      }
      return { turn: { id: turnId } } as T;
    }

    if (method === "plugin/list") {
      return {
        plugins: [
          {
            name: "fireflies",
            id: "fireflies@openai-curated",
            enabled: true,
            availability: "available",
            interface: { displayName: "Fireflies", shortDescription: "Meeting summaries" },
          },
          {
            name: "repo-prompt",
            id: "repo-prompt",
            enabled: true,
            availability: "available",
            interface: { displayName: "RepoPrompt", shortDescription: "Repository inspection" },
            serverNames: ["RepoPrompt"],
          },
        ],
      } as T;
    }

    if (method === "app/list") {
      return { apps: [{ id: "fireflies", name: "Fireflies" }] } as T;
    }

    if (method === "mcpServerStatus/list") {
      return {
        servers: [
          {
            name: "fireflies",
            tools: [
              {
                name: "list_recent",
                readOnly: true,
                annotations: { readOnlyHint: true },
                inputSchema: { type: "object", properties: { limit: { type: "integer" } }, required: ["limit"] },
              },
            ],
          },
          {
            name: "RepoPrompt",
            tools: {
              get_code_structure: {
                description: "Inspect repository structure",
                readOnly: true,
                annotations: { readOnlyHint: true },
              },
            },
          },
        ],
      } as T;
    }

    if (method === "mcpServer/tool/call") {
      return {
        content: [
          {
            type: "text",
            text: '{"accessToken":"inline-access-token","api-key":"inline-api-key"}',
          },
        ],
        structuredContent: {
          refreshToken: "refresh-token-secret",
          secretKey: "secret-key-secret",
          apiToken: "api-token-secret",
          credentials: { password: "credential-password-secret" },
        },
      } as T;
    }

    throw new Error(`Unexpected fake request: ${method}`);
  }

  notify(): void {}

  dispose(): void {}

  isDisposed(): boolean {
    return false;
  }

  async completeTurn(turnId = this.lastTurnId, text = "Codex says hi"): Promise<void> {
    await this.handlers.onNotification?.("item/completed", {
      turn: { id: turnId },
      item: { type: "agentMessage", text },
    });
    await this.handlers.onNotification?.("turn/completed", { turn: { id: turnId } });
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

function findInternalCodexPluginWorker(
  manager: { listAgentsForInternalUse(): AgentDescriptor[] },
): AgentDescriptor | undefined {
  return manager.listAgentsForInternalUse().find((entry) => entry.internalWorkerKind === "codex_plugin");
}

function hasInternalCodexPluginWorker(manager: { listAgentsForInternalUse(): AgentDescriptor[] }): boolean {
  return Boolean(findInternalCodexPluginWorker(manager));
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

  it("allows catalog browsing before any user message", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    const snapshot = await manager.browseCodexMcpCatalog("manager");
    expect(snapshot.tools.some((tool) => tool.selector === "fireflies/list_recent")).toBe(true);
  });

  it("keeps raw Codex MCP manager methods denied even after selector turns", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    await expect(manager.listCodexMcpTools("manager")).rejects.toThrow(/not available to manager runtimes/i);
    await expect(
      manager.callCodexMcpTool("manager", { selector: "fireflies/list_recent", args: { limit: 1 } }),
    ).rejects.toThrow(/not available to manager runtimes/i);

    await manager.handleUserMessage("@Codex -fireflies list meetings", {
      sourceContext: { channel: "web" },
    });

    await expect(manager.listCodexMcpTools("manager")).rejects.toThrow(/not available to manager runtimes/i);
    await expect(
      manager.callCodexMcpTool("manager", { selector: "fireflies/list_recent", args: { limit: 1 } }),
    ).rejects.toThrow(/not available to manager runtimes/i);
  });

  it("dispatches selector mentions to the manager with runtime-only delegation guidance", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex -fireflies list meetings", {
      sourceContext: { channel: "web" },
    });

    expect(manager.runtimeByAgentId.get("manager")?.sendCalls ?? []).toHaveLength(1);
    const managerSend = manager.runtimeByAgentId.get("manager")!.sendCalls.at(-1);
    const managerText = typeof managerSend?.message === "string" ? managerSend.message : managerSend?.message.text ?? "";
    expect(managerText).toContain("@Codex -fireflies list meetings");
    expect(managerText).toContain("[Codex Plugin selector context]");
    expect(managerText).toContain("Selected selector(s), bound server-side for this user turn only: fireflies");
    expect(managerText).toContain('spawn_agent({ specialist: "codex-plugin"');
    expect(managerText).not.toContain("list_codex_mcp_tools");
    expect(managerText).not.toContain("call_codex_mcp_tool");

    expect(manager.listAgents().some((entry) => entry.agentId === "manager--codex")).toBe(false);
    expect(manager.listWorkersForSession("manager")).toEqual([]);
    expect(manager.listManagerAgents().find((entry) => entry.agentId === "manager")).toMatchObject({
      workerCount: 0,
      activeWorkerCount: 0,
    });
    expect(findInternalCodexPluginWorker(manager)).toBeUndefined();

    expect(
      manager
        .getConversationHistory("manager")
        .some((entry) => entry.type === "conversation_message" && entry.role === "user" && entry.text === "@Codex -fireflies list meetings"),
    ).toBe(true);
  });

  it("does not authorize queued selector delegation until that selector turn starts", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    const managerRuntime = manager.runtimeByAgentId.get("manager");
    expect(managerRuntime).toBeDefined();
    managerRuntime!.busy = true;

    await manager.handleUserMessage("@Codex -fireflies list meetings", {
      sourceContext: { channel: "web" },
    });

    expect(managerRuntime!.sendCalls.at(-1)?.delivery).toBe("steer");
    await expect(
      manager.spawnAgent("manager", {
        agentId: "codex-plugin-fireflies",
        specialist: "codex-plugin",
        initialMessage: "List meetings",
      }),
    ).rejects.toThrow(/active user turn with Codex plugin selector/i);
    expect(findInternalCodexPluginWorker(manager)).toBeUndefined();

    const selectorMessage = managerRuntime!.sendCalls.at(-1)!.message;
    const selectorText = typeof selectorMessage === "string" ? selectorMessage : selectorMessage.text;
    await manager.handleRuntimeSessionEvent("manager", {
      type: "message_start",
      message: { role: "user", content: selectorText },
    });

    const result = await manager.spawnAgent("manager", {
      agentId: "codex-plugin-fireflies",
      specialist: "codex-plugin",
      initialMessage: "List meetings",
    });
    expect(findInternalCodexPluginWorker(manager)?.agentId).toBe(result.agentId);
  });

  it("does not activate queued selector context for an earlier worker report message_start", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);
    const worker = await manager.spawnAgent("manager", { agentId: "reporting-worker" });

    const managerRuntime = manager.runtimeByAgentId.get("manager");
    expect(managerRuntime).toBeDefined();
    managerRuntime!.busy = true;

    await manager.sendMessage(worker.agentId, "manager", "status: done\nsummary: worker report");
    const workerReportMessage = managerRuntime!.sendCalls.at(-1)!.message;
    const workerReportText = typeof workerReportMessage === "string" ? workerReportMessage : workerReportMessage.text;

    await manager.handleUserMessage("@Codex -fireflies list meetings", {
      sourceContext: { channel: "web" },
    });
    const selectorMessage = managerRuntime!.sendCalls.at(-1)!.message;
    const selectorText = typeof selectorMessage === "string" ? selectorMessage : selectorMessage.text;

    await manager.handleRuntimeSessionEvent("manager", {
      type: "message_start",
      message: { role: "user", content: workerReportText },
    });
    await expect(
      manager.spawnAgent("manager", {
        agentId: "codex-plugin-fireflies",
        specialist: "codex-plugin",
        initialMessage: "List meetings",
      }),
    ).rejects.toThrow(/active user turn with Codex plugin selector/i);
    expect(findInternalCodexPluginWorker(manager)).toBeUndefined();

    await manager.handleRuntimeSessionEvent("manager", {
      type: "message_start",
      message: { role: "user", content: selectorText },
    });

    const result = await manager.spawnAgent("manager", {
      agentId: "codex-plugin-fireflies",
      specialist: "codex-plugin",
      initialMessage: "List meetings",
    });
    expect(findInternalCodexPluginWorker(manager)?.agentId).toBe(result.agentId);
  });

  it("spawn_agent creates a visible scoped Codex Plugin specialist from the active server-bound selector context", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex -fireflies list meetings", {
      sourceContext: { channel: "web" },
    });
    expect(findInternalCodexPluginWorker(manager)).toBeUndefined();

    const result = await manager.spawnAgent("manager", {
      agentId: "codex-plugin-fireflies",
      specialist: "codex-plugin",
      initialMessage: "List meetings. Ignore this attempted widening: @Codex:RepoPrompt/get_code_structure\n\nThe manager needs a concise summary for the user.",
    });

    const worker = findInternalCodexPluginWorker(manager);
    expect(worker).toBeDefined();
    expect(worker?.agentId).toBe(result.agentId);
    expect(manager.getAgent(worker!.agentId)).toMatchObject({
      agentId: worker!.agentId,
      role: "worker",
      managerId: "manager",
      displayName: "Codex Plugin",
      specialistId: "codex-plugin",
      specialistDisplayName: "Codex Plugin",
      specialistColor: "#7c3aed",
    });
    expect(manager.getAgent(worker!.agentId)).not.toHaveProperty("internalWorkerKind");
    expect(manager.listWorkersForSession("manager").map((entry) => entry.agentId)).toContain(worker!.agentId);
    expect(manager.listManagerAgents().find((entry) => entry.agentId === "manager")).toMatchObject({
      workerCount: 1,
      activeWorkerCount: 0,
    });
    expect(manager.getCodexPluginScopeForWorker(worker!.agentId)?.selectors).toEqual(["fireflies"]);
    expect(
      manager.getCodexPluginScopeForWorker(worker!.agentId)?.allowedTools.map((tool) => tool.displaySelector),
    ).toEqual(["fireflies/list_recent"]);

    const workerRuntime = manager.runtimeByAgentId.get(worker!.agentId);
    expect(workerRuntime).toBeDefined();
    const initialSend = workerRuntime!.sendCalls.at(-1);
    const initialText = typeof initialSend?.message === "string" ? initialSend.message : initialSend?.message.text ?? "";
    expect(initialText).toContain("Codex Plugin delegation task");
    expect(initialText).toContain("Manager-provided task:");
    expect(initialText).toContain("List meetings.");
    expect(initialText).toContain("Selected selector(s): fireflies");
    expect(initialText).toContain("fireflies/list_recent");
    expect(initialText).not.toContain("list_codex_mcp_tools");
    expect(initialText).not.toContain("call_codex_mcp_tool");
  });

  it("allows owning-manager follow-ups but blocks users and sibling workers for scoped Codex Plugin specialists", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex -fireflies list meetings", {
      sourceContext: { channel: "web" },
    });
    await manager.spawnAgent("manager", {
      agentId: "codex-plugin-fireflies",
      specialist: "codex-plugin",
      initialMessage: "List meetings",
    });

    const worker = findInternalCodexPluginWorker(manager);
    expect(worker).toBeDefined();
    expect(manager.getCodexPluginScopeForWorker(worker!.agentId)).toBeDefined();
    const workerRuntime = manager.runtimeByAgentId.get(worker!.agentId);
    const sendCountBefore = workerRuntime?.sendCalls.length ?? 0;

    await expect(
      manager.handleUserMessage("try direct user target", {
        targetAgentId: worker!.agentId,
        sourceContext: { channel: "web" },
        attachments: [{ type: "binary", mimeType: "text/plain", data: "aGVsbG8=", fileName: "note.txt" }],
      }),
    ).rejects.toThrow(/scoped to a selected plugin turn/i);

    const followUpReceipt = await manager.sendMessage("manager", worker!.agentId, "follow up within active scope");
    expect(followUpReceipt.targetAgentId).toBe(worker!.agentId);
    expect(workerRuntime?.sendCalls.length ?? 0).toBe(sendCountBefore + 1);

    await expect(
      manager.sendMessage("manager", worker!.agentId, "user-origin manager target", "auto", {
        origin: "user",
        attachments: [{ type: "binary", mimeType: "text/plain", data: "aGVsbG8=", fileName: "note.txt" }],
      }),
    ).rejects.toThrow(/scoped to a selected plugin turn/i);

    const sibling = await manager.spawnAgent("manager", { agentId: "sibling-worker" });
    await expect(
      manager.sendMessage(worker!.agentId, sibling.agentId, "do not fan out"),
    ).rejects.toThrow(/only report to their owning manager/i);
    await expect(
      manager.sendMessage(sibling.agentId, worker!.agentId, "sibling follow-up"),
    ).rejects.toThrow(/only accept follow-ups from their owning manager/i);

    const reportReceipt = await manager.sendMessage(worker!.agentId, "manager", "status: done\nsummary: scoped report");
    expect(reportReceipt.targetAgentId).toBe("manager");

    expect(
      manager
        .getConversationHistory("manager")
        .some((entry) => entry.type === "conversation_message" && entry.text.includes("try direct user target")),
    ).toBe(false);
  });

  it("binds inline and exact selectors for manager-spawned Codex Plugin specialists", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("run @Codex:RepoPrompt/get_code_structure for today", {
      sourceContext: { channel: "web" },
    });

    expect(manager.runtimeByAgentId.get("manager")?.sendCalls ?? []).toHaveLength(1);
    expect(findInternalCodexPluginWorker(manager)).toBeUndefined();

    await manager.spawnAgent("manager", {
      agentId: "codex-plugin-repoprompt",
      specialist: "codex-plugin",
      initialMessage: "Inspect code structure for today",
    });
    const worker = findInternalCodexPluginWorker(manager);
    expect(worker).toBeDefined();

    const initialSend = manager.runtimeByAgentId.get(worker!.agentId)!.sendCalls.at(-1);
    const initialText = typeof initialSend?.message === "string" ? initialSend.message : initialSend?.message.text ?? "";
    expect(initialText).toContain("RepoPrompt/get_code_structure");
    expect(initialText).toContain("run for today");
  });

  it("selector turns with attachments fail before persistence and worker spawn", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    await expect(
      manager.handleUserMessage("@Codex -fireflies summarize attachment", {
        sourceContext: { channel: "web" },
        attachments: [{ type: "binary", mimeType: "text/plain", data: "aGVsbG8=", fileName: "note.txt" }],
      }),
    ).rejects.toThrow(/does not support attachments/i);

    expect(hasInternalCodexPluginWorker(manager)).toBe(false);
    expect(manager.runtimeByAgentId.get("manager")?.sendCalls ?? []).toHaveLength(0);
    expect(manager.getConversationHistory("manager").some((entry) => entry.type === "conversation_message" && entry.text.includes("summarize attachment"))).toBe(false);
  });

  it("scheduled selector turns fail closed before manager dispatch or worker spawn", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    await expect(
      manager.handleUserMessage(
        '[Scheduled Task: Nightly]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nUse @Codex:fireflies',
        { sourceContext: { channel: "web" } },
      ),
    ).rejects.toThrow(/scheduled task/i);

    expect(hasInternalCodexPluginWorker(manager)).toBe(false);
    expect(manager.runtimeByAgentId.get("manager")?.sendCalls ?? []).toHaveLength(0);
  });

  it("clears active selector context when the manager turn ends", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex -fireflies list meetings", {
      sourceContext: { channel: "web" },
    });
    await manager.handleRuntimeSessionEvent("manager", { type: "turn_end", toolResults: [] });

    await expect(
      manager.spawnAgent("manager", {
        agentId: "codex-plugin-fireflies",
        specialist: "codex-plugin",
        initialMessage: "List meetings",
      }),
    ).rejects.toThrow(/active user turn with Codex plugin selector/i);
    expect(findInternalCodexPluginWorker(manager)).toBeUndefined();
  });

  it("scoped Codex Plugin specialist keeps tools across turn end and clears scope on stop", async () => {
    const { config } = await createTempConfig();
    const { manager, getFakeClient } = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex -fireflies list meetings", {
      sourceContext: { channel: "web" },
    });
    await manager.spawnAgent("manager", {
      agentId: "codex-plugin-fireflies",
      specialist: "codex-plugin",
      initialMessage: "List meetings",
    });

    const worker = findInternalCodexPluginWorker(manager);
    expect(worker).toBeDefined();

    const result = await manager.callCodexPluginScopedTool(worker!.agentId, "codex_fireflies_list_recent", { limit: 1 });
    expect(result).toMatchObject({ ok: true, selector: "fireflies/list_recent" });
    expect(result.redactedPreview).toContain("[redacted]");
    for (const secret of [
      "inline-access-token",
      "inline-api-key",
      "refresh-token-secret",
      "secret-key-secret",
      "api-token-secret",
      "credential-password-secret",
    ]) {
      expect(result.redactedPreview).not.toContain(secret);
    }
    const toolCallRequest = getFakeClient()!.requests.find((request) => request.method === "mcpServer/tool/call");
    expect(toolCallRequest?.params).toMatchObject({
      server: "fireflies",
      tool: "list_recent",
      arguments: { limit: 1 },
    });

    await manager.handleRuntimeSessionEvent(worker!.agentId, { type: "turn_end", toolResults: [] });
    await expect(
      manager.callCodexPluginScopedTool(worker!.agentId, "codex_fireflies_list_recent", { limit: 1 }),
    ).resolves.toMatchObject({ ok: true, selector: "fireflies/list_recent" });

    await manager.stopWorker(worker!.agentId);
    await expect(
      manager.callCodexPluginScopedTool(worker!.agentId, "codex_fireflies_list_recent", { limit: 1 }),
    ).rejects.toThrow(/No active Codex plugin scope/i);
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

  it("persists idle sidecar state after a busy follow-up completes so the next @Codex turn uses the updated cwd", async () => {
    const { config } = await createTempConfig();
    const { manager, getFakeClient } = createCodexEnabledTestManager(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex seed sidecar", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    const fakeClient = getFakeClient()!;
    fakeClient.requests.length = 0;
    fakeClient.autoCompleteTurn = false;

    await manager.handleUserMessage("follow up without mention", {
      targetAgentId: "manager--codex",
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("streaming");
    });

    const nextCwd = join(config.defaultCwd, "updated-cwd-after-busy-followup");
    await mkdir(nextCwd, { recursive: true });
    await manager.updateManagerCwd("manager", nextCwd);
    const resolvedCwd = manager.getAgent("manager")!.cwd;

    await expect(
      manager.handleUserMessage("@Codex after cwd change", {
        sourceContext: { channel: "web" },
      }),
    ).rejects.toThrow(/Codex is busy/);

    expect(manager.getAgent("manager--codex")?.cwd).toBe(resolvedCwd);

    await fakeClient.completeTurn(undefined, "follow up complete");

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    await vi.waitFor(async () => {
      const store = JSON.parse(await readFile(config.paths.agentsStoreFile, "utf8")) as {
        agents: Array<{ agentId: string; status?: string; cwd?: string }>;
      };
      const persistedSidecar = store.agents.find((agent) => agent.agentId === "manager--codex");
      expect(persistedSidecar).toMatchObject({ status: "idle", cwd: resolvedCwd });
    });

    fakeClient.autoCompleteTurn = true;
    fakeClient.requests.length = 0;

    await manager.handleUserMessage("@Codex after completion", {
      sourceContext: { channel: "web" },
    });

    await vi.waitFor(() => {
      expect(manager.getAgent("manager--codex")?.status).toBe("idle");
    });

    const threadRequest = fakeClient.requests.find(
      (request) => request.method === "thread/start" || request.method === "thread/resume",
    );
    const turnRequest = fakeClient.requests.find((request) => request.method === "turn/start");
    expect(threadRequest?.params).toMatchObject({ cwd: resolvedCwd });
    expect(turnRequest?.params).toMatchObject({ cwd: resolvedCwd });
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
