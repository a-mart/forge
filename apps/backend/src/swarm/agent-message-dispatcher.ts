import { randomUUID } from "node:crypto";
import { isRepoProjectAgentSource } from "@forge/protocol";
import type {
  ObservabilityRootSource,
  ObservabilityRuntimeInputHandle,
} from "../observability/observability-types.js";
import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import { isSessionAgentDescriptor } from "./agent-directory.js";
import type {
  AgentMessageOutputInput,
  AssistantOutputRouter,
} from "./assistant-output-router.js";
import {
  deliverProjectAgentMessage,
  formatProjectAgentRuntimeMessage,
  getProjectAgentPublicName,
} from "./agents/project-agents.js";
import { normalizeArchetypeId } from "./prompt-registry.js";
import type { ExternalProjectAgentDeliveryAuthorization } from "./project-agent-sharing-service.js";
import type { PlanStepAssignment } from "./planning/plan-usage-tracker.js";
import type {
  RuntimeImageAttachment,
  RuntimeUserMessage,
  SwarmAgentRuntime,
} from "./runtime-contracts.js";
import type { ObservabilityParentTool } from "./swarm-observability-coordinator.js";
import {
  extractRuntimeMessageText,
  errorToMessage,
  previewForLog,
} from "./swarm-manager-utils.js";
import type {
  InboundTurnContextInput,
  QueuedInboundTurnHandle,
} from "./turn-context-coordinator.js";
import type {
  AgentDescriptor,
  AgentMessageEvent,
  ConversationAttachment,
  ConversationMessageEvent,
  ManagerProfile,
  RequestedDeliveryMode,
  SendMessageReceipt,
} from "./types.js";

const CORTEX_ARCHETYPE_ID = "cortex";
const INTERNAL_MODEL_MESSAGE_PREFIX = "SYSTEM: ";
const WORKER_REPORT_MESSAGE_PREFIX = "WORKER REPORT: ";
const TERMINAL_WORKER_REPORT_BODY_PATTERN = /^status:\s*(?:done|partial|blocked|completed)\b/i;

export type AgentMessageOrigin = "user" | "internal";
export type AgentMessageInternalDeliveryKind =
  | "codex_plugin_bootstrap"
  | "bootstrap"
  | "agent_creator_bootstrap";

export interface AgentMessageSendOptions {
  origin?: AgentMessageOrigin;
  attachments?: ConversationAttachment[];
  internalDeliveryKind?: AgentMessageInternalDeliveryKind;
  observabilityParentTool?: ObservabilityParentTool;
  workerReportSourceAgentId?: string;
  skipTurnLedger?: boolean;
  planStep?: string;
  planAssignmentSource?: "spawn_agent" | "send_message_to_agent";
}

export interface AgentMessageAttachmentPort {
  normalize(attachments: ConversationAttachment[] | undefined): ConversationAttachment[];
  prepareRuntime(
    targetAgentId: string,
    attachments: ConversationAttachment[],
  ): Promise<{ images: RuntimeImageAttachment[]; attachmentMessage: string }>;
}

export interface AgentMessageTurnPort<TCodexGate> {
  enqueue(
    agentId: string,
    context: Omit<
      InboundTurnContextInput<TCodexGate>,
      "codexPluginDelegationContext" | "codexPluginRetryAuthorizationContext"
    >,
  ): Promise<QueuedInboundTurnHandle>;
  getActiveTurnId(agentId: string): string | undefined;
  getActiveExternalProjectAgentTurn(agentId: string): {
    fromAgentId: string;
    fromDisplayName: string;
  } | undefined;
}

export interface AgentMessageLedgerPort {
  hasSessionTarget(agentId: string): boolean;
  recordDeliveryPending(input: {
    sessionAgentId: string;
    turnId?: string;
    deliveryId: string;
    fromAgentId: string;
    targetAgentId: string;
    message: string;
    at: string;
  }): Promise<void>;
  recordDeliveryAcked(input: {
    sessionAgentId: string;
    deliveryId: string;
    at: string;
  }): Promise<void>;
}

export interface AgentMessageWorkerHealthPort {
  getWorkerReportDispatchTurnSeq(
    sender: AgentDescriptor,
    target: AgentDescriptor,
  ): number | undefined;
  markPendingWorkerReportDispatch(agentId: string, turnSeq: number | undefined): void;
  handleFailedWorkerReportDispatch(agentId: string, turnSeq: number | undefined): Promise<void>;
  handleSuccessfulWorkerReportDispatch(agentId: string, turnSeq: number | undefined): Promise<void>;
}

export interface AgentMessageObservabilityPort {
  getActiveRootTurnId(agentId: string): string | undefined;
  beginRuntimeInput(input: {
    target: AgentDescriptor;
    rootSource: ObservabilityRootSource;
    originalInput?: unknown;
    runtimeInput: unknown;
    parentRootTurnId?: string;
    requestedDelivery?: RequestedDeliveryMode;
    metadata?: Record<string, unknown>;
  }): ObservabilityRuntimeInputHandle | undefined;
  completeRuntimeInput(
    handle: ObservabilityRuntimeInputHandle | undefined,
    receipt: SendMessageReceipt,
    metadata?: Record<string, unknown>,
  ): void;
  cancelRuntimeInput(
    handle: ObservabilityRuntimeInputHandle | undefined,
    reason: string,
  ): void;
  resolveParentTool(input: ObservabilityParentTool | undefined): ObservabilityParentTool | undefined;
  recordAgentDelivery(input: {
    sender: AgentDescriptor;
    target: AgentDescriptor;
    rootTurnId?: string;
    parentRootTurnId?: string;
    message?: unknown;
    runtimeInput?: unknown;
    delivery: RequestedDeliveryMode;
    receipt: SendMessageReceipt;
    source: "agent_message" | "project_agent" | "internal";
    parentTool?: ObservabilityParentTool;
    metadata?: Record<string, unknown>;
  }): void;
}

export interface AgentMessagePlanPort {
  resolveAssignment(
    owner: AgentDescriptor & { role: "manager"; profileId: string },
    requestedStep: string,
  ): Promise<PlanStepAssignment>;
  appendToManagerInput(
    owner: AgentDescriptor & { role: "manager"; profileId: string },
    text: string,
  ): Promise<string>;
  recordWorkerAssignment(
    owner: AgentDescriptor & { role: "manager"; profileId: string },
    assignment: PlanStepAssignment,
    input: {
      workerId: string;
      source: "spawn_agent" | "send_message_to_agent";
      deliveryId?: string;
      acceptedMode?: SendMessageReceipt["acceptedMode"];
    },
  ): Promise<void>;
}

export interface AgentMessageGoalPort {
  appendToManagerInput(
    owner: AgentDescriptor & { role: "manager"; profileId: string },
    text: string,
  ): Promise<string>;
}

export interface AgentMessageProjectAgentPort {
  authorizeExternalDelivery(input: {
    senderAgentId: string;
    senderProfileId: string;
    targetAgentId: string;
  }): Promise<ExternalProjectAgentDeliveryAuthorization | null>;
  recordExternalContact(
    sourceAgentId: string,
    targetProfileId: string,
    targetSessionAgentId: string,
  ): Promise<void>;
  assertRepoSourceAvailable(
    descriptor: AgentDescriptor & {
      role: "manager";
      projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
    },
  ): Promise<void>;
  rateLimitBuckets: Map<string, number[]>;
}

export interface AgentMessageCodexPort<TCodexGate> {
  assertWorkerDeliveryAllowed(
    sender: AgentDescriptor,
    target: AgentDescriptor,
    options: Pick<
      AgentMessageSendOptions,
      "origin" | "attachments" | "internalDeliveryKind"
    > | undefined,
  ): void;
  buildProjectAgentTurnGate(
    target: AgentDescriptor & { role: "manager" },
    message: string,
  ): TCodexGate;
}

export interface AgentMessageDispatcherOptions<TCodexGate> {
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  assertMutable(descriptor: AgentDescriptor): void;
  attachments: AgentMessageAttachmentPort;
  turns: AgentMessageTurnPort<TCodexGate>;
  output: AssistantOutputRouter;
  ledger: AgentMessageLedgerPort;
  workerHealth: AgentMessageWorkerHealthPort;
  observability: AgentMessageObservabilityPort;
  plans: AgentMessagePlanPort;
  goals: AgentMessageGoalPort;
  projectAgents: AgentMessageProjectAgentPort;
  codex: AgentMessageCodexPort<TCodexGate>;
  getOrCreateRuntime(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime>;
  appendProjectAgentConversation(
    target: AgentDescriptor,
    payload: {
      text: string;
      runtimeText: string;
      timestamp: string;
      projectAgentContext: ConversationMessageEvent["projectAgentContext"];
    },
  ): Promise<void>;
  emitAgentMessage(event: AgentMessageEvent): void;
  now(): string;
  createDeliveryNonce?(): string;
  logDebug(message: string, details?: unknown): void;
}

interface ProjectAgentDeliveryAuthorization {
  allowCrossProfile: boolean;
  allowContactReplyTarget?: boolean;
  externalAuthorization?: ExternalProjectAgentDeliveryAuthorization;
}

interface ResolvedPlanAssignment {
  descriptor: AgentDescriptor & { role: "manager"; profileId: string };
  assignment: PlanStepAssignment;
}

/**
 * Owns the accepted agent-message transaction from descriptor validation to
 * post-dispatch projection. Routing, turn selection, health, ledger, and
 * observability policy stay in their focused owners and are invoked here in a
 * single explicit order.
 */
export class AgentMessageDispatcher<TCodexGate = unknown> {
  constructor(private readonly options: AgentMessageDispatcherOptions<TCodexGate>) {}

  async sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery: RequestedDeliveryMode = "auto",
    sendOptions?: AgentMessageSendOptions,
  ): Promise<SendMessageReceipt> {
    const sender = this.requireSender(fromAgentId);
    const target = this.requireTarget(targetAgentId);

    if (sender.role === "manager" && target.role === "worker" && target.managerId !== sender.agentId) {
      throw new Error(`Manager ${sender.agentId} does not own worker ${targetAgentId}`);
    }

    if (sendOptions?.planStep && (sender.role !== "manager" || target.role !== "worker")) {
      throw new Error("planStep can only accompany a manager assignment to one of its workers.");
    }

    const planAssignment = sendOptions?.planStep
      ? await this.resolvePlanAssignment(sender, sendOptions.planStep)
      : undefined;

    if (sender.role === "worker" && target.role === "manager" && sender.managerId !== target.agentId) {
      throw new Error(
        `Worker ${sender.agentId} cannot message manager ${targetAgentId} (own manager is ${sender.managerId})`,
      );
    }

    this.options.codex.assertWorkerDeliveryAllowed(sender, target, sendOptions);

    const origin = sendOptions?.origin ?? "internal";
    const attachments = this.options.attachments.normalize(sendOptions?.attachments);
    const activeExternalTurn = this.options.turns.getActiveExternalProjectAgentTurn(fromAgentId);
    if (activeExternalTurn && targetAgentId !== activeExternalTurn.fromAgentId) {
      throw new Error(
        `External project-agent messages are restricted to a direct reply back to ${activeExternalTurn.fromDisplayName} (${activeExternalTurn.fromAgentId}).`,
      );
    }

    const projectAuthorization = await this.resolveProjectAgentAuthorization(sender, target);
    if (projectAuthorization) {
      return this.sendProjectAgentMessage({
        sender,
        target,
        message,
        delivery,
        origin,
        attachments,
        authorization: projectAuthorization,
        sendOptions,
      });
    }

    return this.sendRuntimeMessage({
      sender,
      target,
      message,
      delivery,
      origin,
      attachments,
      planAssignment,
      sendOptions,
    });
  }

  private async sendProjectAgentMessage(input: {
    sender: AgentDescriptor;
    target: AgentDescriptor;
    message: string;
    delivery: RequestedDeliveryMode;
    origin: AgentMessageOrigin;
    attachments: ConversationAttachment[];
    authorization: ProjectAgentDeliveryAuthorization;
    sendOptions?: AgentMessageSendOptions;
  }): Promise<SendMessageReceipt> {
    if (input.attachments.length > 0) {
      throw new Error("Project-agent deliveries do not support attachments.");
    }

    const sender = input.sender as AgentDescriptor & { role: "manager" };
    const target = input.target as AgentDescriptor & { role: "manager" };
    const senderProfileId = sender.profileId ?? sender.agentId;
    const sourceProjectName = this.options.profiles.get(senderProfileId)?.displayName ?? senderProfileId;
    const projectAgentContext = {
      fromAgentId: sender.agentId,
      fromDisplayName: getProjectAgentPublicName(sender),
      external: input.authorization.allowCrossProfile,
      fromProfileId: senderProfileId,
      fromProjectName: sourceProjectName,
    };
    const outputTarget = { kind: "peer_agent", fromAgentId: sender.agentId } as const;
    const baseRuntimeText = this.options.output.annotateText(
      formatProjectAgentRuntimeMessage(projectAgentContext, input.message),
      outputTarget,
    );
    const runtimeText = await this.appendCoordinationContext(target, baseRuntimeText);
    const parentRootTurnId = this.options.observability.getActiveRootTurnId(sender.agentId);
    const observabilityInput = this.options.observability.beginRuntimeInput({
      target,
      rootSource: "project_agent",
      originalInput: input.message,
      runtimeInput: runtimeText,
      parentRootTurnId,
      requestedDelivery: input.delivery,
      metadata: {
        fromAgentId: sender.agentId,
        targetAgentId: target.agentId,
        projectAgentExternal: input.authorization.allowCrossProfile,
      },
    });
    const { rollback } = await this.options.turns.enqueue(target.agentId, {
      source: "project_agent_input",
      routeOrigin: "internal",
      rootTurnId: observabilityInput?.rootTurnId,
      parentRootTurnId,
      runtimeMessageText: runtimeText,
      codexMcpToolGate: this.options.codex.buildProjectAgentTurnGate(target, input.message),
      projectAgentContext,
      assistantOutputTarget: outputTarget,
    });

    let result;
    try {
      result = await deliverProjectAgentMessage(
        {
          now: this.options.now,
          getOrCreateRuntimeForDescriptor: (descriptor) => this.options.getOrCreateRuntime(descriptor),
          rateLimitBuckets: this.options.projectAgents.rateLimitBuckets,
        },
        {
          sender,
          target,
          message: input.message,
          delivery: input.delivery,
          allowCrossProfile: input.authorization.allowCrossProfile,
          allowContactReplyTarget: input.authorization.allowContactReplyTarget,
          external: input.authorization.allowCrossProfile,
          sourceProfileId: senderProfileId,
          sourceProjectName,
          runtimeMessageText: runtimeText,
        },
      );
    } catch (error) {
      rollback();
      this.options.observability.cancelRuntimeInput(observabilityInput, "project_agent_dispatch_failed");
      throw error;
    }

    const { receipt, inboundPayload } = result;
    this.options.observability.completeRuntimeInput(observabilityInput, receipt, {
      fromAgentId: sender.agentId,
      targetAgentId: target.agentId,
      projectAgentExternal: input.authorization.allowCrossProfile,
    });
    this.options.observability.recordAgentDelivery({
      sender,
      target,
      rootTurnId: observabilityInput?.rootTurnId,
      parentRootTurnId,
      message: input.message,
      runtimeInput: runtimeText,
      delivery: input.delivery,
      receipt,
      source: "project_agent",
      parentTool: this.options.observability.resolveParentTool(input.sendOptions?.observabilityParentTool),
      metadata: {
        projectAgentExternal: input.authorization.allowCrossProfile,
        fromProfileId: senderProfileId,
        targetProfileId: target.profileId,
      },
    });
    await this.options.appendProjectAgentConversation(target, inboundPayload);

    if (input.authorization.externalAuthorization?.mode === "grant") {
      await this.options.projectAgents.recordExternalContact(
        target.agentId,
        senderProfileId,
        sender.agentId,
      );
    }

    this.logAcceptedDispatch(input, receipt, inboundPayload.runtimeText);
    this.emitAgentToAgentMessage(input, receipt, [sender.agentId], true);
    return receipt;
  }

  private async sendRuntimeMessage(input: {
    sender: AgentDescriptor;
    target: AgentDescriptor;
    message: string;
    delivery: RequestedDeliveryMode;
    origin: AgentMessageOrigin;
    attachments: ConversationAttachment[];
    planAssignment?: ResolvedPlanAssignment;
    sendOptions?: AgentMessageSendOptions;
  }): Promise<SendMessageReceipt> {
    const managerContextIds = resolveActivityManagerContextIds(input.sender, input.target);
    const runtime = await this.options.getOrCreateRuntime(input.target);
    const watchdogTurnSeq = this.options.workerHealth.getWorkerReportDispatchTurnSeq(
      input.sender,
      input.target,
    );
    let modelMessage = await this.prepareModelInboundMessage(
      input.target.agentId,
      { text: input.message, attachments: input.attachments },
      input.origin,
    );
    const outputInput: AgentMessageOutputInput = {
      sender: input.sender,
      target: input.target,
      modelMessage,
      rawMessage: input.message,
      workerReportSourceAgentId: input.sendOptions?.workerReportSourceAgentId,
      sendMessageToolContinuation:
        input.sendOptions?.observabilityParentTool?.toolName === "send_message_to_agent",
    };
    const output = this.options.output.prepareAgentMessage(outputInput);
    modelMessage = output.modelMessage;

    this.options.workerHealth.markPendingWorkerReportDispatch(input.sender.agentId, watchdogTurnSeq);

    const rootSource = classifyObservabilityRootSource({
      origin: input.origin,
      fromAgentId: input.sender.agentId,
      targetAgentId: input.target.agentId,
      internalDeliveryKind: input.sendOptions?.internalDeliveryKind,
    });
    const parentRootTurnId = this.options.observability.getActiveRootTurnId(input.sender.agentId);
    const observabilityInput = this.options.observability.beginRuntimeInput({
      target: input.target,
      rootSource,
      originalInput: input.message,
      runtimeInput: modelMessage,
      parentRootTurnId,
      requestedDelivery: input.delivery,
      metadata: {
        fromAgentId: input.sender.agentId,
        targetAgentId: input.target.agentId,
        attachmentCount: input.attachments.length,
      },
    });
    const activationEligible =
      input.target.role === "manager" &&
      (
        Boolean(observabilityInput) ||
        output.projectionTarget.kind !== "internal_only" ||
        output.inputTarget.kind !== "internal_only" ||
        output.eligibleWorkerReport
      );
    const { rollback } = await this.options.turns.enqueue(input.target.agentId, {
      source: "agent_message",
      routeOrigin: output.eligibleWorkerReport ? "terminal_worker_report" : input.origin,
      internalDeliveryKind: input.sendOptions?.internalDeliveryKind,
      workerReportSourceAgentId: output.workerReportSourceAgentId,
      normalBuilderWorkerCallback: output.normalBuilderWorkerCallback,
      requiresVisibleResponse: output.requiresVisibleResponse,
      rootTurnId: observabilityInput?.rootTurnId,
      parentRootTurnId,
      runtimeMessageText: extractRuntimeMessageText(modelMessage),
      assistantOutputTarget: output.inputTarget,
      assistantOutputProjectionTarget: output.projectionTarget,
      activationEligible,
      skipTurnLedger: input.sendOptions?.skipTurnLedger,
    });

    const managerTurnId = this.options.turns.getActiveTurnId(input.target.agentId);
    const deliveryId = [
      "worker-report",
      input.sender.agentId,
      watchdogTurnSeq ?? "unknown",
      managerTurnId ?? "unknown",
      this.createDeliveryNonce(),
    ].join(":");
    const hasDeliveryLedger =
      input.sendOptions?.skipTurnLedger !== true &&
      this.options.ledger.hasSessionTarget(input.target.agentId);
    if (hasDeliveryLedger) {
      await this.options.ledger.recordDeliveryPending({
        sessionAgentId: input.target.agentId,
        ...(managerTurnId ? { turnId: managerTurnId } : {}),
        deliveryId,
        fromAgentId: input.sender.agentId,
        targetAgentId: input.target.agentId,
        message: input.message,
        at: this.options.now(),
      }).catch((error) => {
        this.options.logDebug("turn_ledger:delivery_pending:error", {
          deliveryId,
          fromAgentId: input.sender.agentId,
          toAgentId: input.target.agentId,
          message: errorToMessage(error),
        });
      });
    }

    let receipt: SendMessageReceipt;
    try {
      receipt = await runtime.sendMessage(modelMessage, input.delivery);
    } catch (error) {
      rollback();
      this.options.observability.cancelRuntimeInput(observabilityInput, "runtime_send_message_failed");
      await this.options.workerHealth.handleFailedWorkerReportDispatch(
        input.sender.agentId,
        watchdogTurnSeq,
      );
      throw error;
    }

    await this.options.workerHealth.handleSuccessfulWorkerReportDispatch(
      input.sender.agentId,
      watchdogTurnSeq,
    );
    this.options.output.recordSuccessfulAgentMessageDispatch(outputInput);

    if (hasDeliveryLedger) {
      await this.options.ledger.recordDeliveryAcked({
        sessionAgentId: input.target.agentId,
        deliveryId,
        at: this.options.now(),
      }).catch((error) => {
        this.options.logDebug("turn_ledger:delivery_acked:error", {
          deliveryId,
          message: errorToMessage(error),
        });
      });
    }

    this.options.observability.completeRuntimeInput(observabilityInput, receipt, {
      fromAgentId: input.sender.agentId,
      targetAgentId: input.target.agentId,
      attachmentCount: input.attachments.length,
    });
    this.options.observability.recordAgentDelivery({
      sender: input.sender,
      target: input.target,
      rootTurnId: observabilityInput?.rootTurnId,
      parentRootTurnId,
      message: input.message,
      runtimeInput: modelMessage,
      delivery: input.delivery,
      receipt,
      source: input.origin === "internal" ? "internal" : "agent_message",
      parentTool: this.options.observability.resolveParentTool(input.sendOptions?.observabilityParentTool),
      metadata: {
        attachmentCount: input.attachments.length,
        rootSource,
      },
    });

    if (input.planAssignment) {
      await this.options.plans.recordWorkerAssignment(
        input.planAssignment.descriptor,
        input.planAssignment.assignment,
        {
          workerId: input.target.agentId,
          source: input.sendOptions?.planAssignmentSource ?? "send_message_to_agent",
          deliveryId: receipt.deliveryId,
          acceptedMode: receipt.acceptedMode,
        },
      );
    }

    this.logAcceptedDispatch(input, receipt, extractRuntimeMessageText(modelMessage));
    const projectAgentExchange =
      input.sender.role === "manager" &&
      input.target.role === "manager" &&
      (input.sender.projectAgent !== undefined || input.target.projectAgent !== undefined);
    this.emitAgentToAgentMessage(input, receipt, managerContextIds, projectAgentExchange);
    return receipt;
  }

  private requireSender(agentId: string): AgentDescriptor {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown or unavailable sender agent: ${agentId}`);
    }
    this.options.assertMutable(descriptor);
    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Unknown or unavailable sender agent: ${agentId}`);
    }
    return descriptor;
  }

  private requireTarget(agentId: string): AgentDescriptor {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown target agent: ${agentId}`);
    }
    this.options.assertMutable(descriptor);
    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Target agent is not running: ${agentId}`);
    }
    return descriptor;
  }

  private async resolvePlanAssignment(
    sender: AgentDescriptor,
    requestedStep: string,
  ): Promise<ResolvedPlanAssignment> {
    if (!isSessionAgentDescriptor(sender)) {
      throw new Error("planStep is only available to manager sessions with a current working plan.");
    }
    if (sender.sessionSurface === "collab") {
      throw new Error("planStep is not available for Collaboration sessions.");
    }
    return {
      descriptor: sender,
      assignment: await this.options.plans.resolveAssignment(sender, requestedStep),
    };
  }

  private async resolveProjectAgentAuthorization(
    sender: AgentDescriptor,
    target: AgentDescriptor,
  ): Promise<ProjectAgentDeliveryAuthorization | null> {
    if (sender.role !== "manager" || target.role !== "manager" || sender.agentId === target.agentId) {
      return null;
    }

    const senderProfileId = sender.profileId ?? sender.agentId;
    const targetProfileId = target.profileId ?? target.agentId;
    const localDelivery =
      senderProfileId === targetProfileId &&
      (target.projectAgent !== undefined || target.creatorAgentId === sender.agentId);
    if (localDelivery) {
      return { allowCrossProfile: false };
    }
    if (senderProfileId === targetProfileId) {
      return null;
    }

    const externalAuthorization = await this.options.projectAgents.authorizeExternalDelivery({
      senderAgentId: sender.agentId,
      senderProfileId,
      targetAgentId: target.agentId,
    });
    if (!externalAuthorization) {
      return null;
    }
    if (!target.projectAgent && externalAuthorization.mode !== "contact_reply") {
      return null;
    }

    const sharedSource = this.options.descriptors.get(externalAuthorization.sourceAgentId);
    if (
      sharedSource?.role === "manager" &&
      sharedSource.projectAgent &&
      isRepoProjectAgentSource(sharedSource.projectAgent.source)
    ) {
      await this.options.projectAgents.assertRepoSourceAvailable(
        sharedSource as AgentDescriptor & {
          role: "manager";
          projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
        },
      );
    }

    return {
      allowCrossProfile: true,
      allowContactReplyTarget: externalAuthorization.mode === "contact_reply",
      externalAuthorization,
    };
  }

  async prepareModelInboundMessage(
    targetAgentId: string,
    input: { text: string; attachments: ConversationAttachment[] },
    origin: AgentMessageOrigin,
  ): Promise<string | RuntimeUserMessage> {
    let text = input.text;
    if (origin !== "user") {
      const trimmedStart = text.trimStart();
      if (text.trim().length > 0 && !/^(?:system|worker report):/i.test(trimmedStart)) {
        text = TERMINAL_WORKER_REPORT_BODY_PATTERN.test(trimmedStart)
          ? `${WORKER_REPORT_MESSAGE_PREFIX}${text}`
          : `${INTERNAL_MODEL_MESSAGE_PREFIX}${text}`;
      }
    }

    const runtimeAttachments = await this.options.attachments.prepareRuntime(
      targetAgentId,
      input.attachments,
    );
    if (runtimeAttachments.attachmentMessage.length > 0) {
      text = text.trim().length > 0
        ? `${text}\n\n${runtimeAttachments.attachmentMessage}`
        : runtimeAttachments.attachmentMessage;
    }
    const target = this.options.descriptors.get(targetAgentId);
    if (target) {
      text = await this.appendCoordinationContext(target, text);
    }

    return runtimeAttachments.images.length === 0
      ? text
      : { text, images: runtimeAttachments.images };
  }

  private async appendCoordinationContext(target: AgentDescriptor, text: string): Promise<string> {
    if (
      !isSessionAgentDescriptor(target) ||
      target.sessionSurface === "collab" ||
      normalizeArchetypeId(target.archetypeId ?? "") === CORTEX_ARCHETYPE_ID
    ) {
      return text;
    }
    const withGoal = await this.options.goals.appendToManagerInput(target, text);
    return this.options.plans.appendToManagerInput(target, withGoal);
  }

  private logAcceptedDispatch(
    input: {
      sender: AgentDescriptor;
      target: AgentDescriptor;
      message: string;
      delivery: RequestedDeliveryMode;
      origin: AgentMessageOrigin;
      attachments: ConversationAttachment[];
    },
    receipt: SendMessageReceipt,
    runtimeText: string,
  ): void {
    this.options.logDebug("agent:send_message", {
      fromAgentId: input.sender.agentId,
      targetAgentId: input.target.agentId,
      origin: input.origin,
      requestedDelivery: input.delivery,
      acceptedMode: receipt.acceptedMode,
      textPreview: previewForLog(input.message),
      attachmentCount: input.attachments.length,
      modelTextPreview: previewForLog(runtimeText),
    });
  }

  private emitAgentToAgentMessage(
    input: {
      sender: AgentDescriptor;
      target: AgentDescriptor;
      message: string;
      delivery: RequestedDeliveryMode;
      origin: AgentMessageOrigin;
      attachments: ConversationAttachment[];
    },
    receipt: SendMessageReceipt,
    managerContextIds: readonly string[],
    projectAgentExchange: boolean,
  ): void {
    if (input.origin === "user" || input.sender.agentId === input.target.agentId) {
      return;
    }

    for (const managerContextId of managerContextIds) {
      this.options.emitAgentMessage({
        type: "agent_message",
        agentId: managerContextId,
        timestamp: this.options.now(),
        source: "agent_to_agent",
        fromAgentId: input.sender.agentId,
        toAgentId: input.target.agentId,
        text: input.message,
        requestedDelivery: input.delivery,
        acceptedMode: receipt.acceptedMode,
        attachmentCount: input.attachments.length > 0 ? input.attachments.length : undefined,
        ...(projectAgentExchange ? { projectAgentExchange: true } : {}),
      });
    }
  }

  private createDeliveryNonce(): string {
    return this.options.createDeliveryNonce?.() ?? randomUUID();
  }
}

function resolveActivityManagerContextIds(...agents: AgentDescriptor[]): string[] {
  const ids = new Set<string>();
  for (const descriptor of agents) {
    if (descriptor.role === "manager") {
      ids.add(descriptor.agentId);
    } else if (descriptor.managerId.trim().length > 0) {
      ids.add(descriptor.managerId.trim());
    }
  }
  return Array.from(ids);
}

function classifyObservabilityRootSource(input: {
  origin: AgentMessageOrigin;
  fromAgentId: string;
  targetAgentId: string;
  internalDeliveryKind?: AgentMessageInternalDeliveryKind;
}): ObservabilityRootSource {
  if (input.origin === "user") return "user_input";
  if (input.internalDeliveryKind === "codex_plugin_bootstrap") return "codex_plugin_bootstrap";
  if (input.internalDeliveryKind === "bootstrap") return "bootstrap";
  if (input.internalDeliveryKind === "agent_creator_bootstrap") return "agent_creator_bootstrap";
  return input.fromAgentId === input.targetAgentId
    ? "internal_self_send"
    : "internal_agent_message";
}
