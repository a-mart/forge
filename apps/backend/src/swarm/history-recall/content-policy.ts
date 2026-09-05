import type { HistoryEntryKind } from "@forge/protocol";

export const MAX_INDEX_TEXT_CHARS = 32_768;
export const MAX_SNIPPET_CHARS = 240;
export const MAX_READ_CHARS = 20_000;
export const DEFAULT_READ_CHARS = 4_000;
export const MAX_READ_RESPONSE_CHARS = 20_000;
export const MAX_LINE_BYTES = 1_048_576;
export const OVERSIZED_LINE_WARNING = `JSONL row exceeds the ${MAX_LINE_BYTES}-byte line limit and was not fully read.`;

const SECRET_KEY_PATTERN = /secret|password|passwd|token|api[_-]?key|authorization|credential|private[_-]?key|askpass/i;
const SECRET_TOOL_PATTERN = /secret|password|token|credential|askpass|ssh.?agent|secure.?session|vault/i;
const BASE64_LIKE = /^[A-Za-z0-9+/=\s]{80,}$/;

export function isSecretToolName(toolName: string | undefined): boolean {
  return typeof toolName === "string" && SECRET_TOOL_PATTERN.test(toolName);
}

export function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}

export function redactStructuredValue(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    if (value.length > 4000 && BASE64_LIKE.test(value)) {
      return `[binary omitted: ${value.length} chars]`;
    }
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((entry) => redactStructuredValue(entry, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "data" && typeof entry === "string" && entry.length > 80) {
      redacted[key] = "[binary payload omitted]";
      continue;
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      redacted[key] = "[secret value omitted]";
      continue;
    }
    redacted[key] = redactStructuredValue(entry, depth + 1);
  }
  return redacted;
}

export function summarizeAttachments(attachments: unknown, preserveFormatting: boolean): string {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }
    const record = attachment as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const fileName = typeof record.fileName === "string" ? record.fileName : undefined;
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
    const fileRef = typeof record.fileRef === "string"
      ? record.fileRef
      : typeof record.filePath === "string"
        ? record.filePath
        : undefined;
    if (type === "text" && typeof record.text === "string") {
      parts.push(preserveFormatting ? record.text : clipText(record.text, 4000));
      continue;
    }
    const label = [fileName, mimeType ? `(${mimeType})` : undefined, fileRef ? `ref:${fileRef}` : undefined]
      .filter(Boolean)
      .join(" ");
    parts.push(`[attachment${label ? `: ${label}` : ""}]`);
  }
  return parts.join(preserveFormatting ? "\n" : " ");
}

export function ftsSafeText(text: string): string {
  return text.replace(/[A-Za-z0-9_]{80,}/g, (token) => token.match(/.{1,64}/g)?.join(" ") ?? token.slice(0, 64));
}

export function expandCodeTokens(text: string): string {
  const extras = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_./:-]{0,63}/g)) {
    const token = match[0];
    extras.add(token);
    for (const part of token.split(/[./:_-]+/)) {
      if (!part) {
        continue;
      }
      extras.add(part);
      extras.add(part.toLowerCase());
      for (const camel of splitCamelCase(part)) {
        if (camel.length > 1) {
          extras.add(camel);
          extras.add(camel.toLowerCase());
        }
      }
    }
  }
  if (extras.size === 0) {
    return text;
  }
  return `${text}\n${[...extras].join(" ")}`;
}

export function contentKeyForRecord(kind: HistoryEntryKind, role: string | undefined, toolName: string | undefined, text: string, toolCallId?: string): string {
  if ((kind === "tool_call" || kind === "tool_result") && toolCallId) {
    return `${kind}:${toolCallId}`;
  }
  const normalized = normalizeSearchText(text).toLowerCase();
  return `${kind}:${role ?? ""}:${toolName ?? ""}:${hash32(normalized)}`;
}

export function buildCenteredSnippet(text: string, terms: readonly string[], maxChars = MAX_SNIPPET_CHARS): string {
  const compact = normalizeSearchText(text);
  if (compact.length <= maxChars) {
    return compact;
  }
  const haystack = compact.toLowerCase();
  let center = 0;
  for (const term of terms) {
    const needle = term.toLowerCase().replace(/\*$/, "");
    if (needle.length < 2) {
      continue;
    }
    const index = haystack.indexOf(needle);
    if (index >= 0) {
      center = index;
      break;
    }
  }
  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, center - half);
  const end = Math.min(compact.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < compact.length ? "…" : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function splitCamelCase(token: string): string[] {
  return token.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
}

function hash32(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
