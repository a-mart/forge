export interface CodexMentionParseResult {
  routed: true;
  strippedText: string;
}

export interface CodexMentionNotRouted {
  routed: false;
}

export type CodexMentionRouteResult = CodexMentionParseResult | CodexMentionNotRouted;

const LEADING_CODEX_MENTION_PATTERN = /^(?:@codex|\[@codex\])(?=\s|$)(?:\s([\s\S]*))?$/i;

export function parseLeadingCodexMention(text: string): CodexMentionRouteResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { routed: false };
  }

  const match = trimmed.match(LEADING_CODEX_MENTION_PATTERN);
  if (!match) {
    return { routed: false };
  }

  return {
    routed: true,
    strippedText: (match[1] ?? "").trim(),
  };
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
