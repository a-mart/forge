import { isRetiredMessageSource } from "@forge/protocol";
import type { ConversationEntryEvent } from "../swarm/types.js";
import { projectConversationEntryForBuilderWire } from "../swarm/session/conversation-wire-projection.js";

const MAX_LEGACY_ACTIVITY_SUMMARY_BYTES = 8 * 1024;
const LEGACY_ACTIVITY_TRUNCATION_SUFFIX = "\n\n[Activity summary truncated.]";

/**
 * Applies the conversationPaging capability policy at the shared live/replay
 * wire boundary. Paging clients receive the current canonical Builder entry
 * union. Legacy clients retain the older union, with safe activity summaries
 * represented as bounded conversation_log records.
 */
export function projectConversationEntryForSubscriptionWire(
  entry: ConversationEntryEvent,
  supportsConversationPaging: boolean,
): ConversationEntryEvent | undefined {
  if (entry.type === "conversation_message" && isRetiredMessageSource(entry.sourceContext)) {
    return undefined;
  }
  const projected = projectConversationEntryForBuilderWire(entry);
  if (supportsConversationPaging) {
    return projected;
  }

  if (projected.type === "plan_summary" || projected.type === "model_cache_observation") {
    return undefined;
  }

  if (projected.type !== "activity_summary") {
    return projected;
  }

  return {
    type: "conversation_log",
    agentId: projected.agentId,
    timestamp: projected.timestamp,
    source: "runtime_log",
    kind: "tool_execution_end",
    ...(projected.toolName ? { toolName: projected.toolName } : {}),
    ...(projected.correlationId ? { toolCallId: projected.correlationId } : {}),
    text: truncateUtf8(projected.displaySummary, MAX_LEGACY_ACTIVITY_SUMMARY_BYTES),
    ...(projected.isError || projected.status === "failed" ? { isError: true } : {}),
    ...(projected.timelineEntryId ? { timelineEntryId: projected.timelineEntryId } : {}),
    ...(projected.timelineSequence !== undefined
      ? { timelineSequence: projected.timelineSequence }
      : {}),
  };
}

export function isConversationEntryServerEvent(
  event: { type: string },
): event is ConversationEntryEvent {
  return (
    event.type === "conversation_message" ||
    event.type === "conversation_log" ||
    event.type === "activity_summary" ||
    event.type === "agent_message" ||
    event.type === "agent_tool_call" ||
    event.type === "choice_request" ||
    event.type === "plan_summary" ||
    event.type === "model_cache_observation"
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  const suffixBytes = Buffer.byteLength(LEGACY_ACTIVITY_TRUNCATION_SUFFIX, "utf8");
  const prefix = Buffer.from(value, "utf8")
    .subarray(0, Math.max(0, maxBytes - suffixBytes))
    .toString("utf8")
    .replace(/\uFFFD+$/u, "");
  return `${prefix}${LEGACY_ACTIVITY_TRUNCATION_SUFFIX}`;
}
