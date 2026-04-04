import type { ClaudeSdkMessage } from "./claude-sdk-loader.js";
import type { AgentContextUsage } from "./types.js";

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

export function extractClaudeContextUsage(
  event: ClaudeSdkMessage,
  configuredModel?: string,
  configuredContextWindow?: number
): AgentContextUsage | undefined {
  const usageContainer = readObject((event as { modelUsage?: unknown }).modelUsage)
    ?? readObject((event as { usage?: unknown }).usage);
  if (!usageContainer) {
    return undefined;
  }

  const usageEntry = selectClaudeUsageEntry(usageContainer, configuredModel);
  if (!usageEntry) {
    return undefined;
  }

  const inputTokens = readFiniteNumber(usageEntry.inputTokens) ?? readFiniteNumber(usageEntry.input_tokens) ?? 0;
  const cacheReadInputTokens =
    readFiniteNumber(usageEntry.cacheReadInputTokens) ?? readFiniteNumber(usageEntry.cache_read_input_tokens) ?? 0;
  const cacheCreationInputTokens =
    readFiniteNumber(usageEntry.cacheCreationInputTokens)
    ?? readFiniteNumber(usageEntry.cache_creation_input_tokens)
    ?? 0;
  const outputTokens = readFiniteNumber(usageEntry.outputTokens) ?? readFiniteNumber(usageEntry.output_tokens) ?? 0;
  const contextWindow =
    readFiniteNumber(usageEntry.contextWindow)
    ?? readFiniteNumber(usageEntry.context_window)
    ?? readFiniteNumber(configuredContextWindow);

  if (contextWindow === undefined || contextWindow <= 0) {
    return undefined;
  }

  const tokens =
    Math.max(0, inputTokens)
    + Math.max(0, cacheReadInputTokens)
    + Math.max(0, cacheCreationInputTokens)
    + Math.max(0, outputTokens);

  return {
    tokens,
    contextWindow,
    percent: Math.max(0, Math.min(100, (tokens / contextWindow) * 100))
  };
}

function selectClaudeUsageEntry(
  usageContainer: Record<string, unknown>,
  configuredModel?: string
): Record<string, unknown> | undefined {
  if (isClaudeUsageEntryLike(usageContainer)) {
    return usageContainer;
  }

  const entries = Object.entries(usageContainer).filter(([, value]) => isClaudeUsageEntryLike(value));
  if (entries.length === 0) {
    return undefined;
  }

  if (configuredModel) {
    const normalizedConfiguredModel = configuredModel.trim().toLowerCase();
    const exactMatch = entries.find(([modelKey]) => modelKey.trim().toLowerCase() === normalizedConfiguredModel);
    if (exactMatch) {
      return exactMatch[1] as Record<string, unknown>;
    }
  }

  return entries
    .map(([, value]) => value as Record<string, unknown>)
    .sort((left, right) => totalClaudeUsageTokens(right) - totalClaudeUsageTokens(left))[0];
}

function isClaudeUsageEntryLike(value: unknown): value is Record<string, unknown> {
  const entry = readObject(value);
  if (!entry) {
    return false;
  }

  return (
    readFiniteNumber(entry.contextWindow ?? entry.context_window) !== undefined
    || readFiniteNumber(entry.inputTokens ?? entry.input_tokens) !== undefined
    || readFiniteNumber(entry.cacheReadInputTokens ?? entry.cache_read_input_tokens) !== undefined
    || readFiniteNumber(entry.cacheCreationInputTokens ?? entry.cache_creation_input_tokens) !== undefined
    || readFiniteNumber(entry.outputTokens ?? entry.output_tokens) !== undefined
  );
}

function totalClaudeUsageTokens(entry: Record<string, unknown>): number {
  return (
    (readFiniteNumber(entry.inputTokens) ?? readFiniteNumber(entry.input_tokens) ?? 0)
    + (readFiniteNumber(entry.cacheReadInputTokens) ?? readFiniteNumber(entry.cache_read_input_tokens) ?? 0)
    + (readFiniteNumber(entry.cacheCreationInputTokens) ?? readFiniteNumber(entry.cache_creation_input_tokens) ?? 0)
    + (readFiniteNumber(entry.outputTokens) ?? readFiniteNumber(entry.output_tokens) ?? 0)
  );
}
