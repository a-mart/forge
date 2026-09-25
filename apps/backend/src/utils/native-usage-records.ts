/** Provider counters, persisted separately from the zero-usage compatibility messages. */
export const NATIVE_USAGE_ENTRY_TYPE = "swarm_native_usage";
export type NativeUsageProvider = "codex-native" | "claude-native";
export interface NativeUsageTotals { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
export interface NativeUsageRecord {
  version: 1;
  provider: NativeUsageProvider;
  nativeSessionId: string;
  ownerAgentId?: string;
  /** Earlier native history may be recovered; this runtime's own snapshots are authoritative. */
  runtimeStartedAt?: string;
  /** Codex has one thread counter; Claude has one counter per reported model. */
  counterId: string;
  modelId: string;
  reasoningLevel: string | null;
  capturedAt: string;
  usage: NativeUsageTotals;
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
function totals(input: number, output: number, cacheRead: number, cacheWrite: number): NativeUsageTotals | null {
  const total = input + output + cacheRead + cacheWrite;
  return total > 0 && Number.isSafeInteger(total) ? { input, output, cacheRead, cacheWrite, total } : null;
}
export function normalizeCodexUsage(value: unknown): NativeUsageTotals | null {
  const u = object(value); if (!u) return null;
  const input = count(u.inputTokens ?? u.input_tokens);
  const cacheRead = Math.min(input, count(u.cachedInputTokens ?? u.cached_input_tokens));
  // Cached input and reasoning output are already included in Codex's respective totals.
  return totals(input - cacheRead, count(u.outputTokens ?? u.output_tokens), cacheRead, 0);
}
export function normalizeClaudeUsage(value: unknown): NativeUsageTotals | null {
  const u = object(value); if (!u) return null;
  return totals(count(u.inputTokens ?? u.input_tokens), count(u.outputTokens ?? u.output_tokens),
    count(u.cacheReadInputTokens ?? u.cache_read_input_tokens), count(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens));
}
export function parseNativeUsageEntry(value: unknown): NativeUsageRecord | null {
  const entry = object(value);
  if (entry?.type !== "custom" || entry.customType !== NATIVE_USAGE_ENTRY_TYPE) return null;
  const d = object(entry.data); const u = object(d?.usage);
  if (!d || d.version !== 1 || !u || (d.provider !== "codex-native" && d.provider !== "claude-native")) return null;
  const nativeSessionId = text(d.nativeSessionId), counterId = text(d.counterId), modelId = text(d.modelId), capturedAt = text(d.capturedAt);
  const usage = totals(count(u.input), count(u.output), count(u.cacheRead), count(u.cacheWrite));
  if (!nativeSessionId || !counterId || !modelId || !capturedAt || !Number.isFinite(Date.parse(capturedAt)) || !usage) return null;
  return { version: 1, provider: d.provider, nativeSessionId, counterId, modelId, capturedAt,
    ...(text(d.ownerAgentId) ? { ownerAgentId: text(d.ownerAgentId)! } : {}),
    ...(typeof d.runtimeStartedAt === "string" && Number.isFinite(Date.parse(d.runtimeStartedAt)) && Date.parse(d.runtimeStartedAt) <= Date.parse(capturedAt) ? { runtimeStartedAt: d.runtimeStartedAt } : {}),
    reasoningLevel: text(d.reasoningLevel), usage };
}

/** High-water counters deduplicate repeated notifications, restart, and copied fork history. */
export class NativeUsageAccumulator {
  private readonly counters = new Map<string, NativeUsageTotals>();
  consume(record: NativeUsageRecord): NativeUsageTotals | null {
    const key = JSON.stringify([record.provider, record.nativeSessionId, record.counterId]);
    const previous = this.counters.get(key);
    const u = record.usage;
    const delta = totals(Math.max(0, u.input - (previous?.input ?? 0)), Math.max(0, u.output - (previous?.output ?? 0)),
      Math.max(0, u.cacheRead - (previous?.cacheRead ?? 0)), Math.max(0, u.cacheWrite - (previous?.cacheWrite ?? 0)));
    if (delta) this.counters.set(key, {
      input: Math.max(u.input, previous?.input ?? 0), output: Math.max(u.output, previous?.output ?? 0),
      cacheRead: Math.max(u.cacheRead, previous?.cacheRead ?? 0), cacheWrite: Math.max(u.cacheWrite, previous?.cacheWrite ?? 0),
      total: (previous?.total ?? 0) + delta.total,
    });
    return delta;
  }
}

/** Model identity for reporting. Runtime selection remains a separate catalog concern. */
export function accountingModel(modelId: string, provider?: string): { modelId: string; provider: string } {
  const nativePrefix = ["claude-native/", "codex-native/"].find(p => modelId.startsWith(p));
  const p = provider ?? nativePrefix?.slice(0, -1) ?? "unknown";
  const prefix = nativePrefix ?? (["anthropic", "openai-codex"].includes(p) && modelId.startsWith(`${p}/`) ? `${p}/` : undefined);
  return { modelId: prefix ? modelId.slice(prefix.length) : modelId,
    provider: p === "claude-native" ? "anthropic" : p === "codex-native" ? "openai-codex" : p };
}
