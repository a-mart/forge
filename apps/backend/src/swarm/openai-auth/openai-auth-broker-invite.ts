import type { OpenAIBrokerInvitePayload } from "@forge/protocol";

const INVITE_FRAGMENT_KEY = "forge_auth_broker";
const TOKEN_LIKE_INPUT_PATTERN = /^(?:Bearer\s+)?(?:fop_|sk-)[A-Za-z0-9._~+\-/]+=*$/i;
const JWT_LIKE_INPUT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export class OpenAIAuthBrokerInviteParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIAuthBrokerInviteParseError";
  }
}

export interface ParsedOpenAIAuthBrokerInvite {
  brokerUrl: string;
  brokerId?: string;
  inviteId: string;
  secret: string;
}

export function parseOpenAIAuthBrokerInvite(input: unknown): ParsedOpenAIAuthBrokerInvite {
  const payload = parseInvitePayload(input);
  return normalizeInvitePayload(payload);
}

export function isLocalOrDevBrokerUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost"
    || host === "::1"
    || host === "0.0.0.0"
    || host.startsWith("127.")
    || host.endsWith(".localhost");
}

function parseInvitePayload(input: unknown): unknown {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new OpenAIAuthBrokerInviteParseError("Paste a Forge Auth broker invite setup link or invite JSON.");
    }
    if (looksLikeRawToken(trimmed)) {
      throw new OpenAIAuthBrokerInviteParseError("Paste a Forge Auth broker invite setup link, not a broker token.");
    }
    if (/^https?:\/\//i.test(trimmed)) {
      return parseInviteUrl(trimmed);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      throw new OpenAIAuthBrokerInviteParseError("Forge Auth broker invite links must use http(s).");
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new OpenAIAuthBrokerInviteParseError("Paste a valid Forge Auth broker invite setup link or invite JSON.");
    }
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input;
  }

  throw new OpenAIAuthBrokerInviteParseError("Paste a Forge Auth broker invite setup link or invite JSON.");
}

function parseInviteUrl(rawUrl: string): unknown {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OpenAIAuthBrokerInviteParseError("Forge Auth broker invite link is not a valid URL.");
  }
  assertAllowedBrokerUrl(url);

  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const params = new URLSearchParams(hash);
  const encoded = params.get(INVITE_FRAGMENT_KEY);
  if (!encoded) {
    throw new OpenAIAuthBrokerInviteParseError("Forge Auth broker invite link is missing its setup fragment.");
  }

  const payload = decodeBase64UrlJson(encoded);
  const brokerUrlValue = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { brokerUrl?: unknown }).brokerUrl
    : undefined;
  if (typeof brokerUrlValue === "string") {
    try {
      const brokerUrl = new URL(brokerUrlValue);
      if (brokerUrl.origin !== url.origin) {
        throw new OpenAIAuthBrokerInviteParseError("Forge Auth broker invite link does not match its broker URL.");
      }
    } catch (error) {
      if (error instanceof OpenAIAuthBrokerInviteParseError) throw error;
    }
  }
  return payload;
}

function normalizeInvitePayload(payload: unknown): ParsedOpenAIAuthBrokerInvite {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new OpenAIAuthBrokerInviteParseError("Forge Auth broker invite payload must be a JSON object.");
  }

  const record = payload as OpenAIBrokerInvitePayload & Record<string, unknown>;
  if (record.forge_auth_broker !== undefined) {
    return normalizeInvitePayload(decodeBase64UrlJson(requireString(record.forge_auth_broker, "forge_auth_broker")));
  }
  if (record.v !== 1) {
    throw new OpenAIAuthBrokerInviteParseError("Unsupported Forge Auth broker invite version.");
  }

  assertSupportedProviders(record);
  const brokerUrl = normalizeBrokerUrl(requireString(record.brokerUrl, "brokerUrl"));
  const inviteId = requireString(record.inviteId, "inviteId");
  const secret = requireString(record.secret, "secret");
  const brokerId = typeof record.brokerId === "string" && record.brokerId.trim() ? sanitizeShortText(record.brokerId, "brokerId") : undefined;

  return {
    brokerUrl,
    ...(brokerId ? { brokerId } : {}),
    inviteId: sanitizeShortText(inviteId, "inviteId"),
    secret: sanitizeShortText(secret, "secret"),
  };
}

function assertSupportedProviders(record: Record<string, unknown>): void {
  const providers = new Set<string>();
  if (typeof record.provider === "string") providers.add(record.provider);
  if (Array.isArray(record.providers)) {
    for (const provider of record.providers) {
      if (typeof provider === "string") providers.add(provider);
    }
  }
  if (Array.isArray(record.grants)) {
    for (const grant of record.grants) {
      if (grant && typeof grant === "object" && typeof (grant as { provider?: unknown }).provider === "string") {
        providers.add((grant as { provider: string }).provider);
      }
    }
  }

  for (const provider of providers) {
    if (provider !== "openai-codex") {
      throw new OpenAIAuthBrokerInviteParseError("Forge Auth broker invites currently support OpenAI/Codex only.");
    }
  }
}

function normalizeBrokerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpenAIAuthBrokerInviteParseError("Forge Auth broker invite brokerUrl is not a valid URL.");
  }
  assertAllowedBrokerUrl(url);
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function assertAllowedBrokerUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpenAIAuthBrokerInviteParseError("Forge Auth broker invite URLs must use http(s).");
  }
  if (url.protocol === "http:" && !isLocalOrDevBrokerUrl(url)) {
    throw new OpenAIAuthBrokerInviteParseError("Forge Auth broker invite URLs must use HTTPS unless the broker is localhost.");
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new OpenAIAuthBrokerInviteParseError(`Forge Auth broker invite is missing ${field}.`);
  }
  return value.trim();
}

function sanitizeShortText(value: string, field: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!normalized) {
    throw new OpenAIAuthBrokerInviteParseError(`Forge Auth broker invite is missing ${field}.`);
  }
  if (normalized.length > 512) {
    throw new OpenAIAuthBrokerInviteParseError(`Forge Auth broker invite ${field} is too long.`);
  }
  return normalized;
}

function decodeBase64UrlJson(encoded: string): unknown {
  try {
    const decoded = Buffer.from(decodeURIComponent(encoded), "base64url").toString("utf8");
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new OpenAIAuthBrokerInviteParseError("Forge Auth broker invite fragment is invalid.");
  }
}

function looksLikeRawToken(value: string): boolean {
  return TOKEN_LIKE_INPUT_PATTERN.test(value) || JWT_LIKE_INPUT_PATTERN.test(value);
}

