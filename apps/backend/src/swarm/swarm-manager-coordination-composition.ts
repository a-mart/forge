import { isSessionAgentDescriptor } from "./agent-directory.js";
import { SessionGoalCoordinator } from "./goals/session-goal-coordinator.js";
import type { SessionPlanCoordinator } from "./planning/session-plan-coordinator.js";
import type { RestartRecoveryCoordinator } from "./restart-recovery-coordinator.js";
import { SwarmCompactionCoordinator } from "./swarm-compaction-coordinator.js";
import type {
  SwarmManagerRuntimeCompositionOptions,
} from "./swarm-manager-runtime-composition.js";
import type { SwarmManagerRuntimeBoundServices } from "./swarm-manager-runtime-boundary.js";
import type { SwarmRuntimeLifecycleCoordinator } from "./swarm-runtime-lifecycle-coordinator.js";
import type { TurnContextCoordinator } from "./turn-context-coordinator.js";
import type { CaptureCascadeCoordinator } from "./capture-cascade-coordinator.js";

export interface SwarmManagerCoordinationComposition {
  goals: SessionGoalCoordinator;
  compaction: SwarmCompactionCoordinator;
}

export function createSwarmManagerCoordinationComposition(input: {
  options: SwarmManagerRuntimeCompositionOptions;
  plans: SessionPlanCoordinator;
  captureCascade: CaptureCascadeCoordinator;
  restartRecovery: RestartRecoveryCoordinator;
  getServices(): SwarmManagerRuntimeBoundServices;
  getTurnContext(): TurnContextCoordinator;
  getRuntimeLifecycle(): SwarmRuntimeLifecycleCoordinator;
}): SwarmManagerCoordinationComposition {
  const { options, plans } = input;
  const { state, foundation, messaging, events, runtimeResources } = options;
  const goals = new SessionGoalCoordinator({
    dataDir: state.config.paths.dataDir,
    descriptors: state.descriptors,
    now: state.now,
    isSessionAgent: isSessionAgentDescriptor,
    assertNotArchived: (descriptor) =>
      input.getServices().directory.assertDescriptorNotEffectivelyArchived(descriptor),
    isArchived: (descriptor) =>
      input.getServices().directory.isDescriptorEffectivelyArchived(descriptor),
    getWorkers: (managerId) => input.getServices().directory.getWorkersForManager(managerId),
    hasPendingChoices: (sessionAgentId) =>
      input.getServices().choices.hasPendingChoicesForSession(sessionAgentId),
    hasIncompletePlanSteps: (owner) => plans.hasIncompleteSteps(owner),
    isRuntimeRecoveryActive: (agentId) =>
      input.getRuntimeLifecycle().isRuntimeRecoveryActive(agentId),
    hasPendingRuntimeRecycle: (agentId) =>
      state.runtimeRecoveryState.hasPendingManagerRuntimeRecycle(agentId),
    isRestartRecoveryDecisionPending: () => input.restartRecovery.isDecisionPending(),
    getActiveExternalTurn: (agentId) =>
      input.getTurnContext().getActiveExternalProjectAgentTurn(agentId),
    sendMessage: (fromAgentId, targetAgentId, message, sendOptions) =>
      messaging.sendMessage(fromAgentId, targetAgentId, message, "auto", sendOptions),
    emitSnapshot: events.emitSessionGoalSnapshot,
    recordToolSideEffect: (agentId, event) =>
      foundation.observability.recordToolSideEffect(agentId, event),
    logDebug: events.logDebug,
  });
  const compaction = new SwarmCompactionCoordinator({
    descriptors: state.descriptors,
    getOrCreateRuntime: runtimeResources.getOrCreateRuntimeForDescriptor,
    syncPinnedContent: (descriptor) => foundation.sessionPins.syncPinnedContent(descriptor),
    sessionPlans: plans,
    sessionGoals: goals,
    captureCascade: input.captureCascade,
    incrementCompactionCount: (profileId, agentId, failureLogMessage) =>
      input.getServices().knowledge.incrementSessionCompactionCount(
        profileId,
        agentId,
        failureLogMessage,
      ),
    emitConversationMessage: events.emitConversationMessage,
    now: state.now,
    logDebug: events.logDebug,
  });
  return { goals, compaction };
}
