import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { PhoenixObservabilityPrivacySettings } from "@forge/protocol";
import { createDefaultPhoenixObservabilitySettings } from "./observability-settings.js";

export interface RedactionStats {
  redactionMatches: number;
  contentTruncations: number;
}

export interface RedactedValue {
  value: string;
  stats: RedactionStats;
  originalLength: number;
  exportedLength: number;
  truncated: boolean;
}

const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "api_key",
  "authorization",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "password",
  "cookie",
  "set-cookie",
  "x-api-key",
  "openai_api_key",
  "anthropic_api_key",
  "cursor_api_key",
  "privatekey",
  "private_key",
]);

const BUILTIN_REDACTION_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxai-[A-Za-z0-9_-]{16,}\b/g,
  /\bkey_[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:OPENAI|ANTHROPIC|CURSOR|XAI)_API_KEY\s*=\s*[^\s]+/gi,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
];

export class ObservabilityRedactor {
  private readonly patterns: RegExp[];

  constructor(private readonly privacy: PhoenixObservabilityPrivacySettings = createDefaultPhoenixObservabilitySettings().privacy) {
    this.patterns = [
      ...BUILTIN_REDACTION_PATTERNS,
      ...privacy.extraRedactionPatterns.map((pattern) => new RegExp(pattern, "gi")),
    ];
  }

  redactAndCap(value: unknown, maxChars = this.privacy.maxContentChars): RedactedValue {
    const serialized = stringifyForExport(this.redactSensitiveObjectFields(value));
    const redacted = this.privacy.redactionEnabled ? this.applyStringRedactions(serialized) : { value: serialized, matches: 0 };
    const capped = capString(redacted.value, maxChars);
    return {
      value: capped.value,
      stats: {
        redactionMatches: redacted.matches,
        contentTruncations: capped.truncated ? 1 : 0,
      },
      originalLength: serialized.length,
      exportedLength: capped.value.length,
      truncated: capped.truncated,
    };
  }

  redactIdentifier(value: string): string {
    if (this.privacy.identifierMode === "raw") {
      return this.redactAndCap(value, this.privacy.maxAttributeChars).value;
    }

    return stableHash(value);
  }

  redactPath(value: string): string {
    if (this.privacy.pathMode === "raw") {
      return this.redactAndCap(redactHomePath(value), this.privacy.maxAttributeChars).value;
    }

    if (this.privacy.pathMode === "redacted") {
      return "[REDACTED_PATH]";
    }

    return `${basename(value)}#${stableHash(value)}`;
  }

  sanitizeAttributeValue(value: unknown): string | number | boolean | string[] {
    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return value.map((entry) => this.redactAndCap(entry, this.privacy.maxAttributeChars).value);
    }

    return this.redactAndCap(value, this.privacy.maxAttributeChars).value;
  }

  private redactSensitiveObjectFields(value: unknown, depth = 0): unknown {
    if (!this.privacy.redactionEnabled || depth > 20) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((entry) => this.redactSensitiveObjectFields(entry, depth + 1));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_FIELD_NAMES.has(normalizeFieldName(key))) {
        result[key] = "[REDACTED]";
        continue;
      }

      result[key] = this.redactSensitiveObjectFields(entry, depth + 1);
    }

    return result;
  }

  private applyStringRedactions(value: string): { value: string; matches: number } {
    let next = redactHomePath(value);
    let matches = 0;
    for (const pattern of this.patterns) {
      next = next.replace(pattern, () => {
        matches += 1;
        return "[REDACTED]";
      });
    }

    return { value: next, matches };
  }
}

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stringifyForExport(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function capString(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }

  const marker = `\n[TRUNCATED original_chars=${value.length} exported_chars=${maxChars}]`;
  const sliceLength = Math.max(0, maxChars - marker.length);
  return { value: `${value.slice(0, sliceLength)}${marker}`, truncated: true };
}

function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function redactHomePath(value: string): string {
  const home = process.env.HOME;
  if (!home) {
    return value;
  }

  return value.split(home).join("~");
}
