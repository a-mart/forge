import type { CodexCatalogMcpTool } from "./codex-mcp-catalog.js";

const DENIED_TOOL_NAME_PATTERN =
  /\b(write|send|create|update|delete|remove|destroy|destructive|security|credential|shell|exec|execute|browser|computer|upload|download|file)\b/i;

const DENIED_DESCRIPTION_PATTERN =
  /\b(write|send|create|update|delete|remove|destroy|destructive|security|credential|shell|browser|computer[- ]use|upload|download)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return undefined;
}

function collectAnnotationFlags(annotations: unknown): {
  readOnly?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
} {
  if (!isRecord(annotations)) {
    return {};
  }

  const readOnlyHint = readBoolean(annotations.readOnlyHint ?? annotations.read_only_hint);
  const destructiveHint = readBoolean(annotations.destructiveHint ?? annotations.destructive_hint);
  const openWorldHint = readBoolean(annotations.openWorldHint ?? annotations.open_world_hint);

  return {
    readOnly: readOnlyHint,
    destructive: destructiveHint,
    openWorld: openWorldHint,
  };
}

export function classifyCodexMcpToolSafety(tool: CodexCatalogMcpTool): {
  allowed: boolean;
  reason?: string;
} {
  const combined = `${tool.serverName} ${tool.toolName} ${tool.description ?? ""}`;
  if (DENIED_TOOL_NAME_PATTERN.test(`${tool.serverName}/${tool.toolName}`)) {
    return {
      allowed: false,
      reason: `Codex MCP tool ${tool.selector} is blocked by v1 safety policy (tool name).`,
    };
  }

  if (tool.description && DENIED_DESCRIPTION_PATTERN.test(tool.description)) {
    return {
      allowed: false,
      reason: `Codex MCP tool ${tool.selector} is blocked by v1 safety policy (description).`,
    };
  }

  if (DENIED_TOOL_NAME_PATTERN.test(combined) && !tool.readOnly) {
    return {
      allowed: false,
      reason: `Codex MCP tool ${tool.selector} is blocked by v1 safety policy (metadata).`,
    };
  }

  const annotationFlags = collectAnnotationFlags(tool.annotations);
  if (annotationFlags.destructive === true || tool.destructive === true) {
    return {
      allowed: false,
      reason: `Codex MCP tool ${tool.selector} is marked destructive and blocked in v1.`,
    };
  }

  if (tool.readOnly === true || annotationFlags.readOnly === true) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Codex MCP tool ${tool.selector} is not annotated read-only; direct calls are blocked in v1.`,
  };
}

export function assertCodexMcpToolReadOnlyAllowed(tool: CodexCatalogMcpTool): void {
  const verdict = classifyCodexMcpToolSafety(tool);
  if (!verdict.allowed) {
    throw new Error(verdict.reason ?? `Codex MCP tool ${tool.selector} is not allowed.`);
  }
}

export function parseCodexMcpToolSafetyFields(toolEntry: Record<string, unknown>): {
  readOnly?: boolean;
  destructive?: boolean;
  annotations?: Record<string, unknown>;
} {
  const annotations = isRecord(toolEntry.annotations)
    ? toolEntry.annotations
    : isRecord(toolEntry.annotation)
      ? toolEntry.annotation
      : undefined;

  const annotationFlags = collectAnnotationFlags(annotations);
  const readOnly =
    readBoolean(toolEntry.readOnly) ??
    readBoolean(toolEntry.read_only) ??
    annotationFlags.readOnly;
  const destructive =
    readBoolean(toolEntry.destructive) ??
    readBoolean(toolEntry.destructiveHint) ??
    annotationFlags.destructive;

  return {
    readOnly,
    destructive,
    annotations,
  };
}
