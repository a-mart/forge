import type {
  RuntimeImageAttachment,
  RuntimeUserMessage,
  RuntimeUserMessageInput
} from "../runtime-contracts.js";

export function normalizeRuntimeUserMessage(input: RuntimeUserMessageInput): RuntimeUserMessage {
  if (typeof input === "string") {
    return {
      text: input,
      images: []
    };
  }

  const text = typeof input.text === "string" ? input.text : "";

  return {
    text,
    images: normalizeRuntimeImageAttachments(input.images)
  };
}

export function normalizeRuntimeImageAttachments(
  images: RuntimeUserMessage["images"]
): RuntimeImageAttachment[] {
  if (!images || images.length === 0) {
    return [];
  }

  const normalized: RuntimeImageAttachment[] = [];

  for (const image of images) {
    if (!image || typeof image !== "object") {
      continue;
    }

    const mimeType = typeof image.mimeType === "string" ? image.mimeType.trim() : "";
    const data = typeof image.data === "string" ? image.data.trim() : "";

    if (!mimeType || !mimeType.startsWith("image/") || !data) {
      continue;
    }

    normalized.push({
      mimeType,
      data
    });
  }

  return normalized;
}

export function buildMessageKey(text: string, images: RuntimeImageAttachment[]): string | undefined {
  const normalizedText = text.trim();
  const normalizedImages = normalizeRuntimeImageAttachments(images);

  if (!normalizedText && normalizedImages.length === 0) {
    return undefined;
  }

  const imageKey = normalizedImages
    .map((image) => `${image.mimeType}:${image.data.length}:${image.data.slice(0, 24)}`)
    .join(",");

  return `text=${normalizedText}|images=${imageKey}`;
}

export function buildRuntimeMessageKey(message: RuntimeUserMessage): string {
  return buildMessageKey(message.text, message.images ?? []) ?? "text=|images=";
}

export function extractMessageKeyFromRuntimeContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return buildMessageKey(content, []);
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts: string[] = [];
  const images: RuntimeImageAttachment[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const typed = item as {
      type?: unknown;
      text?: unknown;
      mimeType?: unknown;
      data?: unknown;
    };

    if (typed.type === "text" && typeof typed.text === "string") {
      textParts.push(typed.text);
      continue;
    }

    if (
      typed.type === "image" &&
      typeof typed.mimeType === "string" &&
      typeof typed.data === "string"
    ) {
      images.push({
        mimeType: typed.mimeType,
        data: typed.data
      });
    }
  }

  return buildMessageKey(textParts.join("\n"), images);
}

export function consumePendingDeliveryByMessageKey<T extends { messageKey: string }>(
  pendingDeliveries: T[],
  messageKey: string
): T | undefined {
  if (pendingDeliveries.length === 0) {
    return undefined;
  }

  const first = pendingDeliveries[0];
  if (first.messageKey === messageKey) {
    pendingDeliveries.shift();
    return first;
  }

  const index = pendingDeliveries.findIndex((item) => item.messageKey === messageKey);
  if (index >= 0) {
    const [removed] = pendingDeliveries.splice(index, 1);
    return removed;
  }

  return undefined;
}

export function normalizeRuntimeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

const QUOTA_OR_RATE_LIMIT_PATTERNS = [
  /\busage limit\b/i,
  /\bquota\b/i,
  /\brate[\s-]?limit\b/i,
  /\btoo many requests\b/i,
  /\brequests per (minute|second|hour|day)\b/i,
  /\bresource exhausted\b/i,
  /\boverloaded_error\b/i,
  /^\s*429\b/i,
  /\b429\s+too many requests\b/i,
  /\b(?:status|http|code|error)\s*[:=]?\s*429\b/i,
  /^\s*529\b/i,
  /\b(?:status|http|code|error)\s*[:=]?\s*529\b/i,
  /\b402\s+payment required\b/i,
  /\b(?:status|http|code|error)\s*[:=]?\s*402\b/i,
  /\bpayment required\b/i,
  /\binsufficient.{0,20}funds?\b/i
];

const DURATION_RETRY_AFTER_PATTERN =
  /\b(?:in|after)\s*~?\s*(\d+(?:\.\d+)?)\s*(ms|msec|msecs|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i;
const RETRY_AT_TIMESTAMP_PATTERN = /\b(?:at|until)\s*<?([^>\n]+)>?/gi;
const RETRY_AFTER_SECONDS_HEADER_PATTERN =
  /(?:^|[\s,;])retry[-\s]?after\s*[:=]\s*(\d+(?:\.\d+)?)\b/i;

export interface RuntimeCapacityErrorClassification {
  isQuotaOrRateLimit: boolean;
  retryAfterMs?: number;
}

export function classifyRuntimeCapacityError(
  errorMessage: string | undefined,
  options?: { nowMs?: number }
): RuntimeCapacityErrorClassification {
  const normalized = normalizeRuntimeErrorMessage(errorMessage);
  if (!normalized) {
    return { isQuotaOrRateLimit: false };
  }

  const isQuotaOrRateLimit = QUOTA_OR_RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(normalized));
  if (!isQuotaOrRateLimit) {
    return { isQuotaOrRateLimit: false };
  }

  const retryAfterMs = parseRetryAfterMsFromErrorMessage(normalized, options?.nowMs);
  return retryAfterMs === undefined
    ? { isQuotaOrRateLimit }
    : {
        isQuotaOrRateLimit,
        retryAfterMs
      };
}

export function parseRetryAfterMsFromErrorMessage(
  errorMessage: string | undefined,
  nowMs = Date.now()
): number | undefined {
  const normalized = normalizeRuntimeErrorMessage(errorMessage);
  if (!normalized) {
    return undefined;
  }

  const durationMatch = DURATION_RETRY_AFTER_PATTERN.exec(normalized);
  if (durationMatch) {
    const amount = Number.parseFloat(durationMatch[1]);
    const unit = durationMatch[2]?.toLowerCase();
    const unitMs = unit ? toDurationUnitMs(unit) : undefined;
    if (Number.isFinite(amount) && amount > 0 && unitMs !== undefined) {
      return Math.round(amount * unitMs);
    }
  }

  const retryAtMs = parseRetryAtTimestampMs(normalized, nowMs);
  if (retryAtMs !== undefined) {
    return retryAtMs;
  }

  const retryAfterSecondsHeader = RETRY_AFTER_SECONDS_HEADER_PATTERN.exec(normalized);
  if (retryAfterSecondsHeader) {
    const seconds = Number.parseFloat(retryAfterSecondsHeader[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.round(seconds * 1_000);
    }
  }

  return undefined;
}

function parseRetryAtTimestampMs(message: string, nowMs: number): number | undefined {
  RETRY_AT_TIMESTAMP_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null = RETRY_AT_TIMESTAMP_PATTERN.exec(message);
  while (match) {
    const rawCandidate = match[1] ?? "";
    const normalizedCandidate = normalizeTimestampCandidate(rawCandidate);
    const parsedTimestampMs = parseTimestampCandidate(normalizedCandidate);

    if (parsedTimestampMs !== undefined && parsedTimestampMs > nowMs) {
      return parsedTimestampMs - nowMs;
    }

    match = RETRY_AT_TIMESTAMP_PATTERN.exec(message);
  }

  return undefined;
}

function normalizeTimestampCandidate(rawCandidate: string): string {
  return rawCandidate
    .split(/[,;\n]/, 1)[0]
    .replace(/^[`'"\s<]+/, "")
    .replace(/[`'"\s>.!?)]+$/, "")
    .trim();
}

function parseTimestampCandidate(candidate: string): number | undefined {
  if (!candidate) {
    return undefined;
  }

  if (/^\d{13}$/.test(candidate)) {
    const epochMs = Number.parseInt(candidate, 10);
    return Number.isFinite(epochMs) ? epochMs : undefined;
  }

  if (/^\d{10}$/.test(candidate)) {
    const epochSeconds = Number.parseInt(candidate, 10);
    return Number.isFinite(epochSeconds) ? epochSeconds * 1_000 : undefined;
  }

  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toDurationUnitMs(unit: string): number | undefined {
  switch (unit) {
    case "ms":
    case "msec":
    case "msecs":
    case "millisecond":
    case "milliseconds":
      return 1;

    case "s":
    case "sec":
    case "secs":
    case "second":
    case "seconds":
      return 1_000;

    case "m":
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return 60_000;

    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return 3_600_000;

    case "d":
    case "day":
    case "days":
      return 86_400_000;

    default:
      return undefined;
  }
}

function normalizeRuntimeErrorMessage(errorMessage: string | undefined): string | undefined {
  if (typeof errorMessage !== "string") {
    return undefined;
  }

  const normalized = errorMessage.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
