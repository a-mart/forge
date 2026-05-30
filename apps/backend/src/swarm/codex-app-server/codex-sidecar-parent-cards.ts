import type {
  ConversationMessageEvent,
  ExternalThreadMessageContext,
} from "../types.js";

type ExternalThreadMessageStatus = ExternalThreadMessageContext["status"];

export interface CodexParentExternalThreadCardParams {
  managerAgentId: string;
  sidecarAgentId: string;
  requestId: string;
  turnCorrelationId: string;
  status: ExternalThreadMessageStatus;
  timestamp: string;
  promptPreview?: string;
  resultPreview?: string;
  threadId?: string;
  detailMessageId?: string;
}

export function buildCodexParentExternalThreadContext(
  params: Omit<CodexParentExternalThreadCardParams, "timestamp">,
): ExternalThreadMessageContext {
  return {
    type: "codex_app_server",
    sidecarAgentId: params.sidecarAgentId,
    requestId: params.requestId,
    turnCorrelationId: params.turnCorrelationId,
    threadId: params.threadId,
    promptPreview: params.promptPreview,
    resultPreview: params.resultPreview,
    status: params.status,
    detailMessageId: params.detailMessageId,
    excludeFromModelContext: true,
  };
}

export function buildCodexParentExternalThreadCard(
  params: CodexParentExternalThreadCardParams,
): ConversationMessageEvent {
  return {
    type: "conversation_message",
    agentId: params.managerAgentId,
    role: "system",
    text: buildCodexParentExternalThreadCardText(params),
    timestamp: params.timestamp,
    source: "system",
    externalThreadContext: buildCodexParentExternalThreadContext(params),
  };
}

export function buildCodexParentExternalThreadCardText(
  params: Pick<
    CodexParentExternalThreadCardParams,
    "status" | "promptPreview" | "resultPreview"
  >,
): string {
  switch (params.status) {
    case "sent":
      return params.promptPreview
        ? `Sent to Codex: ${params.promptPreview}`
        : "Sent to Codex";
    case "running":
      return params.promptPreview
        ? `Codex is running: ${params.promptPreview}`
        : "Codex is running";
    case "completed":
      return params.resultPreview
        ? `Codex completed: ${params.resultPreview}`
        : "Codex completed";
    case "stopped":
      return "Codex turn stopped.";
    case "error":
      return params.resultPreview
        ? `Codex error: ${params.resultPreview}`
        : "Codex turn failed.";
    default:
      return "Codex sidecar update";
  }
}

export function truncateCodexPreview(text: string, maxLength = 240): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1)}…`;
}
