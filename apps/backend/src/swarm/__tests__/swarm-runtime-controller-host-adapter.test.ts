import { describe, expect, it, vi } from "vitest";
import {
  createSwarmRuntimeControllerHost,
  type SwarmRuntimeControllerHostAdapterOptions,
} from "../swarm-runtime-controller-host-adapter.js";
import type { SwarmRuntimeControllerHost } from "../swarm-runtime-controller.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";

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
