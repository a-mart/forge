import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import type { ConversationMessageEvent, MessageSourceContext } from "../types.js";
import {
  extractMessageErrorMessage,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  hasMessageErrorMessageField,
  isAbortLikeErrorMessage,
} from "../message-utils.js";

type SessionTranscriptAssistantOutputTarget = {
  kind: "session_transcript";
  channel: "web" | "cli";
  sourceContext?: MessageSourceContext;
};

export type AssistantOutputTarget =
  | SessionTranscriptAssistantOutputTarget
  | { kind: "explicit_tool_required"; reason: string }
  | { kind: "peer_agent"; fromAgentId: string }
  | { kind: "external_channel"; sourceContext: MessageSourceContext };

interface AssistantOutputCandidate {
  text: string;
  sourceContext: MessageSourceContext;
}

interface ActiveManagerAssistantOutputTurn {
  target: AssistantOutputTarget;
  openToolCallIds: Set<string>;
  explicitAssistantDelivered: boolean;
  candidate?: AssistantOutputCandidate;
}

export interface ManagerAssistantOutputTrackerOptions {
  now(): string;
  emitConversationMessage(event: ConversationMessageEvent): void;
  markSessionActivity(agentId: string, timestamp: string): void;
}

export class ManagerAssistantOutputTracker {
  private readonly activeTurnsByAgentId = new Map<string, ActiveManagerAssistantOutputTurn>();

  constructor(private readonly options: ManagerAssistantOutputTrackerOptions) {}

  activateTurn(agentId: string, target: AssistantOutputTarget): void {
    this.activeTurnsByAgentId.set(agentId, {
      target,
      openToolCallIds: new Set<string>(),
      explicitAssistantDelivered: false,
    });
  }

  clearTurn(agentId: string): void {
    this.activeTurnsByAgentId.delete(agentId);
  }

  markExplicitAssistantOutput(agentId: string): void {
    const activeTurn = this.activeTurnsByAgentId.get(agentId);
    if (!activeTurn) {
      return;
    }

    activeTurn.explicitAssistantDelivered = true;
    activeTurn.candidate = undefined;
  }

  handleRuntimeEvent(agentId: string, event: RuntimeSessionEvent): void {
    const activeTurn = this.activeTurnsByAgentId.get(agentId);
    if (!activeTurn) {
      return;
    }

    switch (event.type) {
      case "tool_execution_start":
        activeTurn.openToolCallIds.add(event.toolCallId);
        activeTurn.candidate = undefined;
        break;

      case "tool_execution_end":
        activeTurn.openToolCallIds.delete(event.toolCallId);
        break;

      case "message_end":
        this.updateAssistantOutputCandidate(activeTurn, event);
        break;

      case "turn_end":
      case "agent_end":
        this.emitCandidateIfEligible(agentId, activeTurn);
        this.clearTurn(agentId);
        break;

      default:
        break;
    }
  }

  private updateAssistantOutputCandidate(
    activeTurn: ActiveManagerAssistantOutputTurn,
    event: Extract<RuntimeSessionEvent, { type: "message_end" }>,
  ): void {
    activeTurn.candidate = undefined;

    if (activeTurn.target.kind !== "session_transcript") {
      return;
    }

    if (activeTurn.explicitAssistantDelivered || activeTurn.openToolCallIds.size > 0) {
      return;
    }

    if (extractRole(event.message) !== "assistant") {
      return;
    }

    if (messageHasIneligibleStopOrError(event.message)) {
      return;
    }

    if (messageContainsToolBlocks(event.message)) {
      return;
    }

    const text = extractMessageText(event.message)?.trim();
    if (!text) {
      return;
    }

    activeTurn.candidate = {
      text,
      sourceContext: activeTurn.target.sourceContext ?? { channel: activeTurn.target.channel },
    };
  }

  private emitCandidateIfEligible(agentId: string, activeTurn: ActiveManagerAssistantOutputTurn): void {
    if (activeTurn.target.kind !== "session_transcript") {
      return;
    }

    if (activeTurn.explicitAssistantDelivered || activeTurn.openToolCallIds.size > 0 || !activeTurn.candidate) {
      return;
    }

    const timestamp = this.options.now();
    this.options.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "assistant",
      text: activeTurn.candidate.text,
      timestamp,
      source: "assistant_output",
      sourceContext: activeTurn.candidate.sourceContext,
    });
    this.options.markSessionActivity(agentId, timestamp);
  }
}

function messageHasIneligibleStopOrError(message: unknown): boolean {
  const stopReason = extractMessageStopReason(message);
  const errorMessage = extractMessageErrorMessage(message) ?? extractMessageText(message);
  return (
    stopReason === "error" ||
    stopReason === "aborted" ||
    hasMessageErrorMessageField(message) ||
    isAbortLikeErrorMessage(errorMessage)
  );
}

function messageContainsToolBlocks(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }

    const maybeBlock = block as { type?: unknown; toolCallId?: unknown; name?: unknown };
    return (
      maybeBlock.type === "toolCall" ||
      maybeBlock.type === "tool_call" ||
      maybeBlock.type === "tool_use" ||
      maybeBlock.type === "toolResult" ||
      maybeBlock.type === "tool_result" ||
      (typeof maybeBlock.toolCallId === "string" && maybeBlock.toolCallId.trim().length > 0)
    );
  });
}
