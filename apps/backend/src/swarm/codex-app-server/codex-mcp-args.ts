import { redactCodexMcpSensitiveText } from "./codex-app-server-event-normalizer.js";

/** Upper bound for previews persisted in manager tool rows and chat details. */
export const MAX_CODEX_MCP_UI_PREVIEW_BYTES = 2048;

/** Upper bound for narrow read-only connector payloads returned to the scoped worker runtime. */
export const MAX_CODEX_MCP_MODEL_CONTENT_BYTES = 1024 * 1024;

const SENSITIVE_PAYLOAD_KEY_PATTERN =
  /(?:authorization|cookie|set[-_\s]?cookie|api[-_\s]?key|api[-_\s]?token|access[-_\s]?token|refresh[-_\s]?token|secret[-_\s]?key|secret|password|credentials?|token)/i;
const SENSITIVE_PAYLOAD_KEY_CANONICAL_PATTERN =
  /(?:authorization|cookie|setcookie|apikey|apitoken|accesstoken|refreshtoken|secretkey|secret|password|credentials?|token)/i;

export function boundCodexMcpToolUiPreview(value: string): string {
  return truncateBytesUtf8(
    redactCodexMcpSensitiveText(value),
    MAX_CODEX_MCP_UI_PREVIEW_BYTES,
  );
}

export function boundCodexMcpToolModelContent(value: string): {
  text: string;
  truncated: boolean;
} {
  const redacted = redactCodexMcpSensitiveText(value);
  const text = truncateBytesUtf8(redacted, MAX_CODEX_MCP_MODEL_CONTENT_BYTES);
  return {
    text,
    truncated: Buffer.byteLength(redacted, "utf8") > MAX_CODEX_MCP_MODEL_CONTENT_BYTES,
  };
}

export function stringifyRedactedCodexMcpPayload(value: unknown): string {
  try {
    return JSON.stringify(redactCodexMcpPayload(value));
  } catch {
    return '{"note":"Unable to serialize Codex MCP tool payload."}';
  }
}

function redactCodexMcpPayload(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  if (depth > 32) {
    return "[truncated-depth]";
  }

  if (typeof value === "string") {
    return redactCodexMcpSensitiveText(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactCodexMcpPayload(entry, seen, depth + 1));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitivePayloadKey(key)) {
      redacted[key] = "[redacted]";
      continue;
    }

    redacted[key] = redactCodexMcpPayload(nested, seen, depth + 1);
  }
  return redacted;
}

function isSensitivePayloadKey(key: string): boolean {
  const canonical = key.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
  return SENSITIVE_PAYLOAD_KEY_PATTERN.test(key) || SENSITIVE_PAYLOAD_KEY_CANONICAL_PATTERN.test(canonical);
}

export function formatCodexMcpToolFailureMessage(message: string, maxBytes = 1024): string {
  const trimmed = message.trim();
  return truncateBytesUtf8(
    redactCodexMcpSensitiveText(trimmed.length > 0 ? trimmed : "Codex MCP tool call failed"),
    maxBytes,
  );
}

export function assertCodexMcpToolArgsSerializable(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  path = "",
): void {
  if (value === null || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    throw new Error(`Codex tool arguments contain a cycle at ${path || "root"}`);
  }

  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertCodexMcpToolArgsSerializable(entry, seen, `${path}[${index}]`);
    });
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    assertCodexMcpToolArgsSerializable(nested, seen, path ? `${path}.${key}` : key);
  }
}

export function boundCodexMcpToolArgs(
  args: Record<string, unknown> | undefined,
  maxBytes: number,
): Record<string, unknown> {
  const payload = args ?? {};
  assertCodexMcpToolArgsSerializable(payload);

  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new Error("Codex tool arguments must be JSON-serializable");
  }

  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error("Codex tool arguments exceed the size limit");
  }

  return JSON.parse(serialized) as Record<string, unknown>;
}

export function truncateBytesUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  const targetBytes = Math.max(0, maxBytes - ellipsisBytes);
  let slice = value;

  while (slice.length > 0 && Buffer.byteLength(slice, "utf8") > targetBytes) {
    slice = slice.slice(0, -1);
  }

  return `${slice}${ellipsis}`;
}
