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
  preserveThroughToolName?: string;
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

  flushTurn(agentId: string): void {
    const activeTurn = this.activeTurnsByAgentId.get(agentId);
    if (!activeTurn) {
      return;
    }

    this.emitCandidateIfEligible(agentId, activeTurn);
    this.clearTurn(agentId);
  }

  flushPreservedCandidateForTool(agentId: string, toolName: string): boolean {
    const activeTurn = this.activeTurnsByAgentId.get(agentId);
    if (!activeTurn || activeTurn.candidate?.preserveThroughToolName !== toolName) {
      return false;
    }

    return this.emitCandidateIfEligible(agentId, activeTurn, { allowOpenToolCalls: true });
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
        if (activeTurn.candidate?.preserveThroughToolName !== event.toolName) {
          activeTurn.candidate = undefined;
        }
        break;

      case "tool_execution_end":
        activeTurn.openToolCallIds.delete(event.toolCallId);
        if (event.isError && activeTurn.candidate?.preserveThroughToolName === event.toolName) {
          activeTurn.candidate = undefined;
        }
        break;

      case "message_end":
        this.updateAssistantOutputCandidate(activeTurn, event);
        break;

      case "turn_end":
      case "agent_end":
        this.flushTurn(agentId);
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

    if (activeTurn.explicitAssistantDelivered) {
      return;
    }

    if (extractRole(event.message) !== "assistant") {
      return;
    }

    if (messageHasIneligibleStopOrError(event.message)) {
      return;
    }

    const toolBlocks = getToolLikeMessageBlocks(event.message);
    const onlyPresentChoicesToolBlocks =
      toolBlocks.length > 0 && toolBlocks.every((block) => readToolBlockName(block) === "present_choices");
    if (toolBlocks.length > 0 && !onlyPresentChoicesToolBlocks) {
      return;
    }

    if (activeTurn.openToolCallIds.size > 0 && !onlyPresentChoicesToolBlocks) {
      return;
    }

    const text = extractMessageText(event.message)?.trim();
    if (!text) {
      return;
    }

    activeTurn.candidate = {
      text,
      sourceContext: activeTurn.target.sourceContext ?? { channel: activeTurn.target.channel },
      ...(onlyPresentChoicesToolBlocks ? { preserveThroughToolName: "present_choices" } : {}),
    };
  }

  private emitCandidateIfEligible(
    agentId: string,
    activeTurn: ActiveManagerAssistantOutputTurn,
    options?: { allowOpenToolCalls?: boolean },
  ): boolean {
    if (activeTurn.target.kind !== "session_transcript") {
      return false;
    }

    if (
      activeTurn.explicitAssistantDelivered ||
      (!options?.allowOpenToolCalls && activeTurn.openToolCallIds.size > 0) ||
      !activeTurn.candidate
    ) {
      return false;
    }

    const candidate = activeTurn.candidate;
    activeTurn.candidate = undefined;

    const timestamp = this.options.now();
    this.options.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "assistant",
      text: candidate.text,
      timestamp,
      source: "assistant_output",
      sourceContext: candidate.sourceContext,
    });
    this.options.markSessionActivity(agentId, timestamp);
    return true;
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

function getToolLikeMessageBlocks(message: unknown): Array<Record<string, unknown>> {
  if (!message || typeof message !== "object") {
    return [];
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter((block): block is Record<string, unknown> => {
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

function readToolBlockName(block: Record<string, unknown>): string | undefined {
  const name = block.name ?? block.toolName;
  return typeof name === "string" ? name : undefined;
}
