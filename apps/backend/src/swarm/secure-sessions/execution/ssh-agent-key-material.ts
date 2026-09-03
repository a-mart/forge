import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

const OPENSSH_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_END = "-----END OPENSSH PRIVATE KEY-----";
const OPENSSH_AUTH_MAGIC = Buffer.from("openssh-key-v1\0", "ascii");
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/u;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

/**
 * Copies host-side ssh-agent material and repairs only a structurally
 * recognizable OpenSSH private-key PEM envelope. Other formats and malformed
 * material remain byte-for-byte unchanged for ssh-add to accept or reject.
 */
export function normalizeSshAgentKeyMaterial(value: Uint8Array): Buffer {
  const copy = Buffer.from(value);
  const text = decodeExactUtf8(copy);
  const normalized = text === null ? null : normalizeOpenSshPrivateKeyPem(text);
  if (normalized === null) {
    return copy;
  }

  const normalizedBytes = Buffer.from(normalized, "utf8");
  if (normalizedBytes.equals(copy)) {
    normalizedBytes.fill(0);
    return copy;
  }
  copy.fill(0);
  return normalizedBytes;
}

function decodeExactUtf8(value: Buffer): string | null {
  if (value.byteLength === 0) {
    return null;
  }
  try {
    const text = UTF8_DECODER.decode(value);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

function normalizeOpenSshPrivateKeyPem(text: string): string | null {
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines[0] !== OPENSSH_BEGIN || lines.at(-1) !== OPENSSH_END) {
    return null;
  }

  const payloadLines = lines.slice(1, -1);
  if (
    payloadLines.length === 0
    || payloadLines.some((line) => !BASE64_LINE.test(line))
  ) {
    return null;
  }

  const payload = payloadLines.join("");
  if (!CANONICAL_BASE64.test(payload)) {
    return null;
  }

  const decoded = Buffer.from(payload, "base64");
  try {
    if (
      decoded.byteLength <= OPENSSH_AUTH_MAGIC.byteLength
      || !decoded.subarray(0, OPENSSH_AUTH_MAGIC.byteLength).equals(OPENSSH_AUTH_MAGIC)
    ) {
      return null;
    }
  } finally {
    decoded.fill(0);
  }

  return `${lines.join("\n")}\n`;
}
