import {
  isConversationMessageSource,
  isUserVisibleConversationMessage,
  type ConversationEntryEvent,
  type ConversationMessageEvent,
  type ConversationReplyTarget,
  type ConversationReplyTargetInput,
} from "@forge/protocol";

export const CONVERSATION_REPLY_TEXT_MAX_CHARS = 2000;

const REPLY_ROLES = ["user", "assistant", "system"] as const;

export type ParsedConversationReplyTargetInput = ConversationReplyTargetInput;

export function parseConversationReplyTargetInput(
  value: unknown,
): ParsedConversationReplyTargetInput | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const maybe = value as Partial<ConversationReplyTargetInput>;
  if (typeof maybe.messageId !== "string" || maybe.messageId.trim().length === 0) {
    return undefined;
  }

  if (
    maybe.role !== undefined &&
    (typeof maybe.role !== "string" || !(REPLY_ROLES as readonly string[]).includes(maybe.role))
  ) {
    return undefined;
  }

  if (maybe.timestamp !== undefined && typeof maybe.timestamp !== "string") {
    return undefined;
  }

  if (maybe.text !== undefined && typeof maybe.text !== "string") {
    return undefined;
  }

  if (maybe.source !== undefined && !isConversationMessageSource(maybe.source)) {
    return undefined;
  }

  if (
    maybe.attachmentCount !== undefined &&
    (typeof maybe.attachmentCount !== "number" ||
      !Number.isInteger(maybe.attachmentCount) ||
      maybe.attachmentCount < 0)
  ) {
    return undefined;
  }

  return {
    messageId: maybe.messageId.trim(),
    role: maybe.role,
    timestamp: maybe.timestamp?.trim() || undefined,
    text: maybe.text,
    source: maybe.source,
    attachmentCount: maybe.attachmentCount,
  };
}

export function sanitizeConversationReplyTargetInput(
  input: ParsedConversationReplyTargetInput,
): ConversationReplyTarget | undefined {
  const { text, truncated } = capConversationReplyText(input.text ?? "");
  if (!input.role || !input.timestamp?.trim()) {
    return undefined;
  }

  const source = input.source && isReplyRoleSourcePairConsistent(input.role, input.source)
    ? input.source
    : undefined;

  return {
    messageId: input.messageId,
    role: input.role,
    timestamp: input.timestamp.trim(),
    text,
    source,
    attachmentCount: input.attachmentCount,
    truncated: truncated || undefined,
  };
}

export function resolveConversationReplyTarget(
  history: ConversationEntryEvent[],
  input: ParsedConversationReplyTargetInput,
): ConversationReplyTarget | undefined {
  const canonical = findCanonicalConversationReplyTarget(history, input.messageId);
  if (canonical) {
    return canonical;
  }

  return sanitizeConversationReplyTargetInput(input);
}

export function findCanonicalConversationReplyTarget(
  history: ConversationEntryEvent[],
  messageId: string,
): ConversationReplyTarget | undefined {
  for (const entry of history) {
    if (entry.type !== "conversation_message") {
      continue;
    }

    if (entry.id !== messageId || !isUserVisibleConversationMessage(entry)) {
      continue;
    }

    return buildConversationReplyTargetFromMessage(entry, messageId);
  }

  return undefined;
}

export function buildConversationReplyTargetFromMessage(
  message: ConversationMessageEvent,
  messageId: string,
): ConversationReplyTarget {
  const { text, truncated } = capConversationReplyText(message.text);
  const attachmentCount = message.attachments?.length ?? 0;

  return {
    messageId,
    role: message.role,
    timestamp: message.timestamp,
    text,
    source: message.source,
    attachmentCount: attachmentCount > 0 ? attachmentCount : undefined,
    truncated: truncated || undefined,
  };
}

export function capConversationReplyText(text: string): { text: string; truncated: boolean } {
  if (text.length <= CONVERSATION_REPLY_TEXT_MAX_CHARS) {
    return { text, truncated: false };
  }

  return {
    text: text.slice(0, CONVERSATION_REPLY_TEXT_MAX_CHARS),
    truncated: true,
  };
}

export function formatConversationReplyTargetMetadata(replyTo: ConversationReplyTarget): string {
  const payload: Record<string, unknown> = {
    messageId: replyTo.messageId,
    role: replyTo.role,
    timestamp: replyTo.timestamp,
    text: replyTo.text,
  };

  if (replyTo.source !== undefined) {
    payload.source = replyTo.source;
  }

  if (replyTo.attachmentCount !== undefined) {
    payload.attachmentCount = replyTo.attachmentCount;
  }

  if (replyTo.truncated) {
    payload.truncated = true;
  }

  return `[replyTo] ${JSON.stringify(payload)}`;
}

function isReplyRoleSourcePairConsistent(
  role: ConversationReplyTarget["role"],
  source: ConversationReplyTarget["source"],
): boolean {
  switch (source) {
    case "speak_to_user":
    case "assistant_output":
    case "assistant_progress":
      return role === "assistant";
    case "user_input":
    case "project_agent_input":
      return role === "user";
    case "system":
      return role === "system" || role === "assistant";
    default:
      return false;
  }
}
