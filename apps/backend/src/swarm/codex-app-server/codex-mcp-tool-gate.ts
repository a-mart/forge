import type { MessageSourceContext } from "../types.js";
import type { AgentDescriptor } from "../types.js";
import { isBuilderWebCodexRoutingSurface } from "./codex-mention-router.js";

export interface CodexMcpToolGateEvaluation {
  allowed: boolean;
  reason?: string;
}

const SCHEDULED_TASK_PREFIX = /^\[Scheduled Task:/i;
const SCHEDULE_CONTEXT_MARKER = /\[scheduleContext\]/i;

export function isScheduledTaskUserMessage(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  const trimmed = text.trimStart();
  return SCHEDULED_TASK_PREFIX.test(trimmed) || SCHEDULE_CONTEXT_MARKER.test(trimmed);
}

export function evaluateCodexMcpToolGate(params: {
  manager: AgentDescriptor;
  sourceContext: MessageSourceContext;
  messageText?: string;
  inboundSource?: "user_input" | "project_agent_input";
}): CodexMcpToolGateEvaluation {
  if (params.manager.role !== "manager") {
    return { allowed: false, reason: "Codex MCP tools require a manager session." };
  }

  if (!isBuilderWebCodexRoutingSurface(params.sourceContext, params.manager)) {
    return { allowed: false, reason: "Codex MCP tools are only available on Builder web manager sessions." };
  }

  if (params.sourceContext.channel !== "web") {
    return { allowed: false, reason: "Codex MCP tools are only available for web user turns." };
  }

  if (params.inboundSource === "project_agent_input") {
    return { allowed: false, reason: "Codex MCP tools are not available for project-agent input turns." };
  }

  if (isScheduledTaskUserMessage(params.messageText)) {
    return { allowed: false, reason: "Codex MCP tools are not available for scheduled task turns." };
  }

  return { allowed: true };
}

export function assertCodexMcpToolGateAllowed(gate: CodexMcpToolGateEvaluation): void {
  if (!gate.allowed) {
    throw new Error(gate.reason ?? "Codex MCP tools are not allowed for this turn.");
  }
}
