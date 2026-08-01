import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isEnoentError, isRecord, STATS_CACHE_TTL_MS } from "../stats-shared.js";
import type {
  GenerationThroughputCacheEntry,
  GenerationThroughputScanResult,
  PersistedGenerationThroughputCache,
} from "./generation-throughput-types.js";
import { GENERATION_THROUGHPUT_CACHE_VERSION } from "./generation-throughput-types.js";

export function createGenerationThroughputCacheEntry(result: GenerationThroughputScanResult): GenerationThroughputCacheEntry {
  return { expiresAt: Date.now() + STATS_CACHE_TTL_MS, result };
}

export async function loadPersistedGenerationThroughputCache(
  path: string,
): Promise<GenerationThroughputCacheEntry | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== GENERATION_THROUGHPUT_CACHE_VERSION || !isRecord(parsed.entry)) {
      return null;
    }
    const expiresAt = parsed.entry.expiresAt;
    const result = parsed.entry.result;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0 || !isScanResult(result)) return null;
    return { expiresAt, result };
  } catch (error) {
    if (isEnoentError(error)) return null;
    return null;
  }
}

export async function persistGenerationThroughputCache(
  path: string,
  entry: GenerationThroughputCacheEntry | null,
): Promise<void> {
  const payload: PersistedGenerationThroughputCache = {
    version: GENERATION_THROUGHPUT_CACHE_VERSION,
    entry,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload), "utf8");
}

function isScanResult(value: unknown): value is GenerationThroughputScanResult {
  return isRecord(value)
    && typeof value.scannedAt === "string"
    && Array.isArray(value.records)
    && isRecord(value.diagnostics);
}
