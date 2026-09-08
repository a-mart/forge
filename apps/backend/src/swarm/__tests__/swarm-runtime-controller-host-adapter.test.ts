import { describe, expect, it, vi } from "vitest";
import type {
  HistoryItemsResponse,
  HistoryReadResponse,
  HistoryWindowsResponse,
} from "@forge/protocol";
import { buildHistoryRecallTools } from "../history-recall-tool.js";
import {
  createSwarmRuntimeControllerHost,
  type SwarmRuntimeControllerHostAdapterOptions,
} from "../swarm-runtime-controller-host-adapter.js";
import type { SwarmRuntimeControllerHost } from "../swarm-runtime-controller.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { AgentDescriptor } from "../types.js";

type FixtureOwnedOption =
  | "toolHost"
  | "config"
  | "forgeExtensionHost"
  | "now"
  | "descriptors"
  | "runtimeRecoveryState"
  | "getWorkerHealthState"
  | "getLateBoundServices";

function createToolHost(onListAgents: (receiver: unknown) => void): SwarmToolHost {
  const toolHost: SwarmToolHost = {
    listAgents() {
      onListAgents(this);
      return [];
    },
    getContextMode: vi.fn(() => "summary"),
    getWorkerActivity: vi.fn(),
    spawnAgent: vi.fn(),
    killAgent: vi.fn(),
    sendMessage: vi.fn(),
    createSessionFromAgent: vi.fn(),
    publishToUser: vi.fn(async () => ({ targetContext: { channel: "web" as const } })),
    requestUserChoice: vi.fn(),
    invokeBrowserAutomation: vi.fn(),
    updatePlan: vi.fn(),
    updateWorkGraph: vi.fn(),
    acceptWorkGraphNode: vi.fn(),
    createGoal: vi.fn(),
    getGoal: vi.fn(),
    updateGoal: vi.fn(),
  };
  return toolHost;
}

function createAdapter(options?: {
  toolHost?: SwarmToolHost;
  getWorkerHealthState?: SwarmRuntimeControllerHostAdapterOptions["getWorkerHealthState"];
  getLateBoundServices?: SwarmRuntimeControllerHostAdapterOptions["getLateBoundServices"];
}): SwarmRuntimeControllerHost {
  // These callbacks are intentionally inert: this focused fixture exercises
  // adapter binding and lazy access, not the controller's callback contract.
  const callbacks = {} as Omit<SwarmRuntimeControllerHostAdapterOptions, FixtureOwnedOption>;
  return createSwarmRuntimeControllerHost({
    ...callbacks,
    toolHost: options?.toolHost ?? createToolHost(() => undefined),
    config: {} as SwarmRuntimeControllerHost["config"],
    forgeExtensionHost: {} as SwarmRuntimeControllerHost["forgeExtensionHost"],
    now: () => "2026-07-13T00:00:00.000Z",
    descriptors: new Map(),
    runtimeRecoveryState: {} as SwarmRuntimeControllerHost["runtimeRecoveryState"],
    getWorkerHealthState:
      options?.getWorkerHealthState ??
      (() => ({
        workerWatchdogState: new Map(),
        workerStallState: new Map(),
        workerActivityState: new Map(),
        watchdogTimerTokens: new Map(),
      })),
    getLateBoundServices:
      options?.getLateBoundServices ??
      (() =>
        ({
          conversationProjector: {},
          promptService: {},
          secretsEnvService: {},
          cortexService: {},
        }) as ReturnType<SwarmRuntimeControllerHostAdapterOptions["getLateBoundServices"]>),
  });
}

describe("createSwarmRuntimeControllerHost", () => {
  it("binds tool methods to the original tool host", () => {
    let receiver: unknown;
    const toolHost = createToolHost((value) => {
      receiver = value;
    });
    const host = createAdapter({ toolHost });

    host.listAgents();

    expect(receiver).toBe(toolHost);
  });

  it("binds context-mode and history-recall methods to the original tool host", () => {
    let contextReceiver: unknown;
    let historyReceiver: unknown;
    const toolHost = createToolHost(() => undefined);
    toolHost.getContextMode = function () {
      contextReceiver = this;
      return "summary";
    };
    toolHost.searchHistory = async function () {
      historyReceiver = this;
      return { scope: "session", results: [], complete: true, warnings: [] };
    };
    const host = createAdapter({ toolHost });

    expect(host.getContextMode("manager")).toBe("summary");
    void host.searchHistory?.("manager", { query: "old" });
    expect(contextReceiver).toBe(toolHost);
    expect(historyReceiver).toBe(toolHost);
  });

  it("exposes history windows/items through the adapter and binds them to the original tool host", async () => {
    let windowsReceiver: unknown;
    let itemsReceiver: unknown;
    let windowsArgs: unknown[] | undefined;
    let itemsArgs: unknown[] | undefined;
    const windowsResponse = {
      results: [],
      complete: true,
      warnings: ["windows-ok"],
    } satisfies HistoryWindowsResponse;
    const itemsResponse = {
      results: [],
      complete: false,
      warnings: ["items-ok"],
    } satisfies HistoryItemsResponse;
    const readResponse = {
      entry: {
        ref: {
          sessionAgentId: "session",
          actorAgentId: "worker",
          entryId: "entry",
          sourceVersion: "generation",
        },
        kind: "message",
        timestamp: "2026-07-13T00:00:00.000Z",
        windowId: "window:initial",
        text: "evidence",
        offset: 0,
        totalChars: 8,
      },
      before: [],
      after: [],
      warnings: [],
    } satisfies HistoryReadResponse;
    const toolHost = createToolHost(() => undefined);
    toolHost.searchHistory = async function () {
      return { scope: "session", results: [], complete: true, warnings: [] };
    };
    toolHost.readHistory = async function () {
      return readResponse;
    };
    toolHost.listHistoryWindows = async function (...args) {
      windowsReceiver = this;
      windowsArgs = args;
      return windowsResponse;
    };
    toolHost.listHistoryItems = async function (...args) {
      itemsReceiver = this;
      itemsArgs = args;
      return itemsResponse;
    };
    const host = createAdapter({ toolHost });
    const [tool] = buildHistoryRecallTools(host, {
      agentId: "worker",
      managerId: "session",
      role: "worker",
    } as AgentDescriptor);

    expect(tool).toBeDefined();
    const ops = (
      (tool.parameters as { anyOf?: Array<{ properties?: { op?: { const?: string } } }> }).anyOf ?? []
    ).map((branch) => branch.properties?.op?.const);
    expect(ops).toEqual(expect.arrayContaining(["windows", "items"]));

    const windowsResult = await tool.execute("windows", {
      op: "windows",
      actorAgentId: "worker",
      limit: 5,
    });
    const itemsResult = await tool.execute("items", {
      op: "items",
      windowId: "window:initial",
      role: "user",
    });
    expect(windowsReceiver).toBe(toolHost);
    expect(itemsReceiver).toBe(toolHost);
    expect(windowsArgs).toEqual(["worker", { actorAgentId: "worker", limit: 5 }]);
    expect(itemsArgs).toEqual(["worker", { windowId: "window:initial", role: "user" }]);
    expect(windowsResult).toMatchObject({
      details: windowsResponse,
      content: [{ type: "text", text: JSON.stringify(windowsResponse) }],
    });
    expect(itemsResult).toMatchObject({
      details: itemsResponse,
      content: [{ type: "text", text: JSON.stringify(itemsResponse) }],
    });
  });

  it("binds the Secure Session runtime capability resolver to the tool host", () => {
    let receiver: unknown;
    const toolHost = createToolHost(() => undefined);
    toolHost.getSecureRuntimeBinding = function () {
      receiver = this;
      return undefined;
    };
    const host = createAdapter({ toolHost });

    host.getSecureRuntimeBinding?.({} as never);

    expect(receiver).toBe(toolHost);
  });

  it("resolves worker-health state and late-bound services only when read", () => {
    const workerHealthState = {
      workerWatchdogState: new Map(),
      workerStallState: new Map(),
      workerActivityState: new Map(),
      watchdogTimerTokens: new Map(),
    };
    const lateBoundServices = {
      conversationProjector: {},
      promptService: {},
      secretsEnvService: {},
      cortexService: {},
    } as ReturnType<SwarmRuntimeControllerHostAdapterOptions["getLateBoundServices"]>;
    const getWorkerHealthState = vi.fn(() => workerHealthState);
    const getLateBoundServices = vi.fn(() => lateBoundServices);

    const host = createAdapter({ getWorkerHealthState, getLateBoundServices });

    expect(getWorkerHealthState).not.toHaveBeenCalled();
    expect(getLateBoundServices).not.toHaveBeenCalled();

    expect(host.workerActivityState).toBe(workerHealthState.workerActivityState);
    expect(host.promptService).toBe(lateBoundServices.promptService);
    expect(getWorkerHealthState).toHaveBeenCalledOnce();
    expect(getLateBoundServices).toHaveBeenCalledOnce();
  });
});
