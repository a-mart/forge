import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import type { ConversationMessageEvent, MessageSourceContext } from "../types.js";
import { extractMessageText, extractRole } from "../message-utils.js";
import {
  getToolLikeMessageBlocks,
  messageHasIneligibleStopOrError,
} from "./manager-assistant-final-message.js";

export type SessionTranscriptAssistantOutputTarget = {
  kind: "session_transcript";
  channel: "web" | "cli";
  sourceContext?: MessageSourceContext;
};

export type AssistantOutputTarget =
  | SessionTranscriptAssistantOutputTarget
  | { kind: "explicit_tool_required"; reason: string }
  | { kind: "peer_agent"; fromAgentId: string }
  | { kind: "external_channel"; sourceContext: MessageSourceContext }
  | { kind: "internal_only"; reason?: string };

interface AssistantOutputCandidate {
  text: string;
  sourceContext: MessageSourceContext;
  // "final" is only the preserved present_choices companion text. General
  // manager final assistant text is projected directly from clean message_end.
  kind: "final" | "progress";
  preserveThroughToolName?: string;
  expectedToolCallIds?: string[];
  expectedToolNames?: string[];
}

interface ActiveManagerAssistantOutputTurn {
  target: AssistantOutputTarget;
  openToolCalls: Map<string, string>;
  completedToolCalls: Map<string, { toolName: string; isError: boolean }>;
  progressEmitted: boolean;
  lastProgressText?: string;
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
      openToolCalls: new Map<string, string>(),
      completedToolCalls: new Map<string, { toolName: string; isError: boolean }>(),
      progressEmitted: false,
    });
  }

  clearTurn(agentId: string): void {
    this.activeTurnsByAgentId.delete(agentId);
  }

  flushTurn(agentId: string): void {
    this.clearTurn(agentId);
  }

  getActiveTarget(agentId: string): AssistantOutputTarget | undefined {
    return this.activeTurnsByAgentId.get(agentId)?.target;
  }

  flushPreservedCandidateForTool(agentId: string, toolName: string): boolean {
    const activeTurn = this.activeTurnsByAgentId.get(agentId);
    if (!activeTurn || activeTurn.candidate?.preserveThroughToolName !== toolName) {
      return false;
    }

    return this.emitCandidateIfEligible(agentId, activeTurn, { allowOpenToolCalls: true });
  }

  markExplicitAssistantOutput(_agentId: string): void {
    // Intentional no-op: manager-authored clean final text is projected based on
    // the active output surface, even if speak_to_user already published similar
    // text earlier in the same turn. Duplicate prevention must not hide output.
  }

  handleRuntimeEvent(agentId: string, event: RuntimeSessionEvent): void {
    const activeTurn = this.activeTurnsByAgentId.get(agentId);
    if (!activeTurn) {
      return;
    }

    switch (event.type) {
      case "tool_execution_start":
        if (activeTurn.candidate?.preserveThroughToolName !== event.toolName) {
          if (
            !this.emitProgressCandidateIfEligible(agentId, activeTurn, {
              startedToolCallId: event.toolCallId,
              startedToolName: event.toolName,
            }) &&
            !candidateHasExpectedToolReference(activeTurn.candidate)
          ) {
            activeTurn.candidate = undefined;
          }
        }
        activeTurn.openToolCalls.set(event.toolCallId, event.toolName);
        break;

      case "tool_execution_end":
        activeTurn.openToolCalls.delete(event.toolCallId);
        activeTurn.completedToolCalls.set(event.toolCallId, {
          toolName: event.toolName,
          isError: event.isError,
        });
        if (event.isError && activeTurn.candidate?.preserveThroughToolName === event.toolName) {
          activeTurn.candidate = undefined;
        }
        break;

      case "message_update":
        this.updateAssistantOutputCandidate(agentId, activeTurn, event, { provisional: true });
        break;

      case "message_end":
        this.updateAssistantOutputCandidate(agentId, activeTurn, event);
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
    agentId: string,
    activeTurn: ActiveManagerAssistantOutputTurn,
    event: Extract<RuntimeSessionEvent, { type: "message_end" | "message_update" }>,
    options?: { provisional?: boolean },
  ): void {
    if (options?.provisional && activeTurn.progressEmitted) {
      return;
    }

    activeTurn.candidate = undefined;

    if (activeTurn.target.kind !== "session_transcript") {
      return;
    }

    if (extractRole(event.message) !== "assistant") {
      return;
    }

    if (messageHasIneligibleStopOrError(event.message)) {
      return;
    }

    let text = extractMessageText(event.message)?.trim();
    if (!text) {
      return;
    }

    const textAfterAlreadyEmittedProgress =
      !options?.provisional && activeTurn.progressEmitted && activeTurn.lastProgressText
        ? removeAlreadyEmittedProgressPrefix(text, activeTurn.lastProgressText)
        : text;

    const toolBlocks = getToolLikeMessageBlocks(event.message);
    const onlyPresentChoicesToolBlocks =
      toolBlocks.length > 0 && toolBlocks.every((block) => readToolBlockName(block) === "present_choices");
    if (toolBlocks.length > 0 && !onlyPresentChoicesToolBlocks) {
      if (!textAfterAlreadyEmittedProgress) {
        return;
      }
      activeTurn.candidate = {
        text: textAfterAlreadyEmittedProgress,
        kind: "progress",
        sourceContext: activeTurn.target.sourceContext ?? { channel: activeTurn.target.channel },
        expectedToolCallIds: collectUniqueStrings(toolBlocks.map(readToolBlockId)),
        expectedToolNames: collectUniqueStrings(toolBlocks.map(readToolBlockName)),
      };
      if (activeTurn.openToolCalls.size > 0) {
        this.emitProgressCandidateIfEligible(agentId, activeTurn, { allowOpenToolCalls: true });
      } else if (activeTurn.completedToolCalls.size > 0) {
        this.emitProgressCandidateIfEligible(agentId, activeTurn, { allowCompletedToolCalls: true });
      }
      return;
    }

    if (activeTurn.openToolCalls.size > 0 && !onlyPresentChoicesToolBlocks) {
      if (!textAfterAlreadyEmittedProgress) {
        return;
      }
      activeTurn.candidate = {
        text: textAfterAlreadyEmittedProgress,
        kind: "progress",
        sourceContext: activeTurn.target.sourceContext ?? { channel: activeTurn.target.channel },
      };
      this.emitProgressCandidateIfEligible(agentId, activeTurn, { allowOpenToolCalls: true });
      return;
    }

    if (
      onlyPresentChoicesToolBlocks &&
      completedToolBlocksHaveError(activeTurn.completedToolCalls, toolBlocks)
    ) {
      return;
    }

    if (textAfterAlreadyEmittedProgress !== text) {
      text = textAfterAlreadyEmittedProgress;
      if (!text) {
        return;
      }
    }

    if (!onlyPresentChoicesToolBlocks) {
      if (options?.provisional) {
        activeTurn.candidate = {
          text,
          kind: "progress",
          sourceContext: activeTurn.target.sourceContext ?? { channel: activeTurn.target.channel },
        };
      }
      return;
    }

    activeTurn.candidate = {
      text,
      kind: "final",
      sourceContext: activeTurn.target.sourceContext ?? { channel: activeTurn.target.channel },
      preserveThroughToolName: "present_choices",
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
      (!options?.allowOpenToolCalls && activeTurn.openToolCalls.size > 0) ||
      !activeTurn.candidate ||
      activeTurn.candidate.kind !== "final"
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

  private emitProgressCandidateIfEligible(
    agentId: string,
    activeTurn: ActiveManagerAssistantOutputTurn,
    options?: {
      allowOpenToolCalls?: boolean;
      allowCompletedToolCalls?: boolean;
      startedToolCallId?: string;
      startedToolName?: string;
    },
  ): boolean {
    if (activeTurn.target.kind !== "session_transcript") {
      return false;
    }

    if (
      (!options?.allowOpenToolCalls && activeTurn.openToolCalls.size > 0) ||
      !activeTurn.candidate ||
      activeTurn.candidate.preserveThroughToolName ||
      !candidateMatchesToolWork(activeTurn.candidate, activeTurn.openToolCalls, activeTurn.completedToolCalls, options)
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
      source: "assistant_progress",
      sourceContext: candidate.sourceContext,
    });
    this.options.markSessionActivity(agentId, timestamp);
    activeTurn.progressEmitted = true;
    activeTurn.lastProgressText = candidate.text;
    return true;
  }
}

function readToolBlockName(block: Record<string, unknown>): string | undefined {
  const name = block.name ?? block.toolName;
  return typeof name === "string" ? name : undefined;
}

function readToolBlockId(block: Record<string, unknown>): string | undefined {
  const id = block.id ?? block.toolCallId ?? block.tool_call_id ?? block.callId;
  return typeof id === "string" ? id : undefined;
}

function collectUniqueStrings(values: Array<string | undefined>): string[] | undefined {
  const unique = [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
  return unique.length > 0 ? unique : undefined;
}

function candidateHasExpectedToolReference(candidate: AssistantOutputCandidate | undefined): boolean {
  return Boolean(candidate?.expectedToolCallIds?.length || candidate?.expectedToolNames?.length);
}

function candidateMatchesToolWork(
  candidate: AssistantOutputCandidate,
  openToolCalls: Map<string, string>,
  completedToolCalls: Map<string, { toolName: string; isError: boolean }>,
  options:
    | {
        allowOpenToolCalls?: boolean;
        allowCompletedToolCalls?: boolean;
        startedToolCallId?: string;
        startedToolName?: string;
      }
    | undefined,
): boolean {
  if (candidate.expectedToolCallIds?.length) {
    if (options?.startedToolCallId) {
      return candidate.expectedToolCallIds.includes(options.startedToolCallId);
    }
    return (
      (options?.allowOpenToolCalls === true &&
        candidate.expectedToolCallIds.some((toolCallId) => openToolCalls.has(toolCallId))) ||
      (options?.allowCompletedToolCalls === true &&
        candidate.expectedToolCallIds.some((toolCallId) => {
          const completed = completedToolCalls.get(toolCallId);
          return Boolean(completed && !completed.isError);
        }))
    );
  }

  if (candidate.expectedToolNames?.length) {
    if (options?.startedToolName) {
      return candidate.expectedToolNames.includes(options.startedToolName);
    }
    return (
      (options?.allowOpenToolCalls === true &&
        [...openToolCalls.values()].some((toolName) => candidate.expectedToolNames?.includes(toolName))) ||
      (options?.allowCompletedToolCalls === true &&
        [...completedToolCalls.values()].some(
          (tool) => !tool.isError && candidate.expectedToolNames?.includes(tool.toolName),
        ))
    );
  }

  return true;
}

function completedToolBlocksHaveError(
  completedToolCalls: Map<string, { toolName: string; isError: boolean }>,
  toolBlocks: Array<Record<string, unknown>>,
): boolean {
  for (const block of toolBlocks) {
    const id = readToolBlockId(block);
    if (id) {
      const completed = completedToolCalls.get(id);
      if (completed?.isError) {
        return true;
      }
      continue;
    }

    const name = readToolBlockName(block);
    if (name && [...completedToolCalls.values()].some((tool) => tool.toolName === name && tool.isError)) {
      return true;
    }
  }
  return false;
}

function removeAlreadyEmittedProgressPrefix(text: string, progressText: string): string | undefined {
  if (text === progressText) {
    return undefined;
  }

  if (!text.startsWith(progressText)) {
    return text;
  }

  const rawRemainder = text.slice(progressText.length);
  const remainder = rawRemainder.trimStart();
  if (!remainder) {
    return undefined;
  }

  if (/^\s/.test(rawRemainder) && !/[.!?:;)\]]$/.test(progressText) && /^[a-z]/.test(remainder)) {
    return text;
  }

  return remainder.replace(/^[.!?:;]+\s*/, "").trim() || undefined;
}
