import { isSystemProfile, type CollaborationAuthor } from "@forge/protocol";
import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import {
  MessageRouter,
  type MessageRouteDecision,
  type MessageRouteProvenance,
  type MessageRouteTargetKind,
} from "./message-router.js";
import { normalizeArchetypeId } from "./prompt-registry.js";
import type {
  AssistantOutputTarget,
  SessionTranscriptAssistantOutputTarget,
} from "./runtime/manager-assistant-output-tracker.js";
import { formatAssistantOutputTargetMetadata } from "./runtime/manager-assistant-output-target-metadata.js";
import type { ManagerAssistantOutputRouteResult } from "./runtime/runtime-event-projector.js";
import type { RuntimeUserMessage } from "./runtime-contracts.js";
import {
  extractRuntimeMessageText,
  previewForLog,
  summarizeTerminalWorkerReportForUser,
} from "./swarm-manager-utils.js";
import type {
  ActiveMessageRouteActivation,
  ManagerOutputTurnActivation,
  ManagerOutputTurnEndContext,
  ManagerOutputTurnPort,
} from "./turn-context-coordinator.js";
import type {
  AgentDescriptor,
  ConversationMessageEvent,
  ManagerProfile,
  MessageSourceContext,
} from "./types.js";

const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";
const COLLABORATION_PROFILE_ID = "_collaboration";
const WORKER_REPORT_MESSAGE_PREFIX = "WORKER REPORT: ";
const TERMINAL_WORKER_REPORT_BODY_PATTERN = /^status:\s*(?:done|partial|blocked|completed)\b/i;
const WORKER_COMPLETION_REPORT_BODY_PATTERN = /^SYSTEM:\s*##\s*Completion Report:\s*\S/i;
const WORKER_COMPLETION_SUMMARY_PATTERN =
  /^(?:completed|corrected|finished)\b[^\n]*\n(?:\s*\n)?summary:\s*\S/iu;

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
  rawMessage?: string;
  workerReportSourceAgentId?: string;
  sendMessageToolContinuation?: boolean;
}

export interface PreparedAgentMessageOutput {
  modelMessage: string | RuntimeUserMessage;
  inputTarget: AssistantOutputTarget;
  projectionTarget: AssistantOutputTarget;
  eligibleWorkerReport: boolean;
  workerReportSourceAgentId?: string;
  normalBuilderWorkerCallback: boolean;
  requiresVisibleResponse: boolean;
}

/**
 * Owns server-authoritative assistant-output routing state.
 *
 * MessageRouter remains the policy matrix. This owner adds the stateful seams
 * around that matrix: active turn targets, worker handoff inheritance, choice
 * continuation, final projection, and the terminal worker-report backstop.
 */
export class AssistantOutputRouter implements ManagerOutputTurnPort {
  private readonly activeTargetByManagerId = new Map<string, AssistantOutputTarget>();
  private readonly activeWebTurnByManagerId = new Map<string, SessionTranscriptAssistantOutputTarget>();
  private readonly activeRouteByManagerId = new Map<string, ActiveMessageRouteActivation>();
  private readonly inheritedTargetByWorkerId = new Map<string, AssistantOutputTarget>();
  private readonly lastTerminalBackstopReportByManagerId = new Map<string, string>();
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
    const eligibleWorkerReport = this.isEligibleWorkerReport(input);
    const workerReportSourceAgentId = eligibleWorkerReport
      ? this.resolveWorkerReportSourceId(input)
      : undefined;
    const inheritedWorkerTarget = input.sender.role === "worker"
      ? this.inheritedTargetByWorkerId.get(input.sender.agentId)
      : undefined;
    const normalBuilderWorkerCallback =
      eligibleWorkerReport &&
      input.target.role === "manager" &&
      input.sender.role === "worker" &&
      input.sender.managerId === input.target.agentId &&
      (
        inheritedWorkerTarget === undefined ||
        inheritedWorkerTarget.kind === "internal_only" ||
        (inheritedWorkerTarget.kind === "session_transcript" && inheritedWorkerTarget.channel === "web")
      ) &&
      this.canProjectFinalTextToWeb(
        input,
        inheritedWorkerTarget ?? inputTarget,
      );
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
      eligibleWorkerReport,
      ...(workerReportSourceAgentId ? { workerReportSourceAgentId } : {}),
      normalBuilderWorkerCallback,
      requiresVisibleResponse,
    };
  }

  recordSuccessfulAgentMessageDispatch(input: AgentMessageOutputInput): void {
    if (this.isEligibleWorkerReport(input) && isExplicitTerminalWorkerReport(input)) {
      const sourceWorkerId = this.resolveWorkerReportSourceId(input);
      if (sourceWorkerId) {
        this.clearConsumedWorkerTarget(sourceWorkerId);
      }
    }

    const { sender, target } = input;
    if (sender.role !== "manager" || target.role !== "worker" || target.managerId !== sender.agentId) {
      return;
    }

    this.inheritedTargetByWorkerId.set(
      target.agentId,
      this.getActiveTargetForDelegation(sender.agentId),
    );
  }

  annotateText(text: string, target: AssistantOutputTarget): string {
    return appendAssistantOutputTargetMetadataToText(text, target);
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
      target: cloneSessionTranscriptTarget(target),
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
      this.activeWebTurnByManagerId.set(agentId, cloneSessionTranscriptTarget(target));
    } else {
      this.activeWebTurnByManagerId.delete(agentId);
    }
  }

  completeProviderCycle(agentId: string, context: ManagerOutputTurnEndContext): void {
    this.activeWebTurnByManagerId.delete(agentId);
    this.expireWebTargetIfUncontinued(agentId, context.pendingTargets);
    if (!this.activeRouteByManagerId.get(agentId)?.normalBuilderWorkerCallback) {
      this.activeRouteByManagerId.delete(agentId);
    }
  }

  completeAgentTurn(agentId: string): void {
    this.clearActiveManagerTurn(agentId);
    this.options.projection.clearManagerAssistantOutputTurn(agentId);
  }

  acceptCleanManagerFinal(agentId: string, context: ManagerOutputTurnEndContext): void {
    this.activeWebTurnByManagerId.delete(agentId);
    this.expireWebTargetIfUncontinued(agentId, context.pendingTargets);
  }

  handleRuntimeError(agentId: string, descriptor: AgentDescriptor | undefined): void {
    if (descriptor?.role === "manager") {
      this.clearActiveManagerTurn(agentId);
      this.clearChoiceContinuationsForAgent(agentId);
      this.clearInheritedTargetsForManager(agentId);
      this.options.projection.clearManagerAssistantOutputTurn(agentId);
      return;
    }

    this.clearRuntimeResettableInheritedTarget(agentId);
  }

  clearForRuntimeReset(agentId: string): void {
    this.clearActiveManagerTurn(agentId);
    this.clearChoiceContinuationsForAgent(agentId);
    this.inheritedTargetByWorkerId.delete(agentId);
    this.clearInheritedTargetsForManager(agentId);
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
        routeContext?.normalBuilderWorkerCallback &&
        targetForRouting.kind === "internal_only" &&
        this.canProjectFinalTextToWeb(
          { sender: manager, target: manager },
          webTarget(),
        )
      ) {
        const target = webTarget();
        const closeoutDecision = this.messageRouter.resolve(this.buildProvenance({
          manager,
          sender: manager,
          target: manager,
          targetKind: "session_transcript",
          sourceContext: target.sourceContext,
          routeContext,
        }));
        if (!closeoutDecision.visible || closeoutDecision.channel !== "web") {
          return { decision };
        }
        return this.visibleRouteResult(closeoutDecision, target, routeContext, requiresVisibleResponse);
      }

      if (
        decision.reasonCode === "route:peer_agent" &&
        routeContext?.origin !== "terminal_worker_report" &&
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
          cloneSessionTranscriptTarget(rememberedTarget),
          routeContext,
          requiresVisibleResponse,
        );
      }

      return {
        decision,
        ...(routeContext?.workerReportSourceAgentId
          ? { sourceWorkerId: routeContext.workerReportSourceAgentId }
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

  deliverTerminalObligationBackstop(agentId: string, reportText: string): boolean {
    const manager = this.options.descriptors.get(agentId);
    if (!manager || manager.role !== "manager" || isNonRunningAgentStatus(manager.status)) {
      return false;
    }

    const route = this.resolveManagerFinalRoute(
      agentId,
      this.activeTargetByManagerId.get(agentId),
    );
    const target = route.target;
    if (!target || target.channel !== "web" || route.requiresVisibleResponse === false) {
      return false;
    }

    if (this.lastTerminalBackstopReportByManagerId.get(agentId) === reportText) {
      return false;
    }

    const summary = summarizeTerminalWorkerReportForUser(reportText, route.sourceWorkerId);
    const timestamp = this.options.now();
    this.options.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: summary,
      timestamp,
      source: "system",
      systemNoticeKind: "worker_outcome_backstop",
      ...(route.sourceWorkerId ? { sourceWorkerId: route.sourceWorkerId } : {}),
      sourceContext: target.sourceContext ?? { channel: "web" },
    });
    this.options.markSessionActivity(agentId, timestamp);
    this.lastTerminalBackstopReportByManagerId.set(agentId, reportText);
    this.options.logDebug("manager:terminal_obligation_backstop_delivered", {
      agentId,
      sourceWorkerId: route.sourceWorkerId,
      textPreview: previewForLog(summary),
    });
    return true;
  }

  getActiveTarget(agentId: string): AssistantOutputTarget | undefined {
    const target = this.activeTargetByManagerId.get(agentId);
    return target ? cloneAssistantOutputTarget(target) : undefined;
  }

  getActiveRoute(agentId: string): ActiveMessageRouteActivation | undefined {
    const route = this.activeRouteByManagerId.get(agentId);
    return route ? { ...route } : undefined;
  }

  getInheritedTarget(workerId: string): AssistantOutputTarget | undefined {
    const target = this.inheritedTargetByWorkerId.get(workerId);
    return target ? cloneAssistantOutputTarget(target) : undefined;
  }

  private resolveTargetForAgentMessage(input: AgentMessageOutputInput): AssistantOutputTarget {
    const reportLike =
      input.target.role === "manager" &&
      (
        isWorkerReportRuntimeMessage(input.modelMessage) ||
        isWorkerStatusCloseoutMessage(input.rawMessage) ||
        (input.sender.role === "worker" && isWorkerCompletionReportMessage(input.rawMessage))
      );
    if (!this.isEligibleWorkerReport(input)) {
      return reportLike
        ? { kind: "internal_only", reason: "missing_worker_report_provenance" }
        : { kind: "explicit_tool_required", reason: "agent_message" };
    }

    const sourceWorkerId = this.resolveWorkerReportSourceId(input);
    if (!sourceWorkerId) {
      return { kind: "internal_only", reason: "missing_worker_report_provenance" };
    }

    const inheritedTarget = this.inheritedTargetByWorkerId.get(sourceWorkerId);
    if (inheritedTarget?.kind === "session_transcript" && inheritedTarget.channel === "web") {
      return { kind: "internal_only", reason: "worker_report_callback" };
    }
    if (inheritedTarget?.kind === "session_transcript" || inheritedTarget?.kind === "internal_only") {
      return cloneAssistantOutputTarget(inheritedTarget);
    }
    return inheritedTarget
      ? { kind: "explicit_tool_required", reason: "worker_report" }
      : { kind: "internal_only", reason: "missing_worker_report_handoff" };
  }

  private resolveProjectionTargetForAgentMessage(
    input: AgentMessageOutputInput,
    inputTarget: AssistantOutputTarget,
  ): AssistantOutputTarget {
    if (inputTarget.kind === "explicit_tool_required" && inputTarget.reason === "worker_report") {
      const sourceWorkerId = this.resolveWorkerReportSourceId(input);
      const inheritedTarget = sourceWorkerId
        ? this.inheritedTargetByWorkerId.get(sourceWorkerId)
        : undefined;
      if (
        inheritedTarget?.kind === "external_channel" ||
        inheritedTarget?.kind === "peer_agent" ||
        inheritedTarget?.kind === "explicit_tool_required"
      ) {
        return cloneAssistantOutputTarget(inheritedTarget);
      }
    }

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
    input: Pick<AgentMessageOutputInput, "sender" | "target" | "workerReportSourceAgentId">,
    inputTarget: AssistantOutputTarget,
  ): SessionTranscriptAssistantOutputTarget | undefined {
    const workerReportSourceAgentId = this.resolveWorkerReportSourceId(input);

    if (inputTarget.kind === "session_transcript") {
      if (inputTarget.channel !== "web") {
        return cloneSessionTranscriptTarget(inputTarget);
      }

      const decision = this.messageRouter.resolve(this.buildProvenance({
        manager: input.target,
        sender: input.sender,
        target: input.target,
        targetKind: "session_transcript",
        sourceContext: inputTarget.sourceContext ?? { channel: "web" },
        routeContext: {
          origin: workerReportSourceAgentId ? "terminal_worker_report" : "internal",
          requiresVisibleResponse: false,
          ...(workerReportSourceAgentId ? { workerReportSourceAgentId } : {}),
        },
      }));
      if (!decision.visible || decision.channel !== "web") {
        return this.canProjectFinalTextToWeb(input, inputTarget)
          ? cloneSessionTranscriptTarget(inputTarget)
          : undefined;
      }
      return cloneSessionTranscriptTarget(inputTarget);
    }

    const decision = this.messageRouter.resolve(this.buildProvenance({
      manager: input.target,
      sender: input.sender,
      target: input.target,
      targetKind: targetKind(inputTarget),
      sourceContext: sourceContext(inputTarget),
      routeContext: {
        origin: workerReportSourceAgentId ? "terminal_worker_report" : "internal",
        requiresVisibleResponse: false,
        ...(workerReportSourceAgentId ? { workerReportSourceAgentId } : {}),
      },
    }));
    if (!decision.visible || decision.channel !== "web") {
      const restoredDefaultWebAllowance =
        (inputTarget.kind === "peer_agent" && !workerReportSourceAgentId) ||
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
    input: Pick<AgentMessageOutputInput, "sender" | "target" | "workerReportSourceAgentId">,
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

  private isEligibleWorkerReport(input: AgentMessageOutputInput): boolean {
    if (input.target.role !== "manager" || !this.resolveWorkerReportSourceId(input)) {
      return false;
    }

    return (
      isWorkerReportRuntimeMessage(input.modelMessage) ||
      isWorkerStatusCloseoutMessage(input.rawMessage) ||
      isWorkerCompletionReportMessage(input.rawMessage)
    );
  }

  private resolveWorkerReportSourceId(
    input: Pick<AgentMessageOutputInput, "sender" | "target" | "workerReportSourceAgentId">,
  ): string | undefined {
    if (input.sender.role === "worker" && input.sender.managerId === input.target.agentId) {
      return input.sender.agentId;
    }

    if (!input.workerReportSourceAgentId) {
      return undefined;
    }

    const worker = this.options.descriptors.get(input.workerReportSourceAgentId);
    return worker?.role === "worker" && worker.managerId === input.target.agentId
      ? worker.agentId
      : undefined;
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
      ...(routeContext?.workerReportSourceAgentId
        ? { sourceWorkerId: routeContext.workerReportSourceAgentId }
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

  private getActiveTargetForDelegation(managerId: string): AssistantOutputTarget {
    const target = this.activeTargetByManagerId.get(managerId);
    return target
      ? cloneAssistantOutputTarget(target)
      : { kind: "internal_only", reason: "no_active_root" };
  }

  private clearConsumedWorkerTarget(agentId: string): void {
    const target = this.inheritedTargetByWorkerId.get(agentId);
    if (target?.kind === "session_transcript") {
      this.inheritedTargetByWorkerId.delete(agentId);
    }
  }

  private clearInheritedTargetsForManager(managerId: string): void {
    this.clearRuntimeResettableInheritedTarget(managerId);
    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.role === "worker" && descriptor.managerId === managerId) {
        this.clearRuntimeResettableInheritedTarget(descriptor.agentId);
      }
    }
  }

  private clearRuntimeResettableInheritedTarget(agentId: string): void {
    if (this.inheritedTargetByWorkerId.get(agentId)?.kind === "session_transcript") {
      this.inheritedTargetByWorkerId.delete(agentId);
    }
  }

  private clearActiveManagerTurn(agentId: string): void {
    this.activeTargetByManagerId.delete(agentId);
    this.activeWebTurnByManagerId.delete(agentId);
    this.activeRouteByManagerId.delete(agentId);
  }

  private expireWebTargetIfUncontinued(
    agentId: string,
    pendingTargets: readonly AssistantOutputTarget[],
  ): void {
    const activeTarget = this.activeTargetByManagerId.get(agentId);
    if (activeTarget?.kind !== "session_transcript" || activeTarget.channel !== "web") {
      return;
    }

    const hasPendingWebTarget = pendingTargets.some(
      (target) => target.kind === "session_transcript" && target.channel === "web",
    );
    if (!hasPendingWebTarget) {
      this.activeTargetByManagerId.delete(agentId);
    }
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

function cloneSessionTranscriptTarget(
  target: SessionTranscriptAssistantOutputTarget,
): SessionTranscriptAssistantOutputTarget {
  return {
    kind: "session_transcript",
    channel: target.channel,
    ...(target.sourceContext ? { sourceContext: { ...target.sourceContext } } : {}),
  };
}

function cloneAssistantOutputTarget(target: AssistantOutputTarget): AssistantOutputTarget {
  switch (target.kind) {
    case "session_transcript":
      return cloneSessionTranscriptTarget(target);
    case "external_channel":
      return { kind: "external_channel", sourceContext: { ...target.sourceContext } };
    case "peer_agent":
      return { kind: "peer_agent", fromAgentId: target.fromAgentId };
    case "explicit_tool_required":
      return { kind: "explicit_tool_required", reason: target.reason };
    case "internal_only":
      return { kind: "internal_only", ...(target.reason ? { reason: target.reason } : {}) };
  }
}

function isWorkerReportRuntimeMessage(message: string | RuntimeUserMessage): boolean {
  return extractRuntimeMessageText(message).trimStart().startsWith(WORKER_REPORT_MESSAGE_PREFIX);
}

function isWorkerStatusCloseoutMessage(message: string | undefined): boolean {
  return typeof message === "string" && TERMINAL_WORKER_REPORT_BODY_PATTERN.test(message.trimStart());
}

function isWorkerCompletionReportMessage(message: string | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }
  const normalized = message.trimStart();
  return (
    WORKER_COMPLETION_REPORT_BODY_PATTERN.test(normalized) ||
    WORKER_COMPLETION_SUMMARY_PATTERN.test(normalized)
  );
}

function isExplicitTerminalWorkerReport(input: AgentMessageOutputInput): boolean {
  return (
    input.workerReportSourceAgentId !== undefined ||
    isWorkerReportRuntimeMessage(input.modelMessage) ||
    isWorkerStatusCloseoutMessage(input.rawMessage) ||
    (
      typeof input.rawMessage === "string" &&
      WORKER_COMPLETION_REPORT_BODY_PATTERN.test(input.rawMessage.trimStart())
    )
  );
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
