import type {
  ObservabilityFacade,
  ObservabilityRootSource,
  ObservabilityRuntimeInputHandle,
} from "../observability/observability-types.js";
import type { RuntimeSessionEvent } from "./runtime-contracts.js";
import type { SwarmToolSideEffectEvent } from "./swarm-tool-host.js";
import type {
  AgentDescriptor,
  ConversationMessageEvent,
  RequestedDeliveryMode,
  SendMessageReceipt,
} from "./types.js";

interface ActiveRootContext {
  rootTurnId: string;
  parentRootTurnId?: string;
}

export interface ObservabilityParentTool {
  agentId: string;
  runtimeToken?: number;
  toolCallId: string;
  toolName?: string;
}

export interface SwarmObservabilityCoordinatorOptions {
  service?: ObservabilityFacade;
  descriptors: Map<string, AgentDescriptor>;
  getRuntimeToken: (agentId: string) => number | undefined;
}

/** Owns swarm trace ancestry and all observability projection adapters. */
export class SwarmObservabilityCoordinator {
  private readonly activeRoots = new Map<string, ActiveRootContext>();

  constructor(private readonly options: SwarmObservabilityCoordinatorOptions) {}

  getService(): ObservabilityFacade | undefined {
    return this.options.service;
  }

  activateRoot(agentId: string, rootTurnId: string, parentRootTurnId?: string): void {
    this.activeRoots.set(agentId, { rootTurnId, parentRootTurnId });
  }

  clearRoot(agentId: string): void {
    this.activeRoots.delete(agentId);
  }

  getActiveRootTurnId(agentId: string): string | undefined {
    const direct = this.activeRoots.get(agentId);
    if (direct) return direct.parentRootTurnId ?? direct.rootTurnId;

    const descriptor = this.options.descriptors.get(agentId);
    if (descriptor?.role !== "worker") return undefined;
    const managerRoot = this.activeRoots.get(descriptor.managerId);
    return managerRoot?.parentRootTurnId ?? managerRoot?.rootTurnId;
  }

  getRuntimeType(
    descriptor: AgentDescriptor,
  ): "pi" | "cursor-sdk" {
    if (descriptor.model.provider === "cursor-sdk") return "cursor-sdk";
    return "pi";
  }

  recordRuntimeSessionEvent(
    agentId: string,
    runtimeToken: number | undefined,
    event: RuntimeSessionEvent,
  ): void {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || !this.options.service) return;

    this.options.service.recordRuntimeSessionEvent({
      agentId,
      managerId: descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId,
      profileId: descriptor.profileId,
      role: descriptor.role,
      runtimeType: this.getRuntimeType(descriptor),
      runtimeToken,
      agentName: descriptor.displayName,
      event,
      metadata: {
        modelProvider: descriptor.model.provider,
        modelId: descriptor.model.modelId,
        status: descriptor.status,
      },
    });
  }

  recordToolSideEffect(
    callerAgentId: string,
    event: SwarmToolSideEffectEvent,
  ): void {
    const descriptor = this.options.descriptors.get(callerAgentId);
    if (!descriptor || !this.options.service) return;

    this.options.service.recordToolSideEffect({
      agentId: descriptor.agentId,
      managerId:
        descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId,
      profileId: descriptor.profileId,
      role: descriptor.role,
      runtimeType: this.getRuntimeType(descriptor),
      runtimeToken: this.options.getRuntimeToken(descriptor.agentId),
      agentName: descriptor.displayName,
      ...event,
      metadata: {
        modelProvider: descriptor.model.provider,
        modelId: descriptor.model.modelId,
        ...event.metadata,
      },
    });
  }

  recordUserVisibleMessage(event: ConversationMessageEvent): void {
    if (
      !this.options.service ||
      event.role !== "assistant" ||
      event.source !== "assistant_output"
    ) {
      return;
    }

    const descriptor = this.options.descriptors.get(event.agentId);
    if (!descriptor) return;

    this.options.service.recordUserVisibleMessage({
      agentId: descriptor.agentId,
      managerId:
        descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId,
      profileId: descriptor.profileId,
      role: descriptor.role,
      runtimeType: this.getRuntimeType(descriptor),
      runtimeToken: this.options.getRuntimeToken(descriptor.agentId),
      agentName: descriptor.displayName,
      rootTurnId: this.getActiveRootTurnId(descriptor.agentId),
      messageId: event.id,
      source: event.source,
      sourceContext: event.sourceContext,
      text: event.text,
      metadata: {
        modelProvider: descriptor.model.provider,
        modelId: descriptor.model.modelId,
        status: descriptor.status,
      },
    });
  }

  resolveParentTool(
    input: ObservabilityParentTool | undefined,
  ): ObservabilityParentTool | undefined {
    if (!input) return undefined;
    return {
      ...input,
      runtimeToken:
        input.runtimeToken ?? this.options.getRuntimeToken(input.agentId),
    };
  }

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
  }): void {
    this.options.service?.recordAgentDelivery({
      fromAgentId: input.sender.agentId,
      targetAgentId: input.target.agentId,
      managerId:
        input.target.role === "manager"
          ? input.target.agentId
          : input.target.managerId,
      profileId: input.target.profileId,
      sourceAgentName: input.sender.displayName,
      targetAgentName: input.target.displayName,
      rootTurnId: input.rootTurnId,
      parentRootTurnId: input.parentRootTurnId,
      message: input.message,
      runtimeInput: input.runtimeInput,
      requestedDelivery: input.delivery,
      acceptedMode: input.receipt.acceptedMode,
      deliveryId: input.receipt.deliveryId,
      source: input.source,
      parentTool: input.parentTool,
      metadata: {
        senderRole: input.sender.role,
        targetRole: input.target.role,
        parentRootSemantics: input.parentRootTurnId
          ? "top_level_root_turn"
          : "self_root_turn",
        ...input.metadata,
      },
    });
  }

  beginRuntimeInput(input: {
    target: AgentDescriptor;
    rootSource: ObservabilityRootSource;
    originalInput?: unknown;
    runtimeInput: unknown;
    rootTurnId?: string;
    parentRootTurnId?: string;
    visibleMessageId?: string;
    requestedDelivery?: RequestedDeliveryMode;
    acceptedMode?: string;
    sourceChannel?: string;
    metadata?: Record<string, unknown>;
  }): ObservabilityRuntimeInputHandle | undefined {
    const handle = this.options.service?.beginRuntimeInput({
      targetAgentId: input.target.agentId,
      managerId:
        input.target.role === "manager"
          ? input.target.agentId
          : input.target.managerId,
      profileId: input.target.profileId,
      role: input.target.role,
      runtimeType: this.getRuntimeType(input.target),
      runtimeToken: this.options.getRuntimeToken(input.target.agentId),
      rootSource: input.rootSource,
      originalInput: input.originalInput,
      runtimeInput: input.runtimeInput,
      rootTurnId: input.rootTurnId,
      parentRootTurnId: input.parentRootTurnId,
      requestPayloadFidelity: "delta_only",
      visibleMessageId: input.visibleMessageId,
      requestedDelivery: input.requestedDelivery,
      acceptedMode: input.acceptedMode,
      sourceChannel: input.sourceChannel,
      agentName: input.target.displayName,
      metadata: {
        modelProvider: input.target.model.provider,
        modelId: input.target.model.modelId,
        ...input.metadata,
      },
    });
    if (handle) {
      this.activateRoot(
        input.target.agentId,
        handle.rootTurnId,
        input.parentRootTurnId,
      );
    }
    return handle;
  }

  completeRuntimeInput(
    handle: ObservabilityRuntimeInputHandle | undefined,
    receipt: SendMessageReceipt,
    metadata?: Record<string, unknown>,
  ): void {
    this.options.service?.completeRuntimeInput(handle, {
      acceptedMode: receipt.acceptedMode,
      deliveryId: receipt.deliveryId,
      metadata,
    });
  }

  cancelRuntimeInput(
    handle: ObservabilityRuntimeInputHandle | undefined,
    reason: string,
  ): void {
    if (
      handle &&
      this.activeRoots.get(handle.targetAgentId)?.rootTurnId === handle.rootTurnId
    ) {
      this.clearRoot(handle.targetAgentId);
    }
    this.options.service?.cancelRuntimeInput(handle, reason);
  }
}
