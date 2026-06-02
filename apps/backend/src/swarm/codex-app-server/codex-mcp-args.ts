import { redactCodexMcpSensitiveText } from "./codex-app-server-event-normalizer.js";

/** Upper bound for previews persisted in manager tool rows and chat details. */
export const MAX_CODEX_MCP_UI_PREVIEW_BYTES = 2048;

export function boundCodexMcpToolUiPreview(value: string): string {
  return truncateBytesUtf8(
    redactCodexMcpSensitiveText(value),
    MAX_CODEX_MCP_UI_PREVIEW_BYTES,
  );
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
