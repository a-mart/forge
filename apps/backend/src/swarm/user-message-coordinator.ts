import type {
  CollaborationAuthor,
  ConversationReplyTarget,
  ConversationReplyTargetInput,
} from "@forge/protocol";
import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import type { AgentMessageDispatcher } from "./agent-message-dispatcher.js";
import type { AssistantOutputRouter } from "./assistant-output-router.js";
import type { CodexDirectSidecarCoordinator } from "./codex-app-server/codex-direct-sidecar-coordinator.js";
import type {
  CodexPluginDelegationCoordinator,
  CodexPluginDelegationTurnContext,
  CodexPluginRetryAuthorizationContext,
} from "./codex-app-server/codex-plugin-delegation-coordinator.js";
import type { CodexUserMessageRoute } from "./codex-app-server/codex-mention-router.js";
import type { CodexMcpToolGateEvaluation } from "./codex-app-server/codex-mcp-tool-gate.js";
import type { ConversationAttachmentService } from "./conversation-attachment-service.js";
import { resolveConversationReplyTarget } from "./conversation-reply.js";
import { isExternalThreadDescriptor } from "./external-thread-compatibility.js";
import type { KnowledgeMemoryCoordinator } from "./knowledge-memory-coordinator.js";
import type { ProjectAgentCoordinator } from "./project-agent-coordinator.js";
import type { ProjectExecutableTrustCoordinator } from "./project-executable-trust-coordinator.js";
import type { RuntimeUserMessage, SwarmAgentRuntime } from "./runtime-contracts.js";
import type { RuntimeRecoveryState } from "./runtime/runtime-recovery-state.js";
import type { SwarmEventCoordinator } from "./swarm-event-coordinator.js";
import type { SwarmObservabilityCoordinator } from "./swarm-observability-coordinator.js";
import {
  extractRuntimeMessageText,
  formatInboundUserMessageForManager,
  normalizeMessageSourceContext,
  parseCompactSlashCommand,
  previewForLog,
} from "./swarm-manager-utils.js";
import type { TurnContextCoordinator } from "./turn-context-coordinator.js";
import type {
  AgentDescriptor,
  AgentMessageEvent,
  ConversationAttachment,
  ConversationEntryEvent,
  ConversationMessageEvent,
  MessageSourceContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
} from "./types.js";

type ManagerDescriptor = AgentDescriptor & { role: "manager"; profileId: string };
type CodexClassification = CodexUserMessageRoute;

export interface AppendConversationUserMessageOptions {
  targetAgentId?: string;
  attachments?: ConversationAttachment[];
  sourceContext?: MessageSourceContext;
  collaborationAuthor?: CollaborationAuthor;
  replyTo?: ConversationReplyTarget;
}

export interface AppendConversationUserMessageResult {
  target: AgentDescriptor;
  text: string;
  sourceContext: MessageSourceContext;
  receivedAt: string;
  event: ConversationMessageEvent;
  persistedAttachments: ConversationAttachment[];
  runtimeAttachments: ConversationAttachment[];
}

export interface DispatchRuntimeUserMessageOptions {
  targetAgentId: string;
  text: string;
  sourceContext: MessageSourceContext;
  collaborationAuthor?: CollaborationAuthor;
  runtimeAttachments?: ConversationAttachment[];
  persistedAttachmentCount?: number;
  delivery?: RequestedDeliveryMode;
}

export interface HandleUserMessageOptions {
  targetAgentId?: string;
  delivery?: RequestedDeliveryMode;
  attachments?: ConversationAttachment[];
  sourceContext?: MessageSourceContext;
  replyTo?: ConversationReplyTargetInput;
  collaborationAuthor?: CollaborationAuthor;
  clientRequestId?: string;
}

export interface PreparedInboundConversationPayload {
  text: string;
  runtimeText?: string;
  timestamp?: string;
  source: "user_input" | "project_agent_input";
  sourceContext?: MessageSourceContext;
  collaborationAuthor?: CollaborationAuthor;
  clientRequestId?: string;
  projectAgentContext?: ConversationMessageEvent["projectAgentContext"];
  attachments?: ConversationAttachment[];
  replyTo?: ConversationReplyTarget;
}

export interface AppendPreparedInboundConversationPayloadResult {
  event: ConversationMessageEvent;
  persistedAttachments: ConversationAttachment[];
  runtimeAttachments: ConversationAttachment[];
}

export interface InboundConversationAppenderOptions {
  attachments: Pick<ConversationAttachmentService, "prepareConversation">;
  events: Pick<
    SwarmEventCoordinator,
    "emitConversationMessage" | "markSessionActivity" | "markSessionUserMessageActivity"
  >;
  now(): string;
}

/**
 * Persists attachment payloads and commits the canonical inbound conversation event.
 * Runtime dispatch deliberately remains outside this class so a failed provider send
 * never rolls back user-visible history that has already been accepted.
 */
export class InboundConversationAppender {
  constructor(private readonly options: InboundConversationAppenderOptions) {}

  async append(
    target: AgentDescriptor,
    payload: PreparedInboundConversationPayload,
  ): Promise<AppendPreparedInboundConversationPayloadResult> {
    const { attachmentMetadata, persistedAttachments, runtimeAttachments } =
      await this.options.attachments.prepareConversation(
        payload.source === "user_input" ? payload.attachments : undefined,
      );
    const timestamp = payload.timestamp ?? this.options.now();
    const event: ConversationMessageEvent = {
      type: "conversation_message",
      agentId: target.agentId,
      role: "user",
      text: payload.text,
      attachments: attachmentMetadata.length > 0 ? attachmentMetadata : undefined,
      timestamp,
      source: payload.source,
      sourceContext: payload.source === "user_input" ? payload.sourceContext : undefined,
      collaborationAuthor:
        payload.source === "user_input" ? payload.collaborationAuthor : undefined,
      clientRequestId: payload.source === "user_input" ? payload.clientRequestId : undefined,
      projectAgentContext:
        payload.source === "project_agent_input" ? payload.projectAgentContext : undefined,
      replyTo: payload.source === "user_input" ? payload.replyTo : undefined,
    };

    this.options.events.emitConversationMessage(event);
    this.options.events.markSessionActivity(target.agentId, timestamp);
    if (payload.source === "user_input") {
      this.options.events.markSessionUserMessageActivity(target.agentId, timestamp);
    }

    return { event, persistedAttachments, runtimeAttachments };
  }

  async appendProjectAgentConversation(
    target: AgentDescriptor,
    payload: {
      text: string;
      runtimeText: string;
      timestamp: string;
      projectAgentContext: ConversationMessageEvent["projectAgentContext"];
    },
  ): Promise<void> {
    await this.append(target, { ...payload, source: "project_agent_input" });
  }
}

export interface UserMessageTargetingPort {
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  resolvePreferredManagerId(): string | undefined;
  assertDescriptorNotEffectivelyArchived(descriptor: AgentDescriptor): void;
  getConversationHistory(agentId: string): ConversationEntryEvent[];
}

export interface UserMessageRuntimePort {
  recovery: Pick<RuntimeRecoveryState, "hasPendingManagerRuntimeRecycle">;
  executableTrust: Pick<
    ProjectExecutableTrustCoordinator,
    "applyManagerRuntimeRecyclePolicy" | "schedulePrompt"
  >;
  getOrCreateRuntime(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime>;
  persistRecycledRuntimeState(): Promise<void>;
}

export interface UserMessageCoordinatorOptions {
  targeting: UserMessageTargetingPort;
  runtime: UserMessageRuntimePort;
  attachments: Pick<ConversationAttachmentService, "normalize">;
  inboundConversation: InboundConversationAppender;
  agentMessages: Pick<
    AgentMessageDispatcher<CodexMcpToolGateEvaluation>,
    "sendMessage" | "prepareModelInboundMessage"
  >;
  assistantOutput: Pick<AssistantOutputRouter, "resolveTargetForUserInput">;
  codex: {
    direct: Pick<CodexDirectSidecarCoordinator, "maybeRouteUserMessage">;
    plugin: Pick<
      CodexPluginDelegationCoordinator,
      | "appendManagerTurnGuidance"
      | "assertWorkerNotUserTargetable"
      | "buildTurnGate"
      | "classifyAndPreflightUserTurn"
      | "prepareUserTurn"
      | "recordDispatchAccepted"
    >;
  };
  knowledge: Pick<
    KnowledgeMemoryCoordinator,
    "compact" | "maybeRunCortexConsolidationFromIncomingMessage"
  >;
  projectAgents: Pick<ProjectAgentCoordinator, "preflightRuntime">;
  turns: Pick<
    TurnContextCoordinator<
      CodexMcpToolGateEvaluation,
      CodexPluginDelegationTurnContext,
      CodexPluginRetryAuthorizationContext
    >,
    "enqueue"
  >;
  observability: Pick<
    SwarmObservabilityCoordinator,
    "beginRuntimeInput" | "completeRuntimeInput" | "cancelRuntimeInput"
  >;
  events: Pick<SwarmEventCoordinator, "emitAgentMessage" | "markSessionActivity">;
  now(): string;
  logDebug(message: string, details?: unknown): void;
}

interface RuntimeDispatchInput {
  target: AgentDescriptor;
  text: string;
  sourceContext: MessageSourceContext;
  runtimeAttachments: ConversationAttachment[];
  persistedAttachmentCount: number;
  visibleMessageId?: string;
  delivery?: RequestedDeliveryMode;
  collaborationAuthor?: CollaborationAuthor;
  codexClassification?: CodexClassification;
  codexPluginDelegationContext?: CodexPluginDelegationTurnContext;
  codexPluginRetryAuthorizationContext?: CodexPluginRetryAuthorizationContext;
  replyTo?: ConversationReplyTarget;
}

/**
 * Owns the complete inbound user-message application transaction: target and reply
 * resolution, route short-circuits, canonical append, and worker/manager dispatch.
 * Each delegated service keeps its own policy and state; this coordinator owns only
 * their ordering and rollback boundary.
 */
export class UserMessageCoordinator {
  constructor(private readonly options: UserMessageCoordinatorOptions) {}

  async appendConversationUserMessage(
    text: string,
    options?: AppendConversationUserMessageOptions,
  ): Promise<AppendConversationUserMessageResult> {
    const trimmed = text.trim();
    const attachments = this.options.attachments.normalize(options?.attachments);
    if (!trimmed && attachments.length === 0) {
      throw new Error("Cannot append an empty user message.");
    }

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const target = this.resolveTarget(options?.targetAgentId);
    return this.appendUserMessage(
      target,
      trimmed,
      attachments,
      sourceContext,
      options?.collaborationAuthor,
      options?.replyTo,
    );
  }

  async dispatchRuntimeUserMessage(options: DispatchRuntimeUserMessageOptions): Promise<void> {
    const target = this.resolveTarget(options.targetAgentId);
    const sourceContext = normalizeMessageSourceContext(options.sourceContext);
    const runtimeAttachments = this.options.attachments.normalize(options.runtimeAttachments);
    await this.dispatchRuntime({
      target,
      text: options.text.trim(),
      sourceContext,
      runtimeAttachments,
      persistedAttachmentCount: Math.max(
        0,
        Math.trunc(options.persistedAttachmentCount ?? runtimeAttachments.length),
      ),
      delivery: options.delivery,
      collaborationAuthor: options.collaborationAuthor,
    });
  }

  async handleUserMessage(text: string, options?: HandleUserMessageOptions): Promise<void> {
    const trimmed = text.trim();
    const attachments = this.options.attachments.normalize(options?.attachments);
    if (!trimmed && attachments.length === 0) return;

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const target = this.resolveTarget(options?.targetAgentId);
    this.options.codex.plugin.assertWorkerNotUserTargetable(target);
    const resolvedReplyTo = options?.replyTo
      ? resolveConversationReplyTarget(
          this.options.targeting.getConversationHistory(target.agentId),
          options.replyTo,
        )
      : undefined;

    if (await this.options.codex.direct.maybeRouteUserMessage({
      target,
      text: trimmed,
      attachments,
      sourceContext,
    })) {
      return;
    }

    await this.options.projectAgents.preflightRuntime(target);
    if (
      target.role === "manager" &&
      attachments.length === 0 &&
      await this.options.knowledge.maybeRunCortexConsolidationFromIncomingMessage(
        trimmed,
        target,
        sourceContext,
      )
    ) {
      return;
    }

    const compactCommand = target.role === "manager" && attachments.length === 0
      ? parseCompactSlashCommand(trimmed)
      : undefined;
    if (compactCommand) {
      this.options.events.markSessionActivity(target.agentId, this.options.now());
      this.options.logDebug("manager:user_message_compact_command", {
        targetAgentId: target.agentId,
        sourceContext,
        customInstructionsPreview: previewForLog(compactCommand.customInstructions ?? ""),
      });
      await this.options.knowledge.compact(target.agentId, {
        customInstructions: compactCommand.customInstructions,
        sourceContext,
        trigger: "slash_command",
      });
      return;
    }

    const codexClassification = target.role === "manager"
      ? this.options.codex.plugin.classifyAndPreflightUserTurn(
          target as ManagerDescriptor,
          trimmed,
          sourceContext,
        )
      : ({ kind: "none" } as const);
    const appended = await this.appendUserMessage(
      target,
      trimmed,
      attachments,
      sourceContext,
      options?.collaborationAuthor,
      resolvedReplyTo,
      options?.clientRequestId,
    );

    if (target.role === "manager") {
      this.options.runtime.executableTrust.schedulePrompt(target as ManagerDescriptor);
    }
    const preparedCodexTurn = target.role === "manager"
      ? this.options.codex.plugin.prepareUserTurn({
          manager: target as ManagerDescriptor,
          text: trimmed,
          sourceContext,
          classification: codexClassification,
          userMessageId: appended.event.id,
        })
      : {};

    await this.dispatchRuntime({
      target,
      text: trimmed,
      sourceContext,
      runtimeAttachments: appended.runtimeAttachments,
      persistedAttachmentCount: appended.persistedAttachments.length,
      visibleMessageId: appended.event.id,
      delivery: options?.delivery,
      collaborationAuthor: options?.collaborationAuthor,
      codexClassification,
      codexPluginDelegationContext: preparedCodexTurn.delegationContext,
      codexPluginRetryAuthorizationContext: preparedCodexTurn.retryAuthorizationContext,
      replyTo: resolvedReplyTo,
    });
  }

  private resolveTarget(targetAgentId?: string): AgentDescriptor {
    const resolvedTargetAgentId = targetAgentId ?? this.options.targeting.resolvePreferredManagerId();
    if (!resolvedTargetAgentId) {
      throw new Error("No manager is available. Create a manager first.");
    }
    const target = this.options.targeting.descriptors.get(resolvedTargetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${resolvedTargetAgentId}`);
    }

    this.options.targeting.assertDescriptorNotEffectivelyArchived(target);
    if (isNonRunningAgentStatus(target.status)) {
      const recoverableCodexRetry = isExternalThreadDescriptor(target) && target.status === "error";
      if (!recoverableCodexRetry) {
        throw new Error(`Target agent is not running: ${resolvedTargetAgentId}`);
      }
    }
    return target;
  }

  private async appendUserMessage(
    target: AgentDescriptor,
    text: string,
    attachments: ConversationAttachment[],
    sourceContext: MessageSourceContext,
    collaborationAuthor?: CollaborationAuthor,
    replyTo?: ConversationReplyTarget,
    clientRequestId?: string,
  ): Promise<AppendConversationUserMessageResult> {
    const receivedAt = this.options.now();
    const managerContextId = target.role === "manager" ? target.agentId : target.managerId;
    this.options.logDebug("manager:user_message_received", {
      targetAgentId: target.agentId,
      managerContextId,
      sourceContext,
      textPreview: previewForLog(text),
      attachmentCount: attachments.length,
      collaborationAuthor: collaborationAuthor
        ? {
            userId: collaborationAuthor.userId,
            workspaceId: collaborationAuthor.workspaceId,
            channelId: collaborationAuthor.channelId,
            role: collaborationAuthor.role,
          }
        : undefined,
    });

    const appended = await this.options.inboundConversation.append(target, {
      text,
      timestamp: receivedAt,
      source: "user_input",
      sourceContext,
      collaborationAuthor,
      clientRequestId,
      attachments,
      replyTo,
    });
    return {
      target,
      text,
      sourceContext,
      receivedAt,
      event: appended.event,
      persistedAttachments: appended.persistedAttachments,
      runtimeAttachments: appended.runtimeAttachments,
    };
  }

  private async dispatchRuntime(input: RuntimeDispatchInput): Promise<void> {
    if (input.target.role !== "manager") {
      await this.dispatchWorkerRuntime(input);
      return;
    }
    await this.dispatchManagerRuntime(input.target as ManagerDescriptor, input);
  }

  private async dispatchWorkerRuntime(input: RuntimeDispatchInput): Promise<void> {
    const { target } = input;
    if (isExternalThreadDescriptor(target)) {
      throw new Error("Codex sidecar messages must route through the Codex sidecar path.");
    }
    const managerContextId = target.managerId;
    const requestedDelivery = input.delivery ?? "auto";
    const workerRuntimeText = input.replyTo
      ? formatInboundUserMessageForManager(
          input.text,
          input.sourceContext,
          undefined,
          undefined,
          input.replyTo,
        )
      : input.text;
    let receipt: SendMessageReceipt;
    try {
      receipt = await this.options.agentMessages.sendMessage(
        managerContextId,
        target.agentId,
        workerRuntimeText,
        requestedDelivery,
        { origin: "user", attachments: input.runtimeAttachments },
      );
    } catch (error) {
      this.logDispatchError(input, managerContextId, requestedDelivery, error);
      throw error;
    }

    this.options.logDebug("manager:user_message_dispatch_complete", {
      managerContextId,
      targetAgentId: target.agentId,
      targetRole: target.role,
      requestedDelivery,
      acceptedMode: receipt.acceptedMode,
      sourceContext: input.sourceContext,
      attachmentCount: input.persistedAttachmentCount,
    });
    const event: AgentMessageEvent = {
      type: "agent_message",
      agentId: managerContextId,
      timestamp: this.options.now(),
      source: "user_to_agent",
      toAgentId: target.agentId,
      text: input.text,
      sourceContext: input.sourceContext,
      requestedDelivery,
      acceptedMode: receipt.acceptedMode,
      attachmentCount:
        input.persistedAttachmentCount > 0 ? input.persistedAttachmentCount : undefined,
    };
    this.options.events.emitAgentMessage(event);
  }

  private async dispatchManagerRuntime(
    target: ManagerDescriptor,
    input: RuntimeDispatchInput,
  ): Promise<void> {
    const managerContextId = target.agentId;
    if (this.options.runtime.recovery.hasPendingManagerRuntimeRecycle(managerContextId)) {
      const disposition = await this.options.runtime.executableTrust
        .applyManagerRuntimeRecyclePolicy(managerContextId, "idle_transition");
      if (disposition === "recycled") {
        await this.options.runtime.persistRecycledRuntimeState();
      }
    }

    let runtime: SwarmAgentRuntime;
    try {
      runtime = await this.options.runtime.getOrCreateRuntime(target);
    } catch (error) {
      this.logDispatchError(input, managerContextId, "steer", error);
      throw error;
    }

    const assistantOutputTarget = this.options.assistantOutput.resolveTargetForUserInput(
      target,
      input.sourceContext,
      input.collaborationAuthor,
    );
    const managerVisibleMessage = formatInboundUserMessageForManager(
      input.text,
      input.sourceContext,
      input.collaborationAuthor,
      assistantOutputTarget,
      input.replyTo,
    );
    const runtimeVisibleMessage = this.options.codex.plugin.appendManagerTurnGuidance(
      managerVisibleMessage,
      input.codexPluginDelegationContext,
      input.codexPluginRetryAuthorizationContext,
    );
    const runtimeMessage = await this.options.agentMessages.prepareModelInboundMessage(
      managerContextId,
      { text: runtimeVisibleMessage, attachments: input.runtimeAttachments },
      "user",
    );
    const runtimeText = extractRuntimeMessageText(runtimeMessage);
    this.options.logDebug("manager:user_message_dispatch_start", {
      managerContextId,
      targetAgentId: managerContextId,
      targetRole: target.role,
      requestedDelivery: "steer",
      sourceContext: input.sourceContext,
      textPreview: previewForLog(input.text),
      attachmentCount: input.persistedAttachmentCount,
      runtimeTextPreview: previewForLog(runtimeText),
      runtimeImageCount: typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0),
    });

    const codexMcpToolGate = this.options.codex.plugin.buildTurnGate(
      target,
      input.sourceContext,
      input.text,
      input.codexClassification ?? { kind: "none" },
      "user_input",
    );
    const metadata = {
      attachmentCount: input.persistedAttachmentCount,
      codexPluginDelegation: Boolean(input.codexPluginDelegationContext),
      collaboration: Boolean(input.collaborationAuthor?.channelId),
    };
    const observabilityInput = this.options.observability.beginRuntimeInput({
      target,
      rootSource: "user_input",
      originalInput: input.text,
      runtimeInput: runtimeMessage,
      visibleMessageId: input.visibleMessageId,
      requestedDelivery: "steer",
      sourceChannel: input.sourceContext.channel,
      metadata,
    });
    const { rollback } = await this.options.turns.enqueue(managerContextId, {
      source: "user_input",
      routeOrigin: "user",
      rootTurnId: observabilityInput?.rootTurnId,
      runtimeMessageText: runtimeText,
      sourceContext: input.sourceContext,
      collaborationAuthor: input.collaborationAuthor,
      assistantOutputTarget,
      codexMcpToolGate,
      codexPluginDelegationContext: input.codexPluginDelegationContext,
      codexPluginRetryAuthorizationContext: input.codexPluginRetryAuthorizationContext,
    });

    try {
      const receipt = await runtime.sendMessage(runtimeMessage, "steer");
      this.options.observability.completeRuntimeInput(observabilityInput, receipt, metadata);
      this.options.codex.plugin.recordDispatchAccepted(managerContextId, {
        gate: codexMcpToolGate,
        delegation: input.codexPluginDelegationContext,
        retryAuthorization: input.codexPluginRetryAuthorizationContext,
        acceptedMode: receipt.acceptedMode,
      });
      this.options.logDebug("manager:user_message_dispatch_complete", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        acceptedMode: receipt.acceptedMode,
        sourceContext: input.sourceContext,
        attachmentCount: input.persistedAttachmentCount,
      });
    } catch (error) {
      rollback();
      this.options.observability.cancelRuntimeInput(
        observabilityInput,
        "manager_user_dispatch_failed",
      );
      this.logDispatchError(input, managerContextId, "steer", error, runtimeMessage);
      throw error;
    }
  }

  private logDispatchError(
    input: RuntimeDispatchInput,
    managerContextId: string,
    requestedDelivery: RequestedDeliveryMode,
    error: unknown,
    runtimeMessage?: string | RuntimeUserMessage,
  ): void {
    this.options.logDebug("manager:user_message_dispatch_error", {
      managerContextId,
      targetAgentId: input.target.agentId,
      targetRole: input.target.role,
      requestedDelivery,
      sourceContext: input.sourceContext,
      textPreview: previewForLog(input.text),
      attachmentCount: input.persistedAttachmentCount,
      ...(runtimeMessage
        ? {
            runtimeTextPreview: previewForLog(extractRuntimeMessageText(runtimeMessage)),
            runtimeImageCount:
              typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0),
          }
        : {}),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}
