interface ShareTokenPayload {
  id: string;
  exp: number;
}

export type ShareTokenVerification =
  | { ok: true; id: string; expiresAtMs: number }
  | { ok: false; status: 404 | 410; id?: string; expiresAtMs?: number };

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export async function createShareToken(options: {
  shareId: string;
  expiresAtMs: number;
  secret: string;
}): Promise<string> {
  const payload: ShareTokenPayload = {
    id: options.shareId,
    exp: Math.floor(options.expiresAtMs / 1000)
  };
  const encodedPayload = base64UrlEncodeText(JSON.stringify(payload));
  const signature = await hmacSha256Base64Url(options.secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function verifyShareToken(token: string, secret: string, nowMs: number): Promise<ShareTokenVerification> {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    return { ok: false, status: 404 };
  }

  const expectedSignature = await hmacSha256Base64Url(secret, encodedPayload);
  if (!constantTimeEqualBase64Url(encodedSignature, expectedSignature)) {
    return { ok: false, status: 404 };
  }

  let payload: ShareTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecodeToText(encodedPayload)) as ShareTokenPayload;
  } catch {
    return { ok: false, status: 404 };
  }

  if (typeof payload.id !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.id)) {
    return { ok: false, status: 404 };
  }
  if (typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp) || payload.exp <= 0) {
    return { ok: false, status: 404 };
  }

  const expiresAtMs = payload.exp * 1000;
  if (expiresAtMs <= nowMs) {
    return { ok: false, status: 410, id: payload.id, expiresAtMs };
  }

  return { ok: true, id: payload.id, expiresAtMs };
}

async function hmacSha256Base64Url(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(payload));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function constantTimeEqualBase64Url(left: string, right: string): boolean {
  const leftBytes = base64UrlDecodeToBytesOrNull(left);
  const rightBytes = base64UrlDecodeToBytesOrNull(right);
  if (!leftBytes || !rightBytes || leftBytes.length !== rightBytes.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }

  return diff === 0;
}

function base64UrlEncodeText(value: string): string {
  return base64UrlEncodeBytes(TEXT_ENCODER.encode(value));
}

function base64UrlDecodeToText(value: string): string {
  return TEXT_DECODER.decode(base64UrlDecodeToBytes(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecodeToBytesOrNull(value: string): Uint8Array | undefined {
  try {
    return base64UrlDecodeToBytes(value);
  } catch {
    return undefined;
  }
}

function base64UrlDecodeToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error("Invalid base64url value.");
  }

  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
