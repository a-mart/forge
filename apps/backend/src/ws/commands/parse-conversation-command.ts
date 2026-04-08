import { parseConversationAttachments } from "../attachment-parser.js";
import {
  fail,
  isValidChoiceAnswer,
  ok,
  type ClientCommandCandidate,
  type ParsedClientCommand
} from "./command-parse-helpers.js";

export function parseConversationCommand(maybe: ClientCommandCandidate): ParsedClientCommand | undefined {
  if (maybe.type === "user_message") {
    if (typeof maybe.text !== "string") {
      return fail("user_message.text must be a string");
    }

    const normalizedText = maybe.text.trim();
    const parsedAttachments = parseConversationAttachments(
      (maybe as { attachments?: unknown }).attachments,
      "user_message.attachments"
    );
    if (!parsedAttachments.ok) {
      return fail(parsedAttachments.error);
    }

    if (!normalizedText && parsedAttachments.attachments.length === 0) {
      return fail("user_message must include non-empty text or at least one attachment");
    }

    if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
      return fail("user_message.agentId must be a string when provided");
    }

    if (
      maybe.delivery !== undefined &&
      maybe.delivery !== "auto" &&
      maybe.delivery !== "followUp" &&
      maybe.delivery !== "steer"
    ) {
      return fail("user_message.delivery must be one of auto|followUp|steer");
    }

    return ok({
      type: "user_message",
      text: normalizedText,
      attachments: parsedAttachments.attachments.length > 0 ? parsedAttachments.attachments : undefined,
      agentId: maybe.agentId,
      delivery: maybe.delivery
    });
  }

  if (maybe.type === "choice_response") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const choiceId = (maybe as { choiceId?: unknown }).choiceId;
    const answers = (maybe as { answers?: unknown }).answers;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("choice_response.agentId must be a non-empty string");
    }
    if (typeof choiceId !== "string" || choiceId.trim().length === 0) {
      return fail("choice_response.choiceId must be a non-empty string");
    }
    if (!Array.isArray(answers) || !answers.every(isValidChoiceAnswer)) {
      return fail("choice_response.answers must be an array of valid ChoiceAnswer objects");
    }

    return ok({
      type: "choice_response",
      agentId: agentId.trim(),
      choiceId: choiceId.trim(),
      answers,
    });
  }

  if (maybe.type === "choice_cancel") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const choiceId = (maybe as { choiceId?: unknown }).choiceId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("choice_cancel.agentId must be a non-empty string");
    }
    if (typeof choiceId !== "string" || choiceId.trim().length === 0) {
      return fail("choice_cancel.choiceId must be a non-empty string");
    }

    return ok({
      type: "choice_cancel",
      agentId: agentId.trim(),
      choiceId: choiceId.trim(),
    });
  }

  if (maybe.type === "pin_message") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const messageId = (maybe as { messageId?: unknown }).messageId;
    const pinned = (maybe as { pinned?: unknown }).pinned;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("pin_message.agentId must be a non-empty string");
    }
    if (typeof messageId !== "string" || messageId.trim().length === 0) {
      return fail("pin_message.messageId must be a non-empty string");
    }
    if (typeof pinned !== "boolean") {
      return fail("pin_message.pinned must be a boolean");
    }

    return ok({
      type: "pin_message",
      agentId: agentId.trim(),
      messageId: messageId.trim(),
      pinned,
    });
  }

  if (maybe.type === "clear_all_pins") {
    const agentId = (maybe as { agentId?: unknown }).agentId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("clear_all_pins.agentId must be a non-empty string");
    }

    return ok({
      type: "clear_all_pins",
      agentId: agentId.trim(),
    });
  }

  if (maybe.type === "mark_unread") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("mark_unread.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("mark_unread.requestId must be a string when provided");
    }

    return ok({
      type: "mark_unread",
      agentId: agentId.trim(),
      requestId,
    });
  }

  if (maybe.type === "mark_all_read") {
    const profileId = (maybe as { profileId?: unknown }).profileId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof profileId !== "string" || profileId.trim().length === 0) {
      return fail("mark_all_read.profileId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("mark_all_read.requestId must be a string when provided");
    }

    return ok({
      type: "mark_all_read",
      profileId: profileId.trim(),
      requestId,
    });
  }

  return undefined;
}
