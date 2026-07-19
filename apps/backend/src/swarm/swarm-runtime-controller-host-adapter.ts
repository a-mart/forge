import type { SwarmRuntimeControllerHost } from "./swarm-runtime-controller.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";

type WorkerHealthHostState = Pick<
  SwarmRuntimeControllerHost,
  "workerStallState" | "workerActivityState"
>;

type LateBoundHostServices = Pick<
  SwarmRuntimeControllerHost,
  "conversationProjector" | "promptService" | "secretsEnvService" | "cortexService"
>;

type AdapterOwnedHostKeys =
  | keyof SwarmToolHost
  | "config"
  | "forgeExtensionHost"
  | "now"
  | "descriptors"
  | "runtimeRecoveryState"
  | keyof WorkerHealthHostState
  | keyof LateBoundHostServices;

type RuntimeControllerHostCallbacks = Omit<SwarmRuntimeControllerHost, AdapterOwnedHostKeys>;

export type SwarmRuntimeControllerHostAdapterOptions = RuntimeControllerHostCallbacks & {
  toolHost: SwarmToolHost;
  config: SwarmRuntimeControllerHost["config"];
  forgeExtensionHost: SwarmRuntimeControllerHost["forgeExtensionHost"];
  now: SwarmRuntimeControllerHost["now"];
  descriptors: SwarmRuntimeControllerHost["descriptors"];
  runtimeRecoveryState: SwarmRuntimeControllerHost["runtimeRecoveryState"];
  getWorkerHealthState: () => WorkerHealthHostState;
  getLateBoundServices: () => LateBoundHostServices;
};

/**
 * Creates the explicit controller-facing view of SwarmManager.
 *
 * The controller is constructed before worker-health and several host services,
 * so those two dependency groups deliberately remain lazy. All tool methods are
 * bound to the facade to preserve their receiver without exposing the facade as
 * the controller host.
 */
export function createSwarmRuntimeControllerHost(
  options: SwarmRuntimeControllerHostAdapterOptions
): SwarmRuntimeControllerHost {
  const {
    toolHost,
    config,
    forgeExtensionHost,
    now,
    descriptors,
    runtimeRecoveryState,
    getWorkerHealthState,
    getLateBoundServices,
    ...callbacks
  } = options;

  return {
    ...callbacks,
    config,
    forgeExtensionHost,
    now,
    descriptors,
    runtimeRecoveryState,

    get workerStallState() {
      return getWorkerHealthState().workerStallState;
    },
    get workerActivityState() {
      return getWorkerHealthState().workerActivityState;
    },
    get conversationProjector() {
      return getLateBoundServices().conversationProjector;
    },
    get promptService() {
      return getLateBoundServices().promptService;
    },
    get secretsEnvService() {
      return getLateBoundServices().secretsEnvService;
    },
    get cortexService() {
      return getLateBoundServices().cortexService;
    },

    listAgents: toolHost.listAgents.bind(toolHost),
    getWorkerActivity: toolHost.getWorkerActivity.bind(toolHost),
    spawnAgent: toolHost.spawnAgent.bind(toolHost),
    killAgent: toolHost.killAgent.bind(toolHost),
    sendMessage: toolHost.sendMessage.bind(toolHost),
    createSessionFromAgent: toolHost.createSessionFromAgent.bind(toolHost),
    createAndPromoteProjectAgent: toolHost.createAndPromoteProjectAgent?.bind(toolHost),
    publishToUser: toolHost.publishToUser.bind(toolHost),
    requestUserChoice: toolHost.requestUserChoice.bind(toolHost),
    updatePlan: toolHost.updatePlan.bind(toolHost),
    updateWorkGraph: toolHost.updateWorkGraph.bind(toolHost),
    createGoal: toolHost.createGoal.bind(toolHost),
    getGoal: toolHost.getGoal.bind(toolHost),
    updateGoal: toolHost.updateGoal.bind(toolHost),
    searchKnowledge: toolHost.searchKnowledge?.bind(toolHost),
    readKnowledgeEntry: toolHost.readKnowledgeEntry?.bind(toolHost),
    saveLearning: toolHost.saveLearning?.bind(toolHost),
    recordToolSideEffect: toolHost.recordToolSideEffect?.bind(toolHost),
    listCodexMcpTools: toolHost.listCodexMcpTools?.bind(toolHost),
    callCodexMcpTool: toolHost.callCodexMcpTool?.bind(toolHost),
    getCodexPluginScopeForWorker: toolHost.getCodexPluginScopeForWorker?.bind(toolHost),
    callCodexPluginScopedTool: toolHost.callCodexPluginScopedTool?.bind(toolHost),
    exportCodexPluginScopedToolResult: toolHost.exportCodexPluginScopedToolResult?.bind(toolHost),
    retryCodexPluginWorker: toolHost.retryCodexPluginWorker?.bind(toolHost),
  } satisfies SwarmRuntimeControllerHost;
}
