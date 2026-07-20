import type { ChoiceRequestEvent, SessionPlanSnapshotEvent } from "@forge/protocol";
import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import type { AgentDirectory } from "./agent-directory.js";
import type { AssistantOutputRouter } from "./assistant-output-router.js";
import type { CodexPluginDelegationCoordinator } from "./codex-app-server/codex-plugin-delegation-coordinator.js";
import { CODEX_PLUGIN_SPECIALIST_ID } from "./codex-app-server/codex-plugin-scope-service.js";
import type { SessionPlanCoordinator } from "./planning/session-plan-coordinator.js";
import type { PlanStepAssignment } from "./planning/plan-usage-tracker.js";
import type { UpdatePlanInput, UpdatePlanResult } from "./planning/update-plan-tool.js";
import type { UpdateWorkGraphResult } from "./planning/update-work-graph-tool.js";
import type { UpdateWorkGraphInput, WorkGraphDispatchClaim } from "./planning/work-graph-state.js";
import { normalizeArchetypeId } from "./prompt-registry.js";
import { resolveManagerDelegation } from "./specialists/delegation-policy.js";
import { normalizeSpecialistHandle } from "./specialists/specialist-registry.js";
import type { SwarmAgentLifecycleService } from "./swarm-agent-lifecycle-service.js";
import type { SwarmChoiceService } from "./swarm-choice-service.js";
import {
  normalizeCortexUserVisiblePaths,
  normalizeMessageSourceContext,
  normalizeMessageTargetContext,
  previewForLog,
} from "./swarm-manager-utils.js";
import type { SwarmToolSideEffectEvent } from "./swarm-tool-host.js";
import type {
  AgentDescriptor,
  ChoiceAnswer,
  ChoiceQuestion,
  ChoiceRequestStatus,
  ConversationMessageEvent,
  ManagerProfile,
  MessageSourceContext,
  MessageTargetContext,
  SendMessageReceipt,
  SpawnAgentInput,
} from "./types.js";

const CORTEX_ARCHETYPE_ID = "cortex";

export type ResetManagerSessionReason = "user_new_command" | "api_reset";
export type PublishToUserSource = "speak_to_user" | "system";
export interface PublishToUserResult {
  targetContext: MessageSourceContext;
  published: boolean;
  reason?: "superseded_by_user_input";
}

type SessionOwner = AgentDescriptor & { role: "manager"; profileId: string };

export interface SessionInteractionTurnPort {
  getActiveTurnId(agentId: string): string | undefined;
  hasPendingSupersedingUserInput(agentId: string, activeTurnId?: string): boolean;
  getActiveExternalProjectAgentTurn(agentId: string):
    | {
        fromAgentId: string;
        fromDisplayName: string;
      }
    | undefined;
}

export interface SessionInteractionRuntimeOutputPort {
  flushPreservedManagerAssistantOutputForTool(agentId: string, toolName: string): void;
  markExplicitManagerAssistantOutput(agentId: string): void;
}

export interface SessionInteractionEventPort {
  emitConversationMessage(event: ConversationMessageEvent): void;
  emitConversationReset(agentId: string, reason: ResetManagerSessionReason): void;
  markSessionActivity(agentId: string, timestamp: string): void;
}

export interface SessionInteractionCoordinatorOptions {
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  directory: Pick<
    AgentDirectory,
    | "assertDescriptorNotEffectivelyArchived"
    | "assertManager"
    | "getRequiredBuilderManagerDescriptor"
    | "getRequiredSessionDescriptor"
    | "isSessionAgent"
    | "resolvePreferredManagerId"
  >;
  plans: Pick<
    SessionPlanCoordinator,
    | "claimReadyWorkGraphNodes"
    | "getSnapshot"
    | "preload"
    | "recordWorkerAssignment"
    | "recordWorkGraphDispatchFailure"
    | "recordWorkGraphWorkerStarted"
    | "resolveAssignment"
    | "update"
    | "updateWorkGraph"
  >;
  choices: Pick<
    SwarmChoiceService,
    | "cancelAllPendingChoicesForAgent"
    | "cancelChoiceRequest"
    | "getPendingChoice"
    | "getPendingChoiceIdsForSession"
    | "getPendingChoiceOwner"
    | "getPendingChoiceRequestsForSession"
    | "hasPendingChoicesForSession"
    | "requestUserChoiceWithId"
    | "resolveChoiceRequest"
  >;
  assistantOutput: Pick<
    AssistantOutputRouter,
    | "activateChoiceContinuation"
    | "clearChoiceContinuationsForAgent"
    | "forgetChoiceContinuation"
    | "rememberChoiceContinuation"
  >;
  runtimeOutput: SessionInteractionRuntimeOutputPort;
  lifecycle: Pick<SwarmAgentLifecycleService, "killAgent" | "spawnAgent">;
  codexPlugin: Pick<CodexPluginDelegationCoordinator, "spawnSpecialistWorker">;
  turns: SessionInteractionTurnPort;
  sessions: {
    createSession(
      profileId: string,
      options?: { label?: string },
    ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }>;
  };
  events: SessionInteractionEventPort;
  recordToolSideEffect(callerAgentId: string, event: SwarmToolSideEffectEvent): void;
  now(): string;
  logDebug(message: string, details?: unknown): void;
}

/**
 * Application boundary for interactive manager commands.
 *
 * State remains in the focused plan, choice, lifecycle, output-routing, and
 * session services. This coordinator owns the ordering and cross-service policy
 * for commands exposed to agents and users: update_plan, present_choices,
 * spawn/kill, speak_to_user, and conversation reset.
 */
export class SessionInteractionCoordinator {
  constructor(private readonly options: SessionInteractionCoordinatorOptions) {}

  async getSessionPlanSnapshot(
    sessionAgentId: string,
    requestId?: string,
  ): Promise<SessionPlanSnapshotEvent> {
    const descriptor = this.options.directory.getRequiredSessionDescriptor(sessionAgentId);
    return this.options.plans.getSnapshot(descriptor, requestId);
  }

  async preloadSessionPlanStates(): Promise<void> {
    const owners = Array.from(this.options.descriptors.values()).filter(
      (descriptor): descriptor is SessionOwner =>
        descriptor.role === "manager" &&
        descriptor.sessionSurface !== "collab" &&
        normalizeArchetypeId(descriptor.archetypeId ?? "") !== CORTEX_ARCHETYPE_ID &&
        this.options.directory.isSessionAgent(descriptor),
    );
    await this.options.plans.preload(owners);
  }

  async updatePlan(
    callerAgentId: string,
    toolCallId: string,
    input: UpdatePlanInput,
  ): Promise<UpdatePlanResult> {
    this.assertExternalProjectAgentTurnCapabilityAllowed(callerAgentId, "update_plan");
    const descriptor = this.getPlanOwner(callerAgentId, "update_plan");
    const { input: normalized, result } = await this.options.plans.update(descriptor, input);
    this.options.recordToolSideEffect(callerAgentId, {
      toolName: "update_plan",
      toolCallId,
      phase: "side_effect",
      input: normalized,
      output: result,
      metadata: { revision: result.revision, stepCount: result.plan.length },
    });
    return result;
  }

  async updateWorkGraph(
    callerAgentId: string,
    toolCallId: string,
    input: UpdateWorkGraphInput,
  ): Promise<UpdateWorkGraphResult> {
    this.assertExternalProjectAgentTurnCapabilityAllowed(callerAgentId, "update_work_graph");
    const descriptor = this.getPlanOwner(callerAgentId, "update_work_graph");
    const updated = await this.options.plans.updateWorkGraph(descriptor, input);

    for (const workerId of updated.cancelledWorkerIds) {
      const worker = this.options.descriptors.get(workerId);
      if (!worker || isNonRunningAgentStatus(worker.status)) continue;
      await this.options.lifecycle.killAgent(callerAgentId, workerId).catch((error) => {
        this.options.logDebug("work_graph:cancel_worker:error", {
          managerId: callerAgentId,
          workerId,
          message: errorMessage(error),
        });
      });
    }

    const claims = await this.options.plans.claimReadyWorkGraphNodes(descriptor);
    const dispatched: UpdateWorkGraphResult["dispatched"] = [];
    const dispatchFailures: UpdateWorkGraphResult["dispatchFailures"] = [];
    for (const claim of claims) {
      try {
        const delegation = resolveGraphDispatch(claim, descriptor.cwd);
        const spawned = await this.spawnAgent(callerAgentId, delegation);
        await this.options.plans.recordWorkGraphWorkerStarted(
          descriptor,
          claim.nodeId,
          claim.attemptId,
          spawned.agentId,
        );
        dispatched.push({
          nodeId: claim.nodeId,
          workerId: spawned.agentId,
          executionPolicy: claim.executionPolicy,
        });
      } catch (error) {
        await this.options.plans.recordWorkGraphDispatchFailure(
          descriptor,
          claim.nodeId,
          claim.attemptId,
          error,
        );
        dispatchFailures.push({ nodeId: claim.nodeId, message: errorMessage(error) });
      }
    }

    const snapshot = await this.options.plans.getSnapshot(descriptor);
    const result: UpdateWorkGraphResult = {
      sessionAgentId: descriptor.agentId,
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      ...(snapshot.explanation ? { explanation: snapshot.explanation } : {}),
      plan: snapshot.plan,
      ...(snapshot.coordinationMode ? { coordinationMode: snapshot.coordinationMode } : {}),
      ...(snapshot.workGraph ? { workGraph: snapshot.workGraph } : {}),
      dispatched,
      dispatchFailures,
      cancelledWorkerIds: updated.cancelledWorkerIds,
    };
    this.options.recordToolSideEffect(callerAgentId, {
      toolName: "update_work_graph",
      toolCallId,
      phase: "side_effect",
      input: updated.input,
      output: result,
      metadata: {
        revision: result.revision,
        nodeCount: result.workGraph?.nodes.length ?? 0,
        dispatchedCount: dispatched.length,
        dispatchFailureCount: dispatchFailures.length,
      },
    });
    return result;
  }

  async resolvePlanStepAssignment(
    callerAgentId: string,
    requestedStep: string,
  ): Promise<{ descriptor: SessionOwner; assignment: PlanStepAssignment }> {
    const descriptor = this.getPlanOwner(callerAgentId, "planStep");
    const assignment = await this.options.plans.resolveAssignment(descriptor, requestedStep);
    return { descriptor, assignment };
  }

  async recordWorkerPlanAssignment(
    descriptor: SessionOwner,
    assignment: PlanStepAssignment,
    input: {
      workerId: string;
      source: "spawn_agent" | "send_message_to_agent";
      deliveryId?: string;
      acceptedMode?: SendMessageReceipt["acceptedMode"];
    },
  ): Promise<void> {
    await this.options.plans.recordWorkerAssignment(descriptor, assignment, input);
  }

  async requestUserChoice(
    agentId: string,
    questions: ChoiceQuestion[],
  ): Promise<ChoiceAnswer[]> {
    this.assertExternalProjectAgentTurnCapabilityAllowed(agentId, "present_choices");
    const activeTurnId = this.options.turns.getActiveTurnId(agentId);
    if (this.options.turns.hasPendingSupersedingUserInput(agentId, activeTurnId)) {
      this.options.logDebug("manager:present_choices:suppressed_superseded_turn", {
        agentId,
        activeTurnId,
      });
      throw new Error("Choice request skipped because a newer user message superseded this turn.");
    }
    const pending = this.options.choices.requestUserChoiceWithId(agentId, questions);
    this.options.assistantOutput.rememberChoiceContinuation(pending.choiceId, agentId);
    this.options.runtimeOutput.flushPreservedManagerAssistantOutputForTool(
      agentId,
      "present_choices",
    );
    return pending.promise;
  }

  resolveChoiceRequest(choiceId: string, answers: ChoiceAnswer[]): void {
    const owner = this.options.choices.getPendingChoiceOwner(choiceId);
    if (owner) {
      this.options.assistantOutput.activateChoiceContinuation(choiceId, owner.agentId);
    } else {
      this.options.assistantOutput.forgetChoiceContinuation(choiceId);
    }
    this.options.choices.resolveChoiceRequest(choiceId, answers);
  }

  cancelChoiceRequest(
    choiceId: string,
    reason: Extract<ChoiceRequestStatus, "cancelled" | "expired">,
  ): void {
    this.options.assistantOutput.forgetChoiceContinuation(choiceId);
    this.options.choices.cancelChoiceRequest(choiceId, reason);
  }

  cancelAllPendingChoicesForAgent(agentId: string): void {
    this.options.assistantOutput.clearChoiceContinuationsForAgent(agentId);
    this.options.choices.cancelAllPendingChoicesForAgent(agentId);
  }

  hasPendingChoicesForSession(sessionAgentId: string): boolean {
    return this.options.choices.hasPendingChoicesForSession(sessionAgentId);
  }

  getPendingChoiceIdsForSession(sessionAgentId: string): string[] {
    return this.options.choices.getPendingChoiceIdsForSession(sessionAgentId);
  }

  getPendingChoiceRequestsForSession(sessionAgentId: string): ChoiceRequestEvent[] {
    return this.options.choices.getPendingChoiceRequestsForSession(sessionAgentId);
  }

  getPendingChoiceOwner(
    choiceId: string,
  ): { agentId: string; sessionAgentId: string } | undefined {
    return this.options.choices.getPendingChoiceOwner(choiceId);
  }

  getPendingChoice(choiceId: string):
    | { agentId: string; sessionAgentId: string; questions: ChoiceQuestion[] }
    | undefined {
    return this.options.choices.getPendingChoice(choiceId);
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    this.assertExternalProjectAgentTurnCapabilityAllowed(callerAgentId, "spawn_agent");
    const planAssignment = input.planStep
      ? await this.resolvePlanStepAssignment(callerAgentId, input.planStep)
      : undefined;
    const requestedSpecialistId = input.specialist
      ? normalizeSpecialistHandle(input.specialist)
      : "";
    const spawned =
      requestedSpecialistId === CODEX_PLUGIN_SPECIALIST_ID
        ? await this.options.codexPlugin.spawnSpecialistWorker(callerAgentId, input)
        : await this.options.lifecycle.spawnAgent(callerAgentId, input);
    const assignmentRecordedByInitialDelivery =
      requestedSpecialistId === CODEX_PLUGIN_SPECIALIST_ID ||
      Boolean(input.initialMessage?.trim());
    if (planAssignment && !assignmentRecordedByInitialDelivery) {
      await this.recordWorkerPlanAssignment(planAssignment.descriptor, planAssignment.assignment, {
        workerId: spawned.agentId,
        source: "spawn_agent",
      });
    }
    return spawned;
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    this.assertExternalProjectAgentTurnCapabilityAllowed(callerAgentId, "kill_agent");
    await this.options.lifecycle.killAgent(callerAgentId, targetAgentId);
  }

  async publishToUser(
    agentId: string,
    text: string,
    source: PublishToUserSource = "speak_to_user",
    targetContext?: MessageTargetContext,
  ): Promise<PublishToUserResult> {
    if (source === "speak_to_user") {
      this.assertExternalProjectAgentTurnCapabilityAllowed(agentId, "speak_to_user");
    }

    let resolvedTargetContext: MessageSourceContext;
    let normalizedText = text;

    if (source === "speak_to_user") {
      const descriptor = this.options.directory.assertManager(agentId, "speak to user");
      resolvedTargetContext = this.resolveReplyTargetContext(targetContext);
      const activeTurnId = this.options.turns.getActiveTurnId(agentId);
      if (this.options.turns.hasPendingSupersedingUserInput(agentId, activeTurnId)) {
        this.options.logDebug("manager:publish_to_user:suppressed_superseded_turn", {
          agentId,
          activeTurnId,
          targetContext: resolvedTargetContext,
          textPreview: previewForLog(text),
        });
        return {
          targetContext: resolvedTargetContext,
          published: false,
          reason: "superseded_by_user_input",
        };
      }
      if (normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID) {
        normalizedText = normalizeCortexUserVisiblePaths(text);
      }
    } else {
      resolvedTargetContext = normalizeMessageSourceContext(targetContext ?? { channel: "web" });
    }

    const payload: ConversationMessageEvent = {
      type: "conversation_message",
      agentId,
      role: source === "system" ? "system" : "assistant",
      text: normalizedText,
      timestamp: this.options.now(),
      source,
      sourceContext: resolvedTargetContext,
    };

    this.options.events.emitConversationMessage(payload);
    if (source === "speak_to_user") {
      this.options.runtimeOutput.markExplicitManagerAssistantOutput(agentId);
      this.options.events.markSessionActivity(agentId, payload.timestamp);
    }

    this.options.logDebug("manager:publish_to_user", {
      source,
      agentId,
      targetContext: resolvedTargetContext,
      textPreview: previewForLog(normalizedText),
    });
    return { targetContext: resolvedTargetContext, published: true };
  }

  async resetManagerSession(
    managerIdOrReason: string | ResetManagerSessionReason = "api_reset",
    maybeReason?: ResetManagerSessionReason,
  ): Promise<void> {
    const { managerId, reason } = this.parseResetManagerSessionArgs(
      managerIdOrReason,
      maybeReason,
    );
    const manager = this.options.directory.getRequiredBuilderManagerDescriptor(
      managerId,
      "reset Builder conversations",
    );
    const profileId = manager.profileId ?? manager.agentId;

    this.options.logDebug("manager:reset:start", { managerId, reason, profileId });
    const { sessionAgent } = await this.options.sessions.createSession(profileId, {
      label: "New chat",
    });
    this.options.events.emitConversationReset(managerId, reason);
    this.options.logDebug("manager:reset:ready", {
      managerId,
      reason,
      profileId,
      newSessionAgentId: sessionAgent.agentId,
    });
  }

  assertExternalProjectAgentTurnCapabilityAllowed(
    callerAgentId: string,
    capability:
      | "spawn_agent"
      | "kill_agent"
      | "create_session"
      | "create_project_agent"
      | "speak_to_user"
      | "present_choices"
      | "update_plan"
      | "update_work_graph",
  ): void {
    const context = this.options.turns.getActiveExternalProjectAgentTurn(callerAgentId);
    if (!context) return;

    throw new Error(
      `External project-agent messages are restricted to a direct reply back to ${context.fromDisplayName} (${context.fromAgentId}). ${capability} is disabled for this turn.`,
    );
  }

  private getPlanOwner(
    callerAgentId: string,
    operation: "update_plan" | "update_work_graph" | "planStep",
  ): SessionOwner {
    const descriptor = this.options.descriptors.get(callerAgentId);
    const operationLabel = operation === "planStep" ? "planStep" : operation;
    if (
      !descriptor ||
      descriptor.role !== "manager" ||
      (operation === "planStep" && !this.options.directory.isSessionAgent(descriptor))
    ) {
      throw new Error(
        operation !== "planStep"
          ? `${operationLabel} is only available to manager sessions.`
          : "planStep is only available to manager sessions with a current working plan.",
      );
    }
    if (descriptor.sessionSurface === "collab") {
      throw new Error(`${operationLabel} is not available for Collaboration sessions.`);
    }
    if (
      operation !== "planStep" &&
      normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID
    ) {
      throw new Error(`${operationLabel} is not available for Cortex sessions.`);
    }
    if (!this.options.directory.isSessionAgent(descriptor)) {
      throw new Error(
        `${operationLabel} requires a manager session with profile context.`,
      );
    }

    if (operation !== "planStep") {
      this.options.directory.assertDescriptorNotEffectivelyArchived(descriptor);
      if (isNonRunningAgentStatus(descriptor.status)) {
        throw new Error(`Manager is not running: ${callerAgentId}`);
      }
    }
    return descriptor as SessionOwner;
  }

  private resolveReplyTargetContext(
    explicitTargetContext?: MessageTargetContext,
  ): MessageSourceContext {
    if (!explicitTargetContext) return { channel: "web" };
    if ((explicitTargetContext as { channel?: unknown }).channel !== "web") {
      throw new Error("speak_to_user only supports web delivery");
    }

    const normalized = normalizeMessageTargetContext(explicitTargetContext);
    return normalizeMessageSourceContext(normalized);
  }

  private parseResetManagerSessionArgs(
    managerIdOrReason: string | ResetManagerSessionReason,
    maybeReason?: ResetManagerSessionReason,
  ): { managerId: string; reason: ResetManagerSessionReason } {
    if (managerIdOrReason === "user_new_command" || managerIdOrReason === "api_reset") {
      const managerId = this.options.directory.resolvePreferredManagerId({
        includeStoppedOnRestart: true,
      });
      if (!managerId) throw new Error("No manager is available.");
      return { managerId, reason: managerIdOrReason };
    }
    return { managerId: managerIdOrReason, reason: maybeReason ?? "api_reset" };
  }
}

function resolveGraphDispatch(claim: WorkGraphDispatchClaim, cwd: string): SpawnAgentInput {
  const acceptance = claim.acceptanceCriteria
    ? `\n\nAcceptance criteria for the manager: ${claim.acceptanceCriteria}`
    : "";
  const dependencies = claim.dependencyContext
    ? [
        "Accepted dependency results (upstream evidence; verify it when this node's acceptance criteria require independent checking):",
        claim.dependencyContext,
      ].join("\n\n")
    : "";
  return resolveManagerDelegation({
    agentId: claim.agentId,
    initialMessage: [
      `Work graph node ${claim.nodeId}: ${claim.title}`,
      "Own this bounded node only. Return a concise status: done, partial, or blocked result with evidence and any follow-up needed.",
      claim.task,
      dependencies,
      acceptance,
    ].filter(Boolean).join("\n\n"),
    mode: claim.behaviorMode,
    executionPolicy: claim.executionPolicy,
    planStep: claim.title,
    cwd,
  }).spawnInput;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
