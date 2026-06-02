import type { MessageSourceContext } from "../types.js";
import type { AgentDescriptor } from "../types.js";
import { isBuilderWebCodexRoutingSurface } from "./codex-mention-router.js";

export interface CodexMcpToolGateEvaluation {
  allowed: boolean;
  reason?: string;
  /** Normalized selectors from Codex tool mention tags on the active manager turn. */
  authorizedSelectors?: string[];
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

/** Builder web managers may browse the Codex MCP catalog for the composer picker (no active turn). */
export function evaluateCodexMcpCatalogBrowseGate(params: {
  manager: AgentDescriptor;
}): CodexMcpToolGateEvaluation {
  if (params.manager.role !== "manager") {
    return { allowed: false, reason: "Codex MCP catalog browsing requires a manager session." };
  }

  if (params.manager.sessionSurface === "collab" || params.manager.collab) {
    return { allowed: false, reason: "Codex MCP catalog browsing is not available on collab sessions." };
  }

  return { allowed: true };
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

export function buildCodexMcpToolTurnAuthorization(params: {
  surfaceGate: CodexMcpToolGateEvaluation;
  codexClassification: { kind: "none" | "sidecar" | "manager_tool"; selectors?: string[] };
}): CodexMcpToolGateEvaluation {
  if (!params.surfaceGate.allowed) {
    return params.surfaceGate;
  }

  if (params.codexClassification.kind === "manager_tool") {
    const selectors = params.codexClassification.selectors ?? [];
    if (selectors.length === 0) {
      return {
        allowed: false,
        reason: "Codex MCP tools require at least one Codex tool mention selector.",
      };
    }

    return { allowed: true, authorizedSelectors: selectors };
  }

  return {
    allowed: false,
    reason: "Codex MCP tools are only available on turns with Codex tool mention tags.",
  };
}

export function isCodexMcpToolSelectorAuthorized(
  requestedSelector: string,
  authorizedSelectors: string[],
  resolveTool: (selector: string) => { selector: string; serverName: string } | undefined,
): boolean {
  const trimmedRequested = requestedSelector.trim();
  if (!trimmedRequested || authorizedSelectors.length === 0) {
    return false;
  }

  const requestedResolved = resolveTool(trimmedRequested);
  if (!requestedResolved) {
    return false;
  }

  const requestedKey = requestedResolved.selector.trim().toLowerCase();
  const requestedServer = requestedResolved.serverName.trim().toLowerCase();
  const requestedServerPrefix = trimmedRequested.includes("/")
    ? trimmedRequested.split("/")[0]?.trim().toLowerCase()
    : undefined;

  for (const authorized of authorizedSelectors) {
    const trimmedAuthorized = authorized.trim();
    if (!trimmedAuthorized) {
      continue;
    }

    if (trimmedAuthorized.toLowerCase() === trimmedRequested.toLowerCase()) {
      return true;
    }

    const authorizedResolved = resolveTool(trimmedAuthorized);
    if (authorizedResolved && authorizedResolved.selector.trim().toLowerCase() === requestedKey) {
      return true;
    }

    if (trimmedAuthorized.toLowerCase() === requestedServer) {
      if (
        requestedServerPrefix &&
        requestedServerPrefix !== trimmedAuthorized.toLowerCase() &&
        requestedServerPrefix !== requestedServer
      ) {
        continue;
      }
      return true;
    }
  }

  if (requestedServerPrefix) {
    return false;
  }

  return false;
}
