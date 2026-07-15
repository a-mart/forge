import { randomUUID } from "node:crypto";
import type {
  ActivitySummaryEvent,
  AgentToolCallEvent,
  ConversationLogEvent,
} from "../types.js";

export function buildActivitySummary(
  event: ConversationLogEvent | AgentToolCallEvent,
  options?: { status?: ActivitySummaryEvent["status"] },
): ActivitySummaryEvent | undefined {
  if (event.kind !== "tool_execution_end") return undefined;

  const correlationId = event.toolCallId?.trim();
  const toolName = event.toolName?.trim();
  const stableActivityId = correlationId || event.timelineEntryId || randomUUID();
  const isError = event.isError === true;
  const status = options?.status ?? (isError ? "failed" : "completed");

  return {
    type: "activity_summary",
    schemaVersion: 1,
    itemId: `tool:${event.agentId}:${stableActivityId}`,
    agentId: event.agentId,
    actorAgentId: event.type === "agent_tool_call" ? event.actorAgentId : event.agentId,
    ...(event.type === "agent_tool_call" && event.turnId ? { turnId: event.turnId } : {}),
    timestamp: event.timestamp,
    kind: "tool_activity",
    status,
    ...(toolName ? { toolName } : {}),
    ...(correlationId ? { correlationId } : {}),
    displaySummary: summarizeToolActivity(toolName, status),
    ...(isError || status !== "completed" ? { isError: true } : {}),
  };
}

function summarizeToolActivity(
  toolName: string | undefined,
  status: ActivitySummaryEvent["status"],
): string {
  const normalized = toolName?.toLowerCase();
  const outcome = status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : undefined;
  if (!normalized) return outcome ? `Activity ${outcome}` : "Completed activity";
  if (normalized.includes("apply_patch") || normalized.includes("edit") || normalized.includes("write_file")) {
    return outcome ? `File edit ${outcome}` : "Edited files";
  }
  if (normalized.includes("exec") || normalized.includes("command") || normalized === "bash" || normalized === "shell") {
    return outcome ? `Command ${outcome}` : "Ran command";
  }
  if (normalized.includes("read") || normalized.includes("view")) return outcome ? `File read ${outcome}` : "Read file";
  if (normalized.includes("search") || normalized.includes("find")) return outcome ? `Search ${outcome}` : "Searched";
  return (outcome ? `${toolName} ${outcome}` : `Ran ${toolName}`).slice(0, 512);
}
