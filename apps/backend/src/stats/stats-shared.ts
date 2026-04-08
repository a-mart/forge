import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

export const STATS_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

export interface ExtractedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface JsonlScanContext {
  thinkingLevel: string | null;
}

export async function scanJsonlFile(
  path: string,
  onEntry: (entry: unknown, context: JsonlScanContext) => void,
  options: { throwOnError?: boolean } = {}
): Promise<void> {
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    const reader = createInterface({
      input: stream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    let thinkingLevel: string | null = null;

    try {
      for await (const line of reader) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (isRecord(parsed)) {
            const thinkingLevelChange = extractThinkingLevelChange(parsed);
            if (thinkingLevelChange !== null) {
              thinkingLevel = thinkingLevelChange;
            }
          }

          onEntry(parsed, { thinkingLevel });
        } catch {
          // ignore malformed lines
        }
      }
    } finally {
      reader.close();
    }
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }
    if (options.throwOnError) {
      throw error;
    }
  }
}

export async function readJsonFileOrNull<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }
    return null;
  }
}

export async function listDirectoryNames(
  path: string,
  options: { throwOnError?: boolean } = {}
): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }
    if (options.throwOnError) {
      throw error;
    }
    return [];
  }
}

export async function listFileNames(
  path: string,
  options: { throwOnError?: boolean } = {}
): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }
    if (options.throwOnError) {
      throw error;
    }
    return [];
  }
}

export function extractUsage(value: unknown): ExtractedUsage | null {
  if (!isRecord(value)) {
    return null;
  }

  const input = toSafeNumber(value.input ?? value.input_tokens);
  const output = toSafeNumber(value.output ?? value.output_tokens);
  const cacheRead = toSafeNumber(value.cacheRead ?? value.cache_read_input_tokens ?? value.cached_tokens);
  const cacheWrite = toSafeNumber(value.cacheWrite ?? value.cache_creation_input_tokens);
  const total = toSafeNumber(value.totalTokens, input + output + cacheRead + cacheWrite);

  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && total === 0) {
    return null;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
  };
}

export function extractReasoningLevel(message: unknown, fallbackThinkingLevel: string | null): string {
  if (!isRecord(message)) {
    return fallbackThinkingLevel ?? "default";
  }

  const explicit =
    normalizeReasoningLevel(message.reasoningLevel) ??
    normalizeReasoningLevel(message.thinkingLevel) ??
    normalizeReasoningLevel(message.reasoning_effort) ??
    normalizeReasoningLevel(message.reasoningEffort) ??
    normalizeReasoningLevel(message.reasoning);

  return explicit ?? fallbackThinkingLevel ?? "default";
}

export function extractThinkingLevelChange(entry: Record<string, unknown>): string | null {
  if (entry.type === "thinking_level_change") {
    return normalizeReasoningLevel(entry.thinkingLevel);
  }

  if (entry.type === "reasoning_level_change") {
    return normalizeReasoningLevel(entry.reasoningLevel);
  }

  return null;
}

export function toTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? Math.round(value) : Math.round(value * 1000);
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function normalizeReasoningLevel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function toSafeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return fallback;
}
