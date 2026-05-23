export const CURSOR_SDK_USAGE_ENTRY_TYPE = "swarm_cursor_sdk_usage";
export const CURSOR_SDK_PROVIDER_ID = "cursor-sdk";
export const CURSOR_SDK_USAGE_SOURCE = "cursor_sdk_on_delta_turn_ended";

export type CursorSdkUsageOutcome = "completed" | "cancelled" | "error" | "unknown";

export interface CursorSdkUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface CursorSdkUsageRecordV1 {
  version: 1;
  source: typeof CURSOR_SDK_USAGE_SOURCE;
  provider: typeof CURSOR_SDK_PROVIDER_ID;
  modelId: string;
  reasoningLevel: string | null;
  usage: CursorSdkUsageTotals;
  sdkRunId: string | null;
  sdkAgentId: string | null;
  providerStatus: string | null;
  runStatus: string | null;
  waitStatus: string | null;
  terminalStatus: string | null;
  outcome: CursorSdkUsageOutcome;
  capturedAt: string;
}

export interface ParsedCursorSdkUsageEntry {
  modelId: string;
  reasoningLevel: string | null;
  usage: CursorSdkUsageTotals;
  capturedAt: string | null;
  timestamp: string | null;
  providerStatus: string | null;
  runStatus: string | null;
  waitStatus: string | null;
  terminalStatus: string | null;
  outcome: CursorSdkUsageOutcome;
}

export function extractCursorSdkUsageFromDelta(update: unknown): CursorSdkUsageTotals | null {
  const object = readObject(update);
  if (!object || object.type !== "turn-ended") {
    return null;
  }

  const usage = readObject(object.usage) ?? readObject(readObject(object.turn)?.usage);
  return normalizeCursorSdkUsageComponents(usage);
}

export function normalizeCursorSdkUsageComponents(value: unknown): CursorSdkUsageTotals | null {
  const usage = readObject(value);
  if (!usage) {
    return null;
  }

  const input = normalizeTokenComponent(usage.inputTokens ?? usage.input_tokens);
  const output = normalizeTokenComponent(usage.outputTokens ?? usage.output_tokens);
  const cacheRead = normalizeTokenComponent(usage.cacheReadTokens ?? usage.cache_read_tokens);
  const cacheWrite = normalizeTokenComponent(usage.cacheWriteTokens ?? usage.cache_write_tokens);
  const total = input + output + cacheRead + cacheWrite;
  if (total <= 0) {
    return null;
  }

  return { input, output, cacheRead, cacheWrite, total };
}

export function parseCursorSdkUsageCustomEntry(entry: unknown): ParsedCursorSdkUsageEntry | null {
  const object = readObject(entry);
  if (!object || object.type !== "custom" || object.customType !== CURSOR_SDK_USAGE_ENTRY_TYPE) {
    return null;
  }

  const data = readObject(object.data);
  if (!data || data.version !== 1 || data.provider !== CURSOR_SDK_PROVIDER_ID) {
    return null;
  }

  const modelId = readNonEmptyString(data.modelId);
  const usage = normalizePersistedUsageComponents(data.usage);
  if (!modelId || !usage) {
    return null;
  }

  return {
    modelId,
    reasoningLevel: readNonEmptyString(data.reasoningLevel),
    usage,
    capturedAt: readNonEmptyString(data.capturedAt),
    timestamp: readNonEmptyString(object.timestamp),
    providerStatus: readNonEmptyString(data.providerStatus),
    runStatus: readNonEmptyString(data.runStatus),
    waitStatus: readNonEmptyString(data.waitStatus),
    terminalStatus: readNonEmptyString(data.terminalStatus),
    outcome: readCursorSdkUsageOutcome(data.outcome)
  };
}

function normalizePersistedUsageComponents(value: unknown): CursorSdkUsageTotals | null {
  const usage = readObject(value);
  if (!usage) {
    return null;
  }

  const input = normalizeTokenComponent(usage.input);
  const output = normalizeTokenComponent(usage.output);
  const cacheRead = normalizeTokenComponent(usage.cacheRead);
  const cacheWrite = normalizeTokenComponent(usage.cacheWrite);
  const total = input + output + cacheRead + cacheWrite;
  if (total <= 0) {
    return null;
  }

  return { input, output, cacheRead, cacheWrite, total };
}

function normalizeTokenComponent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readCursorSdkUsageOutcome(value: unknown): CursorSdkUsageOutcome {
  return value === "completed" || value === "cancelled" || value === "error" || value === "unknown"
    ? value
    : "unknown";
}
