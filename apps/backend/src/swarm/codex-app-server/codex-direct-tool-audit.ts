import type { ConversationMessageEvent } from "../types.js";
import { buildCodexParentExternalThreadContext, truncateCodexPreview } from "./codex-sidecar-parent-cards.js";
import type { CodexMcpToolCallResult } from "./codex-mcp-catalog.js";

export interface CodexDirectToolAuditCardParams {
  managerAgentId: string;
  sidecarAgentId: string;
  requestId: string;
  turnCorrelationId: string;
  timestamp: string;
  selector: string;
  result: CodexMcpToolCallResult;
}

export function buildCodexDirectToolAuditCard(
  params: CodexDirectToolAuditCardParams & { status?: "running" | "completed" | "error" },
): ConversationMessageEvent {
  const status =
    params.status ?? (params.result.ok ? "completed" : params.result.error ? "error" : "completed");
  const promptPreview = `${params.selector} (${params.result.serverName}/${params.result.toolName})`;
  const resultPreview = params.result.ok
    ? params.result.redactedPreview
    : params.result.error ?? params.result.redactedPreview;

  return {
    type: "conversation_message",
    agentId: params.managerAgentId,
    role: "system",
    text: buildCodexDirectToolAuditText({
      selector: params.selector,
      status,
      preview: resultPreview,
    }),
    timestamp: params.timestamp,
    source: "system",
    externalThreadContext: buildCodexParentExternalThreadContext({
      managerAgentId: params.managerAgentId,
      sidecarAgentId: params.sidecarAgentId,
      requestId: params.requestId,
      turnCorrelationId: params.turnCorrelationId,
      status,
      promptPreview: truncateCodexPreview(promptPreview),
      resultPreview: truncateCodexPreview(resultPreview),
    }),
  };
}

function buildCodexDirectToolAuditText(params: {
  selector: string;
  status: "running" | "completed" | "error";
  preview: string;
}): string {
  if (params.status === "running") {
    return `Codex tool ${params.selector} running…`;
  }

  if (params.status === "completed") {
    return params.preview
      ? `Codex tool ${params.selector} completed: ${truncateCodexPreview(params.preview)}`
      : `Codex tool ${params.selector} completed.`;
  }

  return params.preview
    ? `Codex tool ${params.selector} failed: ${truncateCodexPreview(params.preview)}`
    : `Codex tool ${params.selector} failed.`;
}
