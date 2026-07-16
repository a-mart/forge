import type { CollaborationAuthor } from "@forge/protocol";
import { extractMessageText, extractRole } from "./message-utils.js";
import type {
  MessageRouteInternalDeliveryKind,
  MessageRouteOrigin,
} from "./message-router.js";
import { cloneAssistantOutputTarget } from "./assistant-output-target.js";
import { isCleanManagerAssistantFinalMessage } from "./runtime/manager-assistant-final-message.js";
import type {
  RuntimeSessionEvent,
  RuntimeSessionMessage,
} from "./runtime-contracts.js";
import type {
  AgentDescriptor,
  AssistantOutputTarget,
  ConversationMessageEvent,
  MessageSourceContext,
} from "./types.js";
import type { TurnLedgerInboundKind } from "./turn-ledger.js";

export type InboundTurnSource =
  | "user_input"
  | "project_agent_input"
  | "agent_message"
  | "worker_result";

export interface InboundTurnContextInput<
  TCodexGate = unknown,
  TCodexDelegation = unknown,
  TCodexRetryAuthorization = unknown,
> {
  activationEligible?: boolean;
  source: InboundTurnSource;
  routeOrigin?: MessageRouteOrigin;
  internalDeliveryKind?: MessageRouteInternalDeliveryKind;
  sourceWorkerId?: string;
  /** Whether ending this inbound obligation silently is a user-facing failure. */
  requiresVisibleResponse?: boolean;
  rootTurnId?: string;
  parentRootTurnId?: string;
  runtimeMessageText?: string;
  projectAgentContext?: ConversationMessageEvent["projectAgentContext"];
  sourceContext?: MessageSourceContext;
  collaborationAuthor?: CollaborationAuthor;
  assistantOutputTarget?: AssistantOutputTarget;
  assistantOutputProjectionTarget?: AssistantOutputTarget;
  codexMcpToolGate?: TCodexGate;
  codexPluginDelegationContext?: TCodexDelegation;
  codexPluginRetryAuthorizationContext?: TCodexRetryAuthorization;
  skipTurnLedger?: boolean;
}

interface QueuedInboundTurnContext<
  TCodexGate,
  TCodexDelegation,
  TCodexRetryAuthorization,
> extends InboundTurnContextInput<TCodexGate, TCodexDelegation, TCodexRetryAuthorization> {
  turnId: string;
  runtimeToken?: number;
  activationEligible: boolean;
}

export interface ActiveExternalProjectAgentTurn {
  fromAgentId: string;
  fromDisplayName: string;
  fromProfileId?: string;
  fromProjectName?: string;
}

export interface ActiveMessageRouteActivation {
  origin: MessageRouteOrigin;
  internalDeliveryKind?: MessageRouteInternalDeliveryKind;
  sourceWorkerId?: string;
  requiresVisibleResponse: boolean;
  collaboration?: boolean;
}

export interface ManagerOutputTurnActivation {
  target?: AssistantOutputTarget;
  routeContext?: ActiveMessageRouteActivation;
  turnId?: string;
  beginUserVisibleObligation: boolean;
}

export interface ManagerOutputTurnEndContext {
  pendingTargets: readonly AssistantOutputTarget[];
}

export interface ManagerOutputTurnPort {
  activateManagerTurn(agentId: string, activation: ManagerOutputTurnActivation): void;
  completeProviderCycle(agentId: string, context: ManagerOutputTurnEndContext): void;
  completeAgentTurn(agentId: string): void;
  acceptCleanManagerFinal(agentId: string, context: ManagerOutputTurnEndContext): void;
  handleRuntimeError(agentId: string, descriptor: AgentDescriptor | undefined): void;
  clearForRuntimeReset(agentId: string): void;
}

export interface CodexTurnActivation<
  TCodexGate,
  TCodexDelegation,
  TCodexRetryAuthorization,
> {
  gate?: TCodexGate;
  delegation?: TCodexDelegation;
  retryAuthorization?: TCodexRetryAuthorization;
}

export interface CodexTurnScopePort<
  TCodexGate,
  TCodexDelegation,
  TCodexRetryAuthorization,
> {
  noteRuntimeUserMessageStarted(agentId: string, descriptor: AgentDescriptor | undefined): void;
  activateManagerTurn(
    agentId: string,
    activation: CodexTurnActivation<TCodexGate, TCodexDelegation, TCodexRetryAuthorization>,
  ): void;
  completeProviderCycle(agentId: string): void;
  completeAgentTurn(agentId: string): void;
  handleRuntimeError(agentId: string, descriptor: AgentDescriptor | undefined): void;
  clearForRuntimeReset(agentId: string): void;
}

export interface TurnDispatchLedgerInput {
  turnId: string;
  agentId: string;
  role: AgentDescriptor["role"];
  kind: TurnLedgerInboundKind;
  initiatedBy: string;
}

export interface TurnContextLedgerPort {
  mintTurnId(descriptor: AgentDescriptor): Promise<string>;
  recordTurnDispatched(input: TurnDispatchLedgerInput): Promise<void>;
}

export interface QueuedInboundTurnHandle {
  turnId: string;
  rollback(): void;
}

export interface TurnContextObservabilityPort {
  activateRoot(agentId: string, rootTurnId: string, parentRootTurnId?: string): void;
  clearRoot(agentId: string): void;
  getActiveRootTurnId(agentId: string): string | undefined;
  recordRuntimeSessionEvent(
    agentId: string,
    runtimeToken: number | undefined,
    event: RuntimeSessionEvent,
  ): void;
}

export interface TurnContextCoordinatorOptions<
  TCodexGate,
  TCodexDelegation,
  TCodexRetryAuthorization,
> {
  descriptors: Map<string, AgentDescriptor>;
  getRuntimeToken(agentId: string): number | undefined;
  ledger: TurnContextLedgerPort;
  output: ManagerOutputTurnPort;
  codex: CodexTurnScopePort<TCodexGate, TCodexDelegation, TCodexRetryAuthorization>;
  observability: TurnContextObservabilityPort;
  logDebug(message: string, details?: unknown): void;
}

interface ActiveTurnContext {
  turnId: string;
  runtimeToken?: number;
  parentContext?: ActiveWorkerParentContext;
}

export interface ActiveWorkerParentContext {
  outputTarget: AssistantOutputTarget;
  rootTurnId?: string;
  parentRootTurnId?: string;
}

/**
 * Owns the ordered inbound-turn queue and its runtime-event lifecycle.
 *
 * Surface routing, Codex authorization, and observability projection remain in
 * their respective owners. This coordinator only determines when those owners
 * activate or clear as a provider selects and completes queued runtime input.
 */
export class TurnContextCoordinator<
  TCodexGate = unknown,
  TCodexDelegation = unknown,
  TCodexRetryAuthorization = unknown,
> {
  private readonly pendingByAgentId = new Map<
    string,
    Array<QueuedInboundTurnContext<TCodexGate, TCodexDelegation, TCodexRetryAuthorization>>
  >();
  private readonly activatedByAgentId = new Set<string>();
  private readonly activeTurnByAgentId = new Map<string, ActiveTurnContext>();
  private readonly activeExternalTurnByAgentId = new Map<string, ActiveExternalProjectAgentTurn>();

  constructor(
    private readonly options: TurnContextCoordinatorOptions<
      TCodexGate,
      TCodexDelegation,
      TCodexRetryAuthorization
    >,
  ) {}

  getActiveTurnId(agentId: string, runtimeToken?: number): string | undefined {
    const activeTurn = this.activeTurnByAgentId.get(agentId);
    if (!activeTurn) {
      return undefined;
    }

    if (
      runtimeToken !== undefined &&
      activeTurn.runtimeToken !== undefined &&
      activeTurn.runtimeToken !== runtimeToken
    ) {
      return undefined;
    }

    return activeTurn.turnId;
  }

  getPendingContextCount(agentId: string): number {
    return this.pendingByAgentId.get(agentId)?.length ?? 0;
  }

  getActiveWorkerParentContext(agentId: string): ActiveWorkerParentContext | undefined {
    const parentContext = this.activeTurnByAgentId.get(agentId)?.parentContext;
    return parentContext
      ? {
          outputTarget: cloneAssistantOutputTarget(parentContext.outputTarget),
          ...(parentContext.rootTurnId ? { rootTurnId: parentContext.rootTurnId } : {}),
          ...(parentContext.parentRootTurnId
            ? { parentRootTurnId: parentContext.parentRootTurnId }
            : {}),
        }
      : undefined;
  }

  hasPendingSupersedingUserInput(agentId: string, activeTurnId?: string): boolean {
    if (!this.activatedByAgentId.has(agentId)) return false;
    return Boolean(this.pendingByAgentId.get(agentId)?.some(
      (context) => context.source === "user_input" && context.turnId !== activeTurnId,
    ));
  }

  markProviderCycleActivated(agentId: string): void {
    this.activatedByAgentId.add(agentId);
  }

  getActiveExternalProjectAgentTurn(agentId: string): ActiveExternalProjectAgentTurn | undefined {
    const active = this.activeExternalTurnByAgentId.get(agentId);
    return active ? { ...active } : undefined;
  }

  getActiveObservabilityRootTurnId(agentId: string): string | undefined {
    return this.options.observability.getActiveRootTurnId(agentId);
  }

  async enqueue(
    agentId: string,
    context: InboundTurnContextInput<TCodexGate, TCodexDelegation, TCodexRetryAuthorization>,
  ): Promise<QueuedInboundTurnHandle> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Cannot mint turn id for unknown agent: ${agentId}`);
    }

    const runtimeToken = this.options.getRuntimeToken(agentId);
    const queuedContext: QueuedInboundTurnContext<
      TCodexGate,
      TCodexDelegation,
      TCodexRetryAuthorization
    > = {
      ...context,
      activationEligible: context.activationEligible ?? true,
      turnId: await this.options.ledger.mintTurnId(descriptor),
      ...(runtimeToken !== undefined ? { runtimeToken } : {}),
    };

    if (!context.skipTurnLedger) {
      await this.options.ledger.recordTurnDispatched({
        turnId: queuedContext.turnId,
        agentId,
        role: descriptor.role,
        kind: classifyInboundKind(queuedContext.source),
        initiatedBy: queuedContext.collaborationAuthor?.userId ?? "local",
      }).catch((error) => {
        this.options.logDebug("turn_ledger:dispatch:error", {
          agentId,
          turnId: queuedContext.turnId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const queue = this.pendingByAgentId.get(agentId) ?? [];
    queue.push(queuedContext);
    this.pendingByAgentId.set(agentId, queue);
    if (!this.activeTurnByAgentId.has(agentId)) {
      this.setActiveTurnFromContext(agentId, queuedContext);
    }

    return {
      turnId: queuedContext.turnId,
      rollback: () => {
        const currentQueue = this.pendingByAgentId.get(agentId);
        if (currentQueue) {
          const index = currentQueue.lastIndexOf(queuedContext);
          if (index >= 0) {
            currentQueue.splice(index, 1);
          }
          if (currentQueue.length === 0) {
            this.pendingByAgentId.delete(agentId);
          }
        }

        if (this.activeTurnByAgentId.get(agentId)?.turnId === queuedContext.turnId) {
          const nextContext = currentQueue?.[0];
          if (nextContext) {
            this.setActiveTurnFromContext(agentId, nextContext);
          } else {
            this.activeTurnByAgentId.delete(agentId);
          }
        }
      },
    };
  }

  beforeRuntimeEventProjection(
    agentId: string,
    _runtimeToken: number | undefined,
    event: RuntimeSessionEvent,
  ): void {
    this.applyRuntimeEvent(agentId, event, "before_projection");
  }

  afterRuntimeEventProjection(
    agentId: string,
    runtimeToken: number | undefined,
    event: RuntimeSessionEvent,
  ): void {
    this.applyRuntimeEvent(agentId, event, "after_projection");
    this.options.observability.recordRuntimeSessionEvent(agentId, runtimeToken, event);
  }

  handleRuntimeError(agentId: string): void {
    const descriptor = this.options.descriptors.get(agentId);
    if (descriptor?.role === "manager") {
      this.pendingByAgentId.delete(agentId);
      this.activatedByAgentId.delete(agentId);
      this.activeTurnByAgentId.delete(agentId);
    }
    this.options.output.handleRuntimeError(agentId, descriptor);
    this.options.codex.handleRuntimeError(agentId, descriptor);
  }

  discard(agentId: string): void {
    this.pendingByAgentId.delete(agentId);
    this.activatedByAgentId.delete(agentId);
    this.activeTurnByAgentId.delete(agentId);
    this.options.output.clearForRuntimeReset(agentId);
    this.options.codex.clearForRuntimeReset(agentId);
  }

  clearAgentState(agentId: string): void {
    this.discard(agentId);
    this.activeExternalTurnByAgentId.delete(agentId);
    this.options.observability.clearRoot(agentId);
  }

  private applyRuntimeEvent(
    agentId: string,
    event: RuntimeSessionEvent,
    phase: "before_projection" | "after_projection",
  ): void {
    const descriptor = this.options.descriptors.get(agentId);

    if (
      phase === "before_projection" &&
      event.type === "message_start" &&
      extractRole(event.message) === "user"
    ) {
      this.options.codex.noteRuntimeUserMessageStarted(agentId, descriptor);
    }

    if (phase === "before_projection" && event.type === "turn_start") {
      return;
    }

    if (
      phase === "before_projection" &&
      (
        event.type === "message_start" ||
        (event.type === "message_end" && !this.activatedByAgentId.has(agentId))
      ) &&
      extractRole(event.message) === "user"
    ) {
      const nextContext = this.dequeueForRuntimeMessage(agentId, event.message);
      if (nextContext) {
        this.activatedByAgentId.add(agentId);
        this.activateDequeuedContext(agentId, descriptor, nextContext);
      } else if (!this.activatedByAgentId.has(agentId)) {
        this.activateContext(agentId, descriptor, undefined);
      }
      return;
    }

    if (phase === "after_projection" && event.type === "turn_end") {
      this.consumeActivePendingContext(agentId);
      // Project-agent reply restrictions are scoped to the provider turn. The
      // output route may stay alive until agent_end for providers that emit a
      // trailing final, but those capability restrictions must not leak into
      // the next turn.
      this.activeExternalTurnByAgentId.delete(agentId);
      this.options.output.completeProviderCycle(agentId, {
        pendingTargets: this.pendingOutputTargets(agentId),
      });
      this.options.codex.completeProviderCycle(agentId);
      if (descriptor?.role !== "manager") {
        this.activatedByAgentId.delete(agentId);
        this.activeTurnByAgentId.delete(agentId);
        this.options.observability.clearRoot(agentId);
      }
      return;
    }

    if (phase === "after_projection" && event.type === "agent_end") {
      this.consumeActivePendingContext(agentId);
      this.activatedByAgentId.delete(agentId);
      this.activeTurnByAgentId.delete(agentId);
      this.activeExternalTurnByAgentId.delete(agentId);
      this.options.observability.clearRoot(agentId);
      this.options.output.completeAgentTurn(agentId);
      this.options.codex.completeAgentTurn(agentId);
      return;
    }

    if (phase === "after_projection" && isCleanManagerAssistantFinalMessage(event)) {
      this.activatedByAgentId.delete(agentId);
      this.options.output.acceptCleanManagerFinal(agentId, {
        pendingTargets: this.pendingOutputTargets(agentId),
      });
    }
  }

  private activateDequeuedContext(
    agentId: string,
    descriptor: AgentDescriptor | undefined,
    context: QueuedInboundTurnContext<TCodexGate, TCodexDelegation, TCodexRetryAuthorization>,
  ): void {
    if (context.activationEligible) {
      this.activateContext(agentId, descriptor, context);
      return;
    }

    this.setActiveTurnFromContext(agentId, context);
    this.activateContext(agentId, descriptor, undefined, { preserveActiveTurn: true });
  }

  private activateContext(
    agentId: string,
    descriptor: AgentDescriptor | undefined,
    context: QueuedInboundTurnContext<TCodexGate, TCodexDelegation, TCodexRetryAuthorization> | undefined,
    options?: { preserveActiveTurn?: boolean },
  ): void {
    if (context) {
      this.setActiveTurnFromContext(agentId, context);
    } else if (!options?.preserveActiveTurn) {
      this.activeTurnByAgentId.delete(agentId);
    }

    if (context?.rootTurnId) {
      this.options.observability.activateRoot(
        agentId,
        context.rootTurnId,
        context.parentRootTurnId,
      );
    } else if (context) {
      this.options.observability.clearRoot(agentId);
    }

    const externalProjectAgentContext =
      context?.source === "project_agent_input" && context.projectAgentContext?.external
        ? {
            fromAgentId: context.projectAgentContext.fromAgentId,
            fromDisplayName: context.projectAgentContext.fromDisplayName,
            ...(context.projectAgentContext.fromProfileId
              ? { fromProfileId: context.projectAgentContext.fromProfileId }
              : {}),
            ...(context.projectAgentContext.fromProjectName
              ? { fromProjectName: context.projectAgentContext.fromProjectName }
              : {}),
          }
        : undefined;

    if (externalProjectAgentContext) {
      this.activeExternalTurnByAgentId.set(agentId, externalProjectAgentContext);
    } else {
      this.activeExternalTurnByAgentId.delete(agentId);
    }

    const manager = descriptor ?? this.options.descriptors.get(agentId);
    if (manager?.role !== "manager") {
      return;
    }

    const target = context?.assistantOutputProjectionTarget ?? context?.assistantOutputTarget;
    this.options.output.activateManagerTurn(agentId, {
      target,
      ...(target
        ? {
            routeContext: {
              origin: context?.routeOrigin ?? "internal",
              ...(context?.internalDeliveryKind
                ? { internalDeliveryKind: context.internalDeliveryKind }
                : {}),
              ...(context?.sourceWorkerId
                ? { sourceWorkerId: context.sourceWorkerId }
                : {}),
              requiresVisibleResponse:
                context?.requiresVisibleResponse ??
                (context?.source === "user_input" || context?.routeOrigin === "scheduled"),
              ...(context?.collaborationAuthor?.channelId ? { collaboration: true } : {}),
            },
          }
        : {}),
      turnId: context?.turnId,
      beginUserVisibleObligation: context?.source === "user_input",
    });

    this.options.codex.activateManagerTurn(agentId, {
      gate: context?.codexMcpToolGate,
      delegation: context?.codexPluginDelegationContext,
      retryAuthorization: context?.codexPluginRetryAuthorizationContext,
    });
  }

  private setActiveTurnFromContext(
    agentId: string,
    context: QueuedInboundTurnContext<TCodexGate, TCodexDelegation, TCodexRetryAuthorization>,
  ): void {
    const outputTarget = context.assistantOutputProjectionTarget ?? context.assistantOutputTarget;
    this.activeTurnByAgentId.set(agentId, {
      turnId: context.turnId,
      ...(context.runtimeToken !== undefined ? { runtimeToken: context.runtimeToken } : {}),
      ...(outputTarget
        ? {
            parentContext: {
              outputTarget: cloneAssistantOutputTarget(outputTarget),
              ...(context.rootTurnId ? { rootTurnId: context.rootTurnId } : {}),
              ...(context.parentRootTurnId
                ? { parentRootTurnId: context.parentRootTurnId }
                : {}),
            },
          }
        : {}),
    });
  }

  private dequeueForRuntimeMessage(
    agentId: string,
    message: RuntimeSessionMessage,
  ): QueuedInboundTurnContext<TCodexGate, TCodexDelegation, TCodexRetryAuthorization> | undefined {
    const queue = this.pendingByAgentId.get(agentId);
    if (!queue?.[0]) {
      return undefined;
    }

    const messageText = extractMessageText(message);
    const contextIndex = queue.findIndex((context) =>
      context.runtimeMessageText !== undefined &&
      Boolean(messageText && runtimeMessageTextMatches(context.runtimeMessageText, messageText)),
    );
    if (contextIndex < 0) {
      return undefined;
    }

    const [matchedContext] = queue.splice(contextIndex, 1);
    if (queue.length === 0) {
      this.pendingByAgentId.delete(agentId);
    }
    return matchedContext;
  }

  private dequeueNext(
    agentId: string,
  ): QueuedInboundTurnContext<TCodexGate, TCodexDelegation, TCodexRetryAuthorization> | undefined {
    const queue = this.pendingByAgentId.get(agentId);
    const nextContext = queue?.shift();
    if (!queue || !nextContext) {
      return undefined;
    }
    if (queue.length === 0) {
      this.pendingByAgentId.delete(agentId);
    }
    return nextContext;
  }

  private consumeActivePendingContext(agentId: string): void {
    if (this.activatedByAgentId.has(agentId)) {
      return;
    }
    const activeTurnId = this.activeTurnByAgentId.get(agentId)?.turnId;
    const firstPending = this.pendingByAgentId.get(agentId)?.[0];
    if (!activeTurnId) {
      this.dequeueNext(agentId);
      return;
    }
    if (activeTurnId && firstPending?.turnId === activeTurnId) {
      this.dequeueNext(agentId);
    }
  }

  private pendingOutputTargets(agentId: string): AssistantOutputTarget[] {
    return (this.pendingByAgentId.get(agentId) ?? []).flatMap((context) => {
      const target = context.assistantOutputProjectionTarget ?? context.assistantOutputTarget;
      return target ? [target] : [];
    });
  }
}

function classifyInboundKind(source: InboundTurnSource): TurnLedgerInboundKind {
  if (source === "user_input") return "user";
  if (source === "project_agent_input") return "project_agent";
  if (source === "worker_result") return "worker_report";
  return "agent_message";
}

function runtimeMessageTextMatches(expected: string, actual: string): boolean {
  return normalizeRuntimeMessageText(expected) === normalizeRuntimeMessageText(actual);
}

function normalizeRuntimeMessageText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}
