import type { ConversationImageAttachment } from "../types.js";

export function extractMessageStopReason(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  return typeof stopReason === "string" ? stopReason : undefined;
}

export function extractMessageErrorMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
  if (typeof errorMessage !== "string") {
    return undefined;
  }

  const trimmed = errorMessage.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function hasMessageErrorMessageField(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(message, "errorMessage");
}

const GENERIC_PROVIDER_ERROR_MESSAGES = new Set([
  "provider returned error",
  "provider error",
  "error",
  "unknown error"
]);

export function normalizeProviderErrorMessage(errorMessage: string | undefined): string | undefined {
  if (!errorMessage) {
    return undefined;
  }

  const trimmed = errorMessage.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const statusMatch = /^(\d{3})(?:\s*:|\b)/.exec(trimmed);
  const statusCode = statusMatch?.[1];

  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    const jsonCandidate = trimmed.slice(jsonStart);
    try {
      const parsed = JSON.parse(jsonCandidate) as unknown;
      const nestedMessage = extractNestedProviderErrorMessage(parsed);
      if (nestedMessage) {
        return boundProviderErrorMessage(prefixHttpStatus(nestedMessage, statusCode));
      }
    } catch {
      // fall through to regex and plain-text handling.
    }
  }

  const overflowMatch = /prompt is too long:[^"}\n]+/i.exec(trimmed);
  if (overflowMatch?.[0]) {
    return overflowMatch[0];
  }

  return boundProviderErrorMessage(trimmed);
}

export function isStrictContextOverflowMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return /\bprompt is too long\b/i.test(message) || /\bmaximum context length\b/i.test(message);
}

export function isAbortLikeErrorMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return (
    /\brequest was aborted\b/i.test(message) ||
    /\boperation was aborted\b/i.test(message) ||
    /\baborterror\b/i.test(message) ||
    /^aborted\.?$/i.test(message)
  );
}

export function isLocalRuntimeShutdownErrorMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  const normalized = message.replace(/\s+/g, " ").trim();
  return (
    /^(?:request was aborted|operation was aborted|aborterror|aborted)\.?$/i.test(normalized) ||
    /^agent \S+ is terminated\.?$/i.test(normalized) ||
    /^claude query session is terminated\.?$/i.test(normalized)
  );
}

export function extractRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const maybeRole = (message as { role?: unknown }).role;
  return typeof maybeRole === "string" ? maybeRole : undefined;
}

export function extractMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const maybeText = item as { type?: unknown; text?: unknown };
      return maybeText.type === "text" && typeof maybeText.text === "string" ? maybeText.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text.length > 0 ? text : undefined;
}

export function extractMessageImageAttachments(message: unknown): ConversationImageAttachment[] {
  if (!message || typeof message !== "object") {
    return [];
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }

  const attachments: ConversationImageAttachment[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const maybeImage = item as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (maybeImage.type !== "image") {
      continue;
    }

    if (typeof maybeImage.mimeType !== "string" || !maybeImage.mimeType.startsWith("image/")) {
      continue;
    }

    if (typeof maybeImage.data !== "string" || maybeImage.data.length === 0) {
      continue;
    }

    attachments.push({
      mimeType: maybeImage.mimeType,
      data: maybeImage.data
    });
  }

  return attachments;
}

function extractNestedProviderErrorMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const nestedError =
    record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined;
  const metadata =
    record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : undefined;

  const candidates = [
    parseErrorMessageCandidate(nestedError?.message),
    parseErrorMessageCandidate(metadata?.raw),
    parseErrorMessageCandidate(record.message),
    parseErrorMessageCandidate(record.error)
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => !isGenericProviderErrorMessage(candidate)) ?? candidates[0];
}

function isGenericProviderErrorMessage(message: string | undefined): boolean {
  if (!message) {
    return true;
  }

  return GENERIC_PROVIDER_ERROR_MESSAGES.has(message.replace(/\s+/g, " ").trim().toLowerCase());
}

function prefixHttpStatus(message: string, statusCode: string | undefined): string {
  if (!statusCode || message.includes(statusCode)) {
    return message;
  }

  return `HTTP ${statusCode}: ${message}`;
}

function boundProviderErrorMessage(message: string): string {
  return message.length > 240 ? previewForLog(message, 240) : message;
}

function parseErrorMessageCandidate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  return normalized.length > 0 ? normalized : undefined;
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
