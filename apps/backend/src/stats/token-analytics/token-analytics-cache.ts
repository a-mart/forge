import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isEnoentError, isRecord, STATS_CACHE_TTL_MS } from "../stats-shared.js";
import { toSafeInteger } from "./token-analytics-math.js";
import { hydratePersistedScanResult, serializePersistedScanResult } from "./token-analytics-serialize.js";
import type {
  PersistedTokenAnalyticsCache,
  ScanCacheEntry,
  TokenAnalyticsScanResult,
} from "./token-analytics-types.js";
import { TOKEN_ANALYTICS_CACHE_VERSION } from "./token-analytics-types.js";

export function createTokenAnalyticsCacheEntry(result: TokenAnalyticsScanResult): ScanCacheEntry {
  return {
    expiresAt: Date.now() + STATS_CACHE_TTL_MS,
    result,
  };
}

export async function loadPersistedTokenAnalyticsCache(cacheFilePath: string): Promise<ScanCacheEntry | null> {
  try {
    const raw = await readFile(cacheFilePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedTokenAnalyticsCache;
    if (!isRecord(parsed) || parsed.version !== TOKEN_ANALYTICS_CACHE_VERSION || !parsed.entry || !isRecord(parsed.entry)) {
      return null;
    }

    const expiresAt = toSafeInteger(parsed.entry.expiresAt);
    const result = hydratePersistedScanResult(parsed.entry.result);
    if (expiresAt <= 0 || !result) {
      return null;
    }

    return {
      expiresAt,
      result,
    };
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }
    return null;
  }
}

export async function persistTokenAnalyticsCache(
  cacheFilePath: string,
  scanCache: ScanCacheEntry | null
): Promise<void> {
  const payload: PersistedTokenAnalyticsCache = {
    version: TOKEN_ANALYTICS_CACHE_VERSION,
    entry: scanCache
      ? {
          expiresAt: scanCache.expiresAt,
          result: serializePersistedScanResult(scanCache.result),
        }
      : null,
  };

  await mkdir(dirname(cacheFilePath), { recursive: true });
  await writeFile(cacheFilePath, JSON.stringify(payload), "utf8");
}
