import type { CodexCatalogMcpTool } from "./codex-mcp-catalog.js";

const DENIED_TOOL_NAME_TOKENS = new Set([
  "write",
  "send",
  "create",
  "update",
  "delete",
  "remove",
  "destroy",
  "destructive",
  "security",
  "credential",
  "credentials",
  "shell",
  "exec",
  "execute",
  "browser",
  "computer",
  "upload",
  "download",
  "file",
]);

const DENIED_DESCRIPTION_TOKENS = new Set([
  "write",
  "send",
  "create",
  "update",
  "delete",
  "remove",
  "destroy",
  "destructive",
  "security",
  "credential",
  "credentials",
  "shell",
  "browser",
  "computer",
  "upload",
  "download",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tokenizePolicyText(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function findDeniedPolicyTokens(value: string, deniedTokens: ReadonlySet<string>): string[] {
  return tokenizePolicyText(value).filter((token) => deniedTokens.has(token));
}

function hasDeniedPolicyToken(value: string, deniedTokens: ReadonlySet<string>): boolean {
  return findDeniedPolicyTokens(value, deniedTokens).length > 0;
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

function canUseFirefliesTranscriptDownloadException(
  deniedTokens: readonly string[],
  exceptionAllowed: boolean,
): boolean {
  return exceptionAllowed && deniedTokens.every((token) => token === "download" || token === "file");
}

function normalizeIdentity(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isAggregateCodexAppsTool(tool: CodexCatalogMcpTool): boolean {
  return normalizeIdentity(tool.serverName) === "codex_apps";
}

function readStringField(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

export function isFirefliesCodexMcpTool(tool: CodexCatalogMcpTool): boolean {
  const serverName = normalizeIdentity(tool.serverName);
  const selector = normalizeIdentity(tool.selector);
  const toolName = normalizeIdentity(tool.toolName);
  const appId = normalizeIdentity(tool.appId);
  const appName = normalizeIdentity(tool.appName);
  const metadataPlugin = normalizeIdentity(
    readStringField(tool.annotations, [
      "plugin",
      "pluginId",
      "plugin_id",
      "app",
      "appId",
      "app_id",
    ]),
  );

  if (serverName === "fireflies" || selector.startsWith("fireflies/")) {
    return true;
  }

  const hasExplicitFirefliesMetadata =
    appId === "fireflies" ||
    appName === "fireflies" ||
    metadataPlugin === "fireflies" ||
    metadataPlugin.split("@")[0] === "fireflies";
  if (hasExplicitFirefliesMetadata) {
    return true;
  }

  if (
    isAggregateCodexAppsTool(tool) &&
    (selector.startsWith("codex_apps/fireflies_fireflies_") || toolName.startsWith("fireflies_fireflies_"))
  ) {
    return true;
  }

  return false;
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

function isNarrowReadOnlyFirefliesTranscriptDownloadTool(
  tool: CodexCatalogMcpTool,
  annotationFlags: ReturnType<typeof collectAnnotationFlags>,
): boolean {
  if (tool.destructive === true || annotationFlags.destructive === true || annotationFlags.openWorld === true) {
    return false;
  }
  if (tool.readOnly !== true && annotationFlags.readOnly !== true) {
    return false;
  }

  const haystack = `${tool.selector} ${tool.serverName} ${tool.toolName} ${tool.description ?? ""}`.toLowerCase();
  return isFirefliesCodexMcpTool(tool) && haystack.includes("transcript") && haystack.includes("download");
}

export function classifyCodexMcpToolSafety(tool: CodexCatalogMcpTool): {
  allowed: boolean;
  reason?: string;
} {
  const combined = `${tool.serverName} ${tool.toolName} ${tool.description ?? ""}`;
  const annotationFlags = collectAnnotationFlags(tool.annotations);
  const firefliesTranscriptDownloadException = isNarrowReadOnlyFirefliesTranscriptDownloadTool(
    tool,
    annotationFlags,
  );
  const deniedNameTokens = findDeniedPolicyTokens(
    `${tool.serverName}/${tool.toolName}`,
    DENIED_TOOL_NAME_TOKENS,
  );
  if (
    deniedNameTokens.length > 0 &&
    !canUseFirefliesTranscriptDownloadException(deniedNameTokens, firefliesTranscriptDownloadException)
  ) {
    return {
      allowed: false,
      reason: `Codex MCP tool ${tool.selector} is blocked by v1 safety policy (tool name).`,
    };
  }

  const deniedDescriptionTokens = tool.description
    ? findDeniedPolicyTokens(tool.description, DENIED_DESCRIPTION_TOKENS)
    : [];
  if (
    deniedDescriptionTokens.length > 0 &&
    !canUseFirefliesTranscriptDownloadException(deniedDescriptionTokens, firefliesTranscriptDownloadException)
  ) {
    return {
      allowed: false,
      reason: `Codex MCP tool ${tool.selector} is blocked by v1 safety policy (description).`,
    };
  }

  if (hasDeniedPolicyToken(combined, DENIED_TOOL_NAME_TOKENS) && !tool.readOnly) {
    return {
      allowed: false,
      reason: `Codex MCP tool ${tool.selector} is blocked by v1 safety policy (metadata).`,
    };
  }

  if (annotationFlags.destructive === true || tool.destructive === true) {
    return {
      allowed: false,
      reason: `Codex MCP tool ${tool.selector} is marked destructive and blocked in v1.`,
    };
  }

  if (annotationFlags.openWorld === true) {
    return {
      allowed: false,
      reason: `Codex MCP tool ${tool.selector} declares open-world access and is blocked in v1.`,
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
