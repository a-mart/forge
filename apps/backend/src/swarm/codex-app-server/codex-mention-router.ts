export interface CodexMentionParseResult {
  routed: true;
  strippedText: string;
}

export interface CodexMentionNotRouted {
  routed: false;
}

export type CodexMentionRouteResult = CodexMentionParseResult | CodexMentionNotRouted;

/** Leading plain @Codex / [@Codex] sidecar turn (not tool selector). */
const LEADING_CODEX_SIDECAR_PATTERN =
  /^(?:@codex|\[@codex\])(?![-:\]])(?=\s|$)(?:\s([\s\S]*))?$/i;

/** Leading [@Codex:<selector>] manager tool hint. */
const LEADING_CODEX_BRACKET_TOOL_PATTERN = /^\[@codex:([^\]]+)\](?:\s+([\s\S]*))?$/i;

/** Leading @Codex -<selector> manager tool hint. */
const LEADING_CODEX_TOOL_PATTERN =
  /^(?:@codex|\[@codex\])\s*-\s*([^\s]+)(?:\s+([\s\S]*))?$/i;

const INLINE_CODEX_TOOL_PATTERN = /(?:@codex:([^\s\]]+)|\[@codex:([^\]]+)\])/gi;

export type CodexUserMessageRoute =
  | { kind: "none" }
  | { kind: "sidecar"; strippedText: string }
  | { kind: "manager_tool"; selectors: string[]; strippedText: string };

export function parseLeadingCodexMention(text: string): CodexMentionRouteResult {
  const classified = classifyCodexUserMessage(text);
  if (classified.kind === "sidecar") {
    return { routed: true, strippedText: classified.strippedText };
  }

  return { routed: false };
}

export function classifyCodexUserMessage(text: string): CodexUserMessageRoute {
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind: "none" };
  }

  const leadingBracketTool = trimmed.match(LEADING_CODEX_BRACKET_TOOL_PATTERN);
  if (leadingBracketTool) {
    const selector = normalizeCodexToolSelector(leadingBracketTool[1]);
    const remainder = (leadingBracketTool[2] ?? "").trim();
    const inlineSelectors = extractInlineCodexToolSelectors(trimmed);
    const selectors = uniqueSelectors([selector, ...inlineSelectors]);
    return { kind: "manager_tool", selectors, strippedText: remainder };
  }

  const leadingTool = trimmed.match(LEADING_CODEX_TOOL_PATTERN);
  if (leadingTool) {
    const selector = normalizeCodexToolSelector(leadingTool[1]);
    const remainder = (leadingTool[2] ?? "").trim();
    const inlineSelectors = extractInlineCodexToolSelectors(trimmed);
    const selectors = uniqueSelectors([selector, ...inlineSelectors]);
    return { kind: "manager_tool", selectors, strippedText: remainder };
  }

  const sidecarMatch = trimmed.match(LEADING_CODEX_SIDECAR_PATTERN);
  if (sidecarMatch) {
    return { kind: "sidecar", strippedText: (sidecarMatch[1] ?? "").trim() };
  }

  const inlineSelectors = extractInlineCodexToolSelectors(trimmed);
  if (inlineSelectors.length > 0) {
    return {
      kind: "manager_tool",
      selectors: inlineSelectors,
      strippedText: stripInlineCodexToolTokens(trimmed),
    };
  }

  return { kind: "none" };
}

export function extractInlineCodexToolSelectors(text: string): string[] {
  const selectors: string[] = [];
  for (const match of text.matchAll(INLINE_CODEX_TOOL_PATTERN)) {
    const raw = match[1] ?? match[2];
    if (!raw) {
      continue;
    }

    const normalized = normalizeCodexToolSelector(raw);
    if (normalized) {
      selectors.push(normalized);
    }
  }

  return uniqueSelectors(selectors);
}

export function stripInlineCodexToolTokens(text: string): string {
  return text
    .replace(INLINE_CODEX_TOOL_PATTERN, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function buildCodexToolMentionManagerGuidance(selectors: string[]): string {
  const quoted = selectors.map((entry) => `"${entry}"`).join(", ");
  return (
    `[Forge Codex tool mention] The user tagged Codex plugin/tool selector(s): ${quoted}. ` +
    "Plugin selectors authorize safe MCP tools within that plugin scope only. " +
    "Use list_codex_mcp_tools to see allowed tools for this turn, then call_codex_mcp_tool with arguments inferred from the conversation. " +
    "Do not start a Codex sidecar text turn unless the user explicitly asked for a full @Codex conversation."
  );
}

function normalizeCodexToolSelector(value: string): string {
  return value.trim().replace(/^:+/, "").replace(/:+$/, "");
}

function uniqueSelectors(selectors: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const selector of selectors) {
    const key = selector.toLowerCase();
    if (!selector || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(selector);
  }

  return result;
}

export function isBuilderWebCodexRoutingSurface(
  sourceContext: { channel?: string },
  sessionDescriptor: { sessionSurface?: string; collab?: unknown },
): boolean {
  if (sourceContext.channel !== "web") {
    return false;
  }

  if (sessionDescriptor.sessionSurface === "collab" || sessionDescriptor.collab) {
    return false;
  }

  return true;
}
