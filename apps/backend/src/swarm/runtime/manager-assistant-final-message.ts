import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import {
  extractMessageErrorMessage,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  hasMessageErrorMessageField,
  isAbortLikeErrorMessage,
} from "../message-utils.js";

export interface CleanManagerAssistantFinalMessage {
  text: string;
}

export const INTENTIONAL_NO_REPLY_TEXT = "NO_REPLY";

export function isIntentionalNoReplyText(text: string | null | undefined): boolean {
  return text?.trim() === INTENTIONAL_NO_REPLY_TEXT;
}

/**
 * A manager's silent closeout is a standalone first line, not prose that
 * happens to mention the sentinel. Providers can occasionally append their
 * private continuation rationale after that line; keep that malformed output
 * out of the user transcript while retaining the raw provider event in the
 * canonical session history.
 */
export function hasNoReplySentinelLine(text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  return Boolean(trimmed && /^NO_REPLY[ \t]*(?:\r?\n|$)/.test(trimmed));
}

export function isIntentionalNoReplyManagerAssistantFinalMessage(event: RuntimeSessionEvent): boolean {
  return isIntentionalNoReplyText(extractEligibleManagerAssistantFinalText(event));
}

export function hasNoReplySentinelLineManagerAssistantFinalMessage(event: RuntimeSessionEvent): boolean {
  return hasNoReplySentinelLine(extractEligibleManagerAssistantFinalText(event));
}

export function isCleanManagerAssistantFinalMessage(event: RuntimeSessionEvent): boolean {
  return extractCleanManagerAssistantFinalMessage(event) !== undefined;
}

export function extractCleanManagerAssistantFinalMessage(
  event: RuntimeSessionEvent,
): CleanManagerAssistantFinalMessage | undefined {
  const text = extractEligibleManagerAssistantFinalText(event);
  if (!text || hasNoReplySentinelLine(text)) {
    return undefined;
  }

  return { text };
}

function extractEligibleManagerAssistantFinalText(event: RuntimeSessionEvent): string | undefined {
  if (event.type !== "message_end") {
    return undefined;
  }

  if (extractRole(event.message) !== "assistant") {
    return undefined;
  }

  if (messageHasIneligibleStopOrError(event.message) || isToolUseStopReason(event.message)) {
    return undefined;
  }

  if (getToolLikeMessageBlocks(event.message).length > 0) {
    return undefined;
  }

  const text = extractMessageText(event.message)?.trim();
  if (!text) {
    return undefined;
  }

  return text;
}

export function messageHasIneligibleStopOrError(message: unknown): boolean {
  const stopReason = normalizeStopReason(extractMessageStopReason(message));
  const errorMessage = extractMessageErrorMessage(message) ?? extractMessageText(message);
  return (
    stopReason === "error" ||
    stopReason === "aborted" ||
    stopReason === "abort" ||
    hasMessageErrorMessageField(message) ||
    isAbortLikeErrorMessage(errorMessage)
  );
}

export function getToolLikeMessageBlocks(message: unknown): Array<Record<string, unknown>> {
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

function isToolUseStopReason(message: unknown): boolean {
  return normalizeStopReason(extractMessageStopReason(message)) === "tooluse";
}

function normalizeStopReason(stopReason: string | undefined): string | undefined {
  return stopReason?.replace(/[\s_-]+/g, "").toLowerCase();
}
