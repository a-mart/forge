import {
  SIDEBAR_HISTORY_CACHE_STATE_METRIC,
  type HistoryCacheState,
  type HistorySource
} from "../../stats/sidebar-perf-metrics.js";
import type { SidebarConversationHistoryDiagnostics, SidebarPerfRecorder } from "../../stats/sidebar-perf-types.js";

export function createConversationHistoryDiagnostics(
  options: Partial<SidebarConversationHistoryDiagnostics> & {
    cacheState: HistoryCacheState;
    historySource: HistorySource;
    coldLoad: boolean;
  }
): SidebarConversationHistoryDiagnostics {
  return {
    cacheState: options.cacheState,
    historySource: options.historySource,
    coldLoad: options.coldLoad,
    fsReadOps: options.fsReadOps ?? 0,
    fsReadBytes: options.fsReadBytes ?? 0,
    sessionFileBytes: options.sessionFileBytes,
    cacheFileBytes: options.cacheFileBytes,
    persistedEntryCount: options.persistedEntryCount,
    cachedEntryCount: options.cachedEntryCount,
    sessionSummaryBytesScanned: options.sessionSummaryBytesScanned,
    cacheReadMs: options.cacheReadMs,
    sessionSummaryReadMs: options.sessionSummaryReadMs,
    fastPathUsed: options.fastPathUsed ?? false,
    detail: options.detail ?? null
  };
}

export function mergeDiagnosticDetails(...details: Array<string | null | undefined>): string | null {
  const normalized = details
    .flatMap((detail) => (typeof detail === "string" ? detail.split("; ") : []))
    .map((detail) => detail.trim())
    .filter((detail) => detail.length > 0);

  if (normalized.length === 0) {
    return null;
  }

  return Array.from(new Set(normalized)).join("; ");
}

export function sumOptionalNumbers(...values: Array<number | undefined>): number | undefined {
  let total = 0;
  let foundValue = false;

  for (const value of values) {
    if (typeof value !== "number") {
      continue;
    }

    total += value;
    foundValue = true;
  }

  return foundValue ? total : undefined;
}

export function recordConversationHistoryDiagnostics(
  perf: SidebarPerfRecorder | undefined,
  agentId: string,
  diagnostics: SidebarConversationHistoryDiagnostics
): void {
  perf?.increment(SIDEBAR_HISTORY_CACHE_STATE_METRIC, {
    labels: {
      cacheState: diagnostics.cacheState,
      historySource: diagnostics.historySource
    },
    fields: {
      agentId,
      coldLoad: diagnostics.coldLoad,
      fsReadOps: diagnostics.fsReadOps,
      fsReadBytes: diagnostics.fsReadBytes,
      sessionFileBytes: diagnostics.sessionFileBytes,
      cacheFileBytes: diagnostics.cacheFileBytes,
      persistedEntryCount: diagnostics.persistedEntryCount,
      cachedEntryCount: diagnostics.cachedEntryCount,
      sessionSummaryBytesScanned: diagnostics.sessionSummaryBytesScanned,
      cacheReadMs: diagnostics.cacheReadMs,
      sessionSummaryReadMs: diagnostics.sessionSummaryReadMs,
      detail: diagnostics.detail ?? undefined,
      fastPathUsed: diagnostics.fastPathUsed ?? undefined
    }
  });
}
