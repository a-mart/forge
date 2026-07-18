import { isSystemProfile, type CollaborationAuthor } from "@forge/protocol";
import {
  MessageRouter,
  type MessageRouteDecision,
  type MessageRouteProvenance,
  type MessageRouteTargetKind,
} from "./message-router.js";
import { normalizeArchetypeId } from "./prompt-registry.js";
import {
  cloneAssistantOutputTarget,
  cloneSessionTranscriptAssistantOutputTarget,
} from "./assistant-output-target.js";
import { formatAssistantOutputTargetMetadata } from "./runtime/manager-assistant-output-target-metadata.js";
import type { ManagerAssistantOutputRouteResult } from "./runtime/runtime-event-projector.js";
import type { RuntimeUserMessage } from "./runtime-contracts.js";
import type {
  ActiveMessageRouteActivation,
  ManagerOutputTurnActivation,
  ManagerOutputTurnEndContext,
  ManagerOutputTurnPort,
} from "./turn-context-coordinator.js";
import type {
  AgentDescriptor,
  AssistantOutputTarget,
  ConversationMessageEvent,
  ManagerProfile,
  MessageSourceContext,
  SessionTranscriptAssistantOutputTarget,
  WorkerParentContext,
} from "./types.js";

const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";
const COLLABORATION_PROFILE_ID = "_collaboration";

interface PendingChoiceContinuation {
  managerId: string;
  target: SessionTranscriptAssistantOutputTarget;
}

export interface AssistantOutputProjectionPort {
  activateManagerAssistantOutputTurn(
    agentId: string,
    target: AssistantOutputTarget,
    options?: { turnId?: string; beginUserVisibleObligation?: boolean },
  ): void;
  clearManagerAssistantOutputTurn(agentId: string): void;
}

export interface AssistantOutputRouterOptions {
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  projection: AssistantOutputProjectionPort;
  /** Choice answers resume a provider turn outside the normal inbound queue. */
  markTurnActivatedExternally(agentId: string): void;
  emitConversationMessage(event: ConversationMessageEvent): void;
  markSessionActivity(agentId: string, timestamp: string): void;
  now(): string;
  logDebug(message: string, details?: unknown): void;
}

export interface AgentMessageOutputInput {
  sender: AgentDescriptor;
  target: AgentDescriptor;
  modelMessage: string | RuntimeUserMessage;
  sendMessageToolContinuation?: boolean;
}

export interface WorkerResultOutputInput {
  worker: AgentDescriptor & { role: "worker" };
  target: AgentDescriptor & { role: "manager" };
  parentContext: WorkerParentContext;
  modelMessage: string | RuntimeUserMessage;
}

export interface PreparedAgentMessageOutput {
  modelMessage: string | RuntimeUserMessage;
  inputTarget: AssistantOutputTarget;
  projectionTarget: AssistantOutputTarget;
  sourceWorkerId?: string;
  requiresVisibleResponse: boolean;
}

/**
 * Owns server-authoritative assistant-output routing state.
 *
 * MessageRouter remains the policy matrix. This owner adds the stateful seams
 * around that matrix: active turn targets, choice continuation, and final
 * projection.
 */
export class AssistantOutputRouter implements ManagerOutputTurnPort {
  private readonly activeTargetByManagerId = new Map<string, AssistantOutputTarget>();
  private readonly activeWebTurnByManagerId = new Map<string, SessionTranscriptAssistantOutputTarget>();
  private readonly activeRouteByManagerId = new Map<string, ActiveMessageRouteActivation>();
  // Choice and compaction continuations can delegate after their queued route has ended.
  // This is intentionally runtime-scoped; each worker assignment persists the resolved target.
  private readonly lastRoutedTargetByManagerId = new Map<string, AssistantOutputTarget>();
  private readonly pendingChoiceByChoiceId = new Map<string, PendingChoiceContinuation>();
  private readonly messageRouter = new MessageRouter();

  constructor(private readonly options: AssistantOutputRouterOptions) {}

  resolveTargetForUserInput(
    target: AgentDescriptor,
    sourceContext: MessageSourceContext,
    collaborationAuthor?: CollaborationAuthor,
  ): AssistantOutputTarget {
    if (collaborationAuthor?.channelId) {
      return { kind: "explicit_tool_required", reason: "collaboration_channel" };
    }

    if (
      target.sessionPurpose === "cortex_review" ||
      normalizeArchetypeId(target.archetypeId ?? "") === CORTEX_ARCHETYPE_ID
    ) {
      return { kind: "explicit_tool_required", reason: "cortex_session" };
    }

    if (sourceContext.channel === "web") {
      return { kind: "session_transcript", channel: "web", sourceContext };
    }

    if (sourceContext.channel === "telegram") {
      return { kind: "external_channel", sourceContext };
    }

    return {
      kind: "explicit_tool_required",
      reason: `unsupported_direct_${sourceContext.channel}_source`,
    };
  }

  prepareAgentMessage(input: AgentMessageOutputInput): PreparedAgentMessageOutput {
    const inputTarget = this.resolveTargetForAgentMessage(input);
    const projectionTarget = this.resolveProjectionTargetForAgentMessage(input, inputTarget);
    const requiresVisibleResponse =
      input.sendMessageToolContinuation && input.sender.agentId === input.target.agentId
        ? this.activeRouteByManagerId.get(input.target.agentId)?.requiresVisibleResponse === true
        : false;

    return {
      modelMessage: input.target.role === "manager"
        ? appendAssistantOutputTargetMetadata(input.modelMessage, inputTarget)
        : input.modelMessage,
      inputTarget,
      projectionTarget,
      requiresVisibleResponse,
    };
  }

  prepareWorkerResult(input: WorkerResultOutputInput): PreparedAgentMessageOutput {
    const parentTarget = input.parentContext.outputTarget;
    const target = isMissingWorkerParentTarget(parentTarget)
      ? this.resolveWorkerParentOutputTarget(input.target.agentId)
      : cloneAssistantOutputTarget(parentTarget);
    return {
      modelMessage: appendAssistantOutputTargetMetadata(input.modelMessage, target),
      inputTarget: target,
      projectionTarget: target,
      sourceWorkerId: input.worker.agentId,
      requiresVisibleResponse: false,
    };
  }

  annotateText(text: string, target: AssistantOutputTarget): string {
    return appendAssistantOutputTargetMetadataToText(text, target);
  }

  resolveWorkerParentOutputTarget(
    managerId: string,
    activeTarget?: AssistantOutputTarget,
  ): AssistantOutputTarget {
    if (activeTarget) {
      return cloneAssistantOutputTarget(activeTarget);
    }

    const routerTarget = this.activeTargetByManagerId.get(managerId);
    if (routerTarget) {
      return cloneAssistantOutputTarget(routerTarget);
    }

    const routedTarget = this.lastRoutedTargetByManagerId.get(managerId);
    if (routedTarget) {
      return cloneAssistantOutputTarget(routedTarget);
    }

    const manager = this.options.descriptors.get(managerId);
    const missingTarget: AssistantOutputTarget = {
      kind: "internal_only",
      reason: "no_active_parent",
    };
    // Probe with the missing target so protected/project-agent sessions remain fail-closed.
    return manager?.role === "manager" &&
      this.canProjectFinalTextToWeb({ sender: manager, target: manager }, missingTarget)
      ? webTarget()
      : missingTarget;
  }

  rememberChoiceContinuation(choiceId: string, agentId: string): void {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    const target = this.activeTargetByManagerId.get(agentId);
    if (!target || target.kind !== "session_transcript" || target.channel !== "web") {
      return;
    }

    this.pendingChoiceByChoiceId.set(choiceId, {
      managerId: agentId,
      target: cloneSessionTranscriptAssistantOutputTarget(target),
    });
  }

  activateChoiceContinuation(choiceId: string, ownerAgentId: string): boolean {
    const continuation = this.pendingChoiceByChoiceId.get(choiceId);
    this.pendingChoiceByChoiceId.delete(choiceId);
    if (!continuation || continuation.managerId !== ownerAgentId) {
      return false;
    }

    const descriptor = this.options.descriptors.get(continuation.managerId);
    if (!descriptor || descriptor.role !== "manager" || descriptor.collab) {
      return false;
    }

    this.options.markTurnActivatedExternally(continuation.managerId);
    this.activeTargetByManagerId.set(continuation.managerId, continuation.target);
    this.options.projection.activateManagerAssistantOutputTurn(
      continuation.managerId,
      continuation.target,
    );
    return true;
  }

  forgetChoiceContinuation(choiceId: string): void {
    this.pendingChoiceByChoiceId.delete(choiceId);
  }

  clearChoiceContinuationsForAgent(agentId: string): void {
    for (const [choiceId, continuation] of this.pendingChoiceByChoiceId) {
      if (continuation.managerId === agentId) {
        this.pendingChoiceByChoiceId.delete(choiceId);
      }
    }
  }

  activateManagerTurn(agentId: string, activation: ManagerOutputTurnActivation): void {
    const manager = this.options.descriptors.get(agentId);
    if (manager?.role !== "manager") {
      return;
    }

    if (!activation.target) {
      this.clearActiveManagerTurn(agentId);
      this.options.projection.clearManagerAssistantOutputTurn(agentId);
      return;
    }

    const target = cloneAssistantOutputTarget(activation.target);
    this.activeTargetByManagerId.set(agentId, target);
    this.lastRoutedTargetByManagerId.set(agentId, cloneAssistantOutputTarget(target));
    if (activation.routeContext) {
      this.activeRouteByManagerId.set(agentId, { ...activation.routeContext });
    } else {
      this.activeRouteByManagerId.delete(agentId);
    }
    this.options.projection.activateManagerAssistantOutputTurn(agentId, target, {
      ...(activation.turnId ? { turnId: activation.turnId } : {}),
      beginUserVisibleObligation: activation.beginUserVisibleObligation,
    });
    if (target.kind === "session_transcript" && target.channel === "web") {
      this.activeWebTurnByManagerId.set(
        agentId,
        cloneSessionTranscriptAssistantOutputTarget(target),
      );
    } else {
      this.activeWebTurnByManagerId.delete(agentId);
    }
  }

  completeProviderCycle(agentId: string, context: ManagerOutputTurnEndContext): void {
    void agentId;
    void context;
  }

  completeAgentTurn(agentId: string): void {
    this.clearActiveManagerTurn(agentId);
    this.options.projection.clearManagerAssistantOutputTurn(agentId);
  }

  acceptCleanManagerFinal(agentId: string, context: ManagerOutputTurnEndContext): void {
    void agentId;
    void context;
  }

  handleRuntimeError(agentId: string, descriptor: AgentDescriptor | undefined): void {
    if (descriptor?.role === "manager") {
      this.clearActiveManagerTurn(agentId);
      this.clearChoiceContinuationsForAgent(agentId);
      this.options.projection.clearManagerAssistantOutputTurn(agentId);
    }
  }

  clearForRuntimeReset(agentId: string): void {
    this.clearActiveManagerTurn(agentId);
    this.lastRoutedTargetByManagerId.delete(agentId);
    this.clearChoiceContinuationsForAgent(agentId);
    this.options.projection.clearManagerAssistantOutputTurn(agentId);
  }

  resolveManagerFinalTarget(
    agentId: string,
    activeTarget: AssistantOutputTarget | undefined,
  ): SessionTranscriptAssistantOutputTarget | undefined {
    return this.resolveManagerFinalRoute(agentId, activeTarget).target;
  }

  resolveManagerFinalRoute(
    agentId: string,
    activeTarget: AssistantOutputTarget | undefined,
  ): ManagerAssistantOutputRouteResult {
    const manager = this.options.descriptors.get(agentId);
    if (!manager || manager.role !== "manager") {
      return {
        decision: this.messageRouter.resolve({
          origin: "internal",
          targetKind: "internal_only",
          role: "worker",
        }),
        requiresVisibleResponse: false,
      };
    }

    const rememberedTarget = activeTarget ?? this.activeTargetByManagerId.get(agentId);
    const fallbackTarget: AssistantOutputTarget = {
      kind: "explicit_tool_required",
      reason: "missing_active_target",
    };
    const routeContext = this.activeRouteByManagerId.get(agentId);
    const requiresVisibleResponse = routeContext
      ? routeContext.requiresVisibleResponse ??
        (routeContext.origin === "user" || routeContext.origin === "scheduled")
      : true;
    const targetForRouting = rememberedTarget ?? fallbackTarget;
    const decision = this.messageRouter.resolve(this.buildProvenance({
      manager,
      sender: manager,
      target: manager,
      targetKind: targetKind(targetForRouting),
      sourceContext: sourceContext(targetForRouting),
      routeContext,
    }));

    if (!decision.visible || decision.channel !== "web") {
      if (
        decision.reasonCode === "route:peer_agent" &&
        routeContext?.origin !== "worker_result" &&
        this.canProjectFinalTextToWeb({ sender: manager, target: manager }, targetForRouting)
      ) {
        return this.forcedWebRouteResult(decision, routeContext, requiresVisibleResponse);
      }

      if (
        rememberedTarget?.kind === "session_transcript" &&
        rememberedTarget.channel === "web" &&
        this.canProjectFinalTextToWeb({ sender: manager, target: manager }, rememberedTarget)
      ) {
        return this.visibleRouteResult(
          forceWebDecision(decision),
          cloneSessionTranscriptAssistantOutputTarget(rememberedTarget),
          routeContext,
          requiresVisibleResponse,
        );
      }

      return {
        decision,
        ...(routeContext?.sourceWorkerId
          ? { sourceWorkerId: routeContext.sourceWorkerId }
          : {}),
        requiresVisibleResponse,
      };
    }

    const target: SessionTranscriptAssistantOutputTarget = {
      kind: "session_transcript",
      channel: "web",
      sourceContext: sourceContext(targetForRouting) ?? { channel: "web" },
    };
    return this.visibleRouteResult(decision, target, routeContext, requiresVisibleResponse);
  }

  getActiveTarget(agentId: string): AssistantOutputTarget | undefined {
    const target = this.activeTargetByManagerId.get(agentId);
    return target ? cloneAssistantOutputTarget(target) : undefined;
  }

  getActiveRoute(agentId: string): ActiveMessageRouteActivation | undefined {
    const route = this.activeRouteByManagerId.get(agentId);
    return route ? { ...route } : undefined;
  }

  private resolveTargetForAgentMessage(input: AgentMessageOutputInput): AssistantOutputTarget {
    void input;
    return { kind: "explicit_tool_required", reason: "agent_message" };
  }

  private resolveProjectionTargetForAgentMessage(
    input: AgentMessageOutputInput,
    inputTarget: AssistantOutputTarget,
  ): AssistantOutputTarget {
    const activeContinuation = this.resolveActiveWebContinuation(input, inputTarget);
    if (activeContinuation) {
      return activeContinuation;
    }

    return this.resolveDefaultWebProjection(input, inputTarget) ?? inputTarget;
  }

  private resolveActiveWebContinuation(
    input: AgentMessageOutputInput,
    inputTarget: AssistantOutputTarget,
  ): SessionTranscriptAssistantOutputTarget | undefined {
    if (
      input.target.role !== "manager" ||
      inputTarget.kind !== "explicit_tool_required" ||
      inputTarget.reason !== "agent_message" ||
      input.sender.agentId !== input.target.agentId ||
      input.sendMessageToolContinuation !== true
    ) {
      return undefined;
    }

    const activeTarget = this.activeWebTurnByManagerId.get(input.target.agentId);
    return activeTarget
      ? this.resolveDefaultWebProjection(input, activeTarget)
      : undefined;
  }

  private resolveDefaultWebProjection(
    input: Pick<AgentMessageOutputInput, "sender" | "target">,
    inputTarget: AssistantOutputTarget,
  ): SessionTranscriptAssistantOutputTarget | undefined {
    if (inputTarget.kind === "session_transcript") {
      if (inputTarget.channel !== "web") {
        return cloneSessionTranscriptAssistantOutputTarget(inputTarget);
      }

      const decision = this.messageRouter.resolve(this.buildProvenance({
        manager: input.target,
        sender: input.sender,
        target: input.target,
        targetKind: "session_transcript",
        sourceContext: inputTarget.sourceContext ?? { channel: "web" },
        routeContext: {
          origin: "internal",
          requiresVisibleResponse: false,
        },
      }));
      if (!decision.visible || decision.channel !== "web") {
        return this.canProjectFinalTextToWeb(input, inputTarget)
          ? cloneSessionTranscriptAssistantOutputTarget(inputTarget)
          : undefined;
      }
      return cloneSessionTranscriptAssistantOutputTarget(inputTarget);
    }

    const decision = this.messageRouter.resolve(this.buildProvenance({
      manager: input.target,
      sender: input.sender,
      target: input.target,
      targetKind: targetKind(inputTarget),
      sourceContext: sourceContext(inputTarget),
      routeContext: {
        origin: "internal",
        requiresVisibleResponse: false,
      },
    }));
    if (!decision.visible || decision.channel !== "web") {
      const restoredDefaultWebAllowance =
        inputTarget.kind === "peer_agent" ||
        (
          inputTarget.kind === "explicit_tool_required" &&
          inputTarget.reason === "agent_message" &&
          input.sender.role === "manager" &&
          input.sender.agentId !== input.target.agentId
        );
      return restoredDefaultWebAllowance && this.canProjectFinalTextToWeb(input, inputTarget)
        ? webTarget()
        : undefined;
    }

    return webTarget();
  }

  private canProjectFinalTextToWeb(
    input: Pick<AgentMessageOutputInput, "sender" | "target">,
    inputTarget: AssistantOutputTarget,
  ): boolean {
    const { sender, target } = input;
    if (target.role !== "manager") {
      return false;
    }

    if (
      (target.projectAgent !== undefined || target.creatorAgentId !== undefined) &&
      inputTarget.kind !== "session_transcript"
    ) {
      return false;
    }

    if (
      sender.role === "manager" &&
      sender.agentId !== target.agentId &&
      (target.projectAgent !== undefined || target.creatorAgentId === sender.agentId)
    ) {
      return false;
    }

    if (
      sender.role === "worker" &&
      (target.projectAgent !== undefined || target.creatorAgentId !== undefined) &&
      inputTarget.kind !== "session_transcript"
    ) {
      return false;
    }

    if (target.sessionSurface === "collab" || target.collab) {
      return false;
    }

    if (
      target.agentId === COLLABORATION_PROFILE_ID ||
      target.profileId === COLLABORATION_PROFILE_ID ||
      target.agentId === CORTEX_PROFILE_ID ||
      target.profileId === CORTEX_PROFILE_ID
    ) {
      return false;
    }

    const profile = target.profileId
      ? this.options.profiles.get(target.profileId)
      : undefined;
    if (profile && isSystemProfile(profile)) {
      return false;
    }

    const archetypeId = normalizeArchetypeId(target.archetypeId ?? "");
    return !(
      target.sessionPurpose === "cortex_review" ||
      archetypeId === CORTEX_ARCHETYPE_ID ||
      archetypeId === "collaboration-channel"
    );
  }

  private buildProvenance(input: {
    manager: AgentDescriptor;
    sender: AgentDescriptor;
    target: AgentDescriptor;
    targetKind: MessageRouteTargetKind;
    sourceContext?: MessageSourceContext;
    routeContext?: ActiveMessageRouteActivation;
  }): MessageRouteProvenance {
    const targetProfile = input.target.profileId
      ? this.options.profiles.get(input.target.profileId)
      : undefined;
    return {
      origin: input.routeContext?.origin ?? "user",
      ...(input.routeContext?.internalDeliveryKind
        ? { internalDeliveryKind: input.routeContext.internalDeliveryKind }
        : {}),
      ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
      ...(input.target.sessionPurpose ? { sessionPurpose: input.target.sessionPurpose } : {}),
      ...(input.target.archetypeId ? { archetypeId: input.target.archetypeId } : {}),
      targetKind: input.targetKind,
      role: input.target.role,
      senderRole: input.sender.role,
      senderAgentId: input.sender.agentId,
      targetAgentId: input.target.agentId,
      ...(input.target.profileId ? { targetProfileId: input.target.profileId } : {}),
      ...(input.target.sessionSurface
        ? { targetSessionSurface: input.target.sessionSurface }
        : {}),
      targetCollab: Boolean(input.target.collab || input.routeContext?.collaboration),
      targetProjectAgent: input.target.projectAgent !== undefined,
      ...(input.target.creatorAgentId
        ? { targetCreatorAgentId: input.target.creatorAgentId }
        : {}),
      targetProfileSystem: Boolean(targetProfile && isSystemProfile(targetProfile)),
      ...(input.target.projectAgent ? { projectAgentContext: input.target.projectAgent } : {}),
    };
  }

  private visibleRouteResult(
    decision: MessageRouteDecision,
    target: SessionTranscriptAssistantOutputTarget,
    routeContext: ActiveMessageRouteActivation | undefined,
    requiresVisibleResponse: boolean,
  ): ManagerAssistantOutputRouteResult {
    return {
      decision,
      ...(routeContext?.sourceWorkerId
        ? { sourceWorkerId: routeContext.sourceWorkerId }
        : {}),
      target,
      requiresVisibleResponse,
    };
  }

  private forcedWebRouteResult(
    decision: MessageRouteDecision,
    routeContext: ActiveMessageRouteActivation | undefined,
    requiresVisibleResponse: boolean,
  ): ManagerAssistantOutputRouteResult {
    return this.visibleRouteResult(
      forceWebDecision(decision),
      webTarget(),
      routeContext,
      requiresVisibleResponse,
    );
  }

  private clearActiveManagerTurn(agentId: string): void {
    this.activeTargetByManagerId.delete(agentId);
    this.activeWebTurnByManagerId.delete(agentId);
    this.activeRouteByManagerId.delete(agentId);
  }

}

function webTarget(): SessionTranscriptAssistantOutputTarget {
  return {
    kind: "session_transcript",
    channel: "web",
    sourceContext: { channel: "web" },
  };
}

function forceWebDecision(decision: MessageRouteDecision): MessageRouteDecision {
  return {
    ...decision,
    visible: true,
    decision: "render",
    channel: "web",
    reasonCode: "render:user_web",
  };
}

function targetKind(target: AssistantOutputTarget): MessageRouteTargetKind {
  return target.kind;
}

function sourceContext(target: AssistantOutputTarget): MessageSourceContext | undefined {
  return target.kind === "session_transcript" || target.kind === "external_channel"
    ? target.sourceContext
    : undefined;
}

function isMissingWorkerParentTarget(target: AssistantOutputTarget): boolean {
  return target.kind === "internal_only" && target.reason === "no_active_parent";
}

function appendAssistantOutputTargetMetadata(
  message: string | RuntimeUserMessage,
  target: AssistantOutputTarget,
): string | RuntimeUserMessage {
  if (typeof message === "string") {
    return appendAssistantOutputTargetMetadataToText(message, target);
  }

  return {
    ...message,
    text: appendAssistantOutputTargetMetadataToText(message.text, target),
  };
}

function appendAssistantOutputTargetMetadataToText(
  text: string,
  target: AssistantOutputTarget,
): string {
  const marker = formatAssistantOutputTargetMetadata(target);
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd < 0) {
    return `${text}\n${marker}`;
  }

  return `${text.slice(0, firstLineEnd)}\n${marker}${text.slice(firstLineEnd)}`;
}
