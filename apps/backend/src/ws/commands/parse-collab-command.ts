import { parseConversationAttachments } from "../attachment-parser.js";
import {
  fail,
  isValidChoiceAnswer,
  ok,
  type ClientCommandCandidate,
  type ParsedClientCommand,
} from "./command-parse-helpers.js";

export function parseCollabCommand(maybe: ClientCommandCandidate): ParsedClientCommand | undefined {
  if (maybe.type === "collab_bootstrap") {
    return ok({ type: "collab_bootstrap" });
  }

  if (maybe.type === "collab_subscribe_channel") {
    const channelId = (maybe as { channelId?: unknown }).channelId;
    if (typeof channelId !== "string" || channelId.trim().length === 0) {
      return fail("collab_subscribe_channel.channelId must be a non-empty string");
    }

    return ok({ type: "collab_subscribe_channel", channelId: channelId.trim() });
  }

  if (maybe.type === "collab_unsubscribe_channel") {
    const channelId = (maybe as { channelId?: unknown }).channelId;
    if (typeof channelId !== "string" || channelId.trim().length === 0) {
      return fail("collab_unsubscribe_channel.channelId must be a non-empty string");
    }

    return ok({ type: "collab_unsubscribe_channel", channelId: channelId.trim() });
  }

  if (maybe.type === "collab_user_message") {
    const channelId = (maybe as { channelId?: unknown }).channelId;
    const content = (maybe as { content?: unknown }).content;
    if (typeof channelId !== "string" || channelId.trim().length === 0) {
      return fail("collab_user_message.channelId must be a non-empty string");
    }
    if (typeof content !== "string") {
      return fail("collab_user_message.content must be a string");
    }

    const parsedAttachments = parseConversationAttachments(
      (maybe as { attachments?: unknown }).attachments,
      "collab_user_message.attachments",
    );
    if (!parsedAttachments.ok) {
      return fail(parsedAttachments.error);
    }

    const normalizedContent = content.trim();
    if (!normalizedContent && parsedAttachments.attachments.length === 0) {
      return fail("collab_user_message must include non-empty content or at least one attachment");
    }

    return ok({
      type: "collab_user_message",
      channelId: channelId.trim(),
      content: normalizedContent,
      attachments: parsedAttachments.attachments.length > 0 ? parsedAttachments.attachments : undefined,
    });
  }

  if (maybe.type === "collab_mark_channel_read") {
    const channelId = (maybe as { channelId?: unknown }).channelId;
    if (typeof channelId !== "string" || channelId.trim().length === 0) {
      return fail("collab_mark_channel_read.channelId must be a non-empty string");
    }

    return ok({ type: "collab_mark_channel_read", channelId: channelId.trim() });
  }

  if (maybe.type === "collab_choice_response") {
    const channelId = (maybe as { channelId?: unknown }).channelId;
    const choiceId = (maybe as { choiceId?: unknown }).choiceId;
    const answers = (maybe as { answers?: unknown }).answers;

    if (typeof channelId !== "string" || channelId.trim().length === 0) {
      return fail("collab_choice_response.channelId must be a non-empty string");
    }
    if (typeof choiceId !== "string" || choiceId.trim().length === 0) {
      return fail("collab_choice_response.choiceId must be a non-empty string");
    }
    if (!Array.isArray(answers) || !answers.every(isValidChoiceAnswer)) {
      return fail("collab_choice_response.answers must be an array of valid ChoiceAnswer objects");
    }

    return ok({
      type: "collab_choice_response",
      channelId: channelId.trim(),
      choiceId: choiceId.trim(),
      answers,
    });
  }

  if (maybe.type === "collab_choice_cancel") {
    const channelId = (maybe as { channelId?: unknown }).channelId;
    const choiceId = (maybe as { choiceId?: unknown }).choiceId;

    if (typeof channelId !== "string" || channelId.trim().length === 0) {
      return fail("collab_choice_cancel.channelId must be a non-empty string");
    }
    if (typeof choiceId !== "string" || choiceId.trim().length === 0) {
      return fail("collab_choice_cancel.choiceId must be a non-empty string");
    }

    return ok({
      type: "collab_choice_cancel",
      channelId: channelId.trim(),
      choiceId: choiceId.trim(),
    });
  }

  if (maybe.type === "collab_pin_message") {
    const channelId = (maybe as { channelId?: unknown }).channelId;
    const messageId = (maybe as { messageId?: unknown }).messageId;
    const pinned = (maybe as { pinned?: unknown }).pinned;

    if (typeof channelId !== "string" || channelId.trim().length === 0) {
      return fail("collab_pin_message.channelId must be a non-empty string");
    }
    if (typeof messageId !== "string" || messageId.trim().length === 0) {
      return fail("collab_pin_message.messageId must be a non-empty string");
    }
    if (typeof pinned !== "boolean") {
      return fail("collab_pin_message.pinned must be a boolean");
    }

    return ok({
      type: "collab_pin_message",
      channelId: channelId.trim(),
      messageId: messageId.trim(),
      pinned,
    });
  }

  return undefined;
}
