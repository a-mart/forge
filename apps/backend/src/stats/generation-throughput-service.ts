import type {
  GenerationThroughputCallsPage,
  GenerationThroughputCallsQuery,
  GenerationThroughputQuery,
  GenerationThroughputSnapshot,
} from "@forge/protocol";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { getSharedGenerationThroughputCachePath } from "../swarm/data-paths.js";
import {
  buildGenerationAvailableFilters,
  buildGenerationMetrics,
  buildGenerationModelSummaries,
  buildGenerationRoleSummaries,
  buildGenerationTrends,
  toGenerationCall,
} from "./generation-throughput/generation-throughput-aggregate.js";
import {
  createGenerationThroughputCacheEntry,
  loadPersistedGenerationThroughputCache,
  persistGenerationThroughputCache,
} from "./generation-throughput/generation-throughput-cache.js";
import {
  decodeGenerationCallsCursor,
  encodeGenerationCallsCursor,
  filterGenerationMeasurements,
  parseGenerationCallsLimit,
  resolveGenerationThroughputQuery,
} from "./generation-throughput/generation-throughput-query.js";
import { scanGenerationThroughputProfiles } from "./generation-throughput/generation-throughput-scan.js";
import type { GenerationMeasurementRecord, GenerationThroughputCacheEntry, GenerationThroughputScanResult } from "./generation-throughput/generation-throughput-types.js";

export { GenerationThroughputError } from "./generation-throughput/generation-throughput-query.js";

/**
 * Independent stale-while-revalidate historical throughput cache. It only scans
 * `swarm_generation_measurement` custom records and deliberately never feeds
 * Overview or Token Analytics usage totals.
 */
export class GenerationThroughputService {
  private scanCache: GenerationThroughputCacheEntry | null = null;
  private inFlightScan: Promise<GenerationThroughputScanResult> | null = null;
  private persistentCacheLoaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly cacheFilePath: string;

  constructor(private readonly swarmManager: SwarmManager) {
    this.cacheFilePath = getSharedGenerationThroughputCachePath(this.swarmManager.getConfig().paths.dataDir);
  }

  clearCache(): void {
    this.scanCache = null;
  }

  /** Runtime completion can call this until a direct cache upsert is wired. */
  invalidateFromRuntimeCompletion(): void {
    this.clearCache();
  }

  async prewarmInBackground(): Promise<void> {
    await this.ensurePersistentCacheLoaded();
    void this.refreshScanInBackground().catch(() => undefined);
  }

  async refreshScanInBackground(): Promise<GenerationThroughputScanResult | null> {
    await this.ensurePersistentCacheLoaded();
    try {
      return await this.getScanResult(true);
    } catch {
      return null;
    }
  }

  async getSnapshot(
    input: GenerationThroughputQuery,
    options: { forceRefresh?: boolean } = {},
  ): Promise<GenerationThroughputSnapshot> {
    const profiles = this.swarmManager.listUserProfiles();
    const resolved = resolveGenerationThroughputQuery(input, profiles);
    const scanResult = await this.getScanResult(options.forceRefresh === true);
    const base = filterGenerationMeasurements(scanResult.records, resolved, {
      includeProvider: false,
      includeModel: false,
      includeAttribution: false,
      includeSpecialist: false,
      includeQuality: false,
    });
    const scopedCoverage = filterGenerationMeasurements(scanResult.records, resolved, {
      includeProvider: true,
      includeModel: true,
      includeAttribution: true,
      includeSpecialist: true,
      includeQuality: false,
    });
    const scoped = filterGenerationMeasurements(scanResult.records, resolved, {
      includeProvider: true,
      includeModel: true,
      includeAttribution: true,
      includeSpecialist: true,
      includeQuality: true,
    });
    const modelSummaries = buildGenerationModelSummaries(scoped, scopedCoverage);

    return {
      computedAt: scanResult.scannedAt,
      query: resolved.query,
      availableFilters: buildGenerationAvailableFilters(base),
      totals: buildGenerationMetrics(scoped, scopedCoverage),
      byRole: buildGenerationRoleSummaries(scoped, scopedCoverage),
      models: modelSummaries.models,
      modelTableTruncated: modelSummaries.truncated,
      trends: buildGenerationTrends(scoped, resolved.query.timezone, scopedCoverage),
      diagnostics: scanResult.diagnostics,
    };
  }

  async getCallsPage(
    input: GenerationThroughputCallsQuery,
    options: { forceRefresh?: boolean } = {},
  ): Promise<GenerationThroughputCallsPage> {
    const profiles = this.swarmManager.listUserProfiles();
    const resolved = resolveGenerationThroughputQuery(input, profiles);
    const scanResult = await this.getScanResult(options.forceRefresh === true);
    const scoped = filterGenerationMeasurements(scanResult.records, resolved, {
      includeProvider: true,
      includeModel: true,
      includeAttribution: true,
      includeSpecialist: true,
      includeQuality: true,
    })
      .filter((record) => record.recordState === "terminal" && record.completedAt !== null)
      .sort(compareRecentCalls);

    const cursor = decodeGenerationCallsCursor(input.cursor);
    const afterCursor = cursor
      ? scoped.filter((record) => isAfterCursor(record, cursor))
      : scoped;
    const limit = parseGenerationCallsLimit(input.limit);
    const pageRecords = afterCursor.slice(0, limit);
    const last = pageRecords.at(-1);

    return {
      computedAt: scanResult.scannedAt,
      query: resolved.query,
      totalCount: scoped.length,
      nextCursor: last && afterCursor.length > pageRecords.length
        ? encodeGenerationCallsCursor({ completedAt: last.completedAt!, measurementId: last.measurementId })
        : null,
      items: pageRecords.map(toGenerationCall),
    };
  }

  private async getScanResult(forceRefresh: boolean): Promise<GenerationThroughputScanResult> {
    await this.ensurePersistentCacheLoaded();
    const now = Date.now();
    if (!forceRefresh) {
      if (this.scanCache && this.scanCache.expiresAt > now) return this.scanCache.result;
      if (this.scanCache) {
        void this.refreshScanInBackground().catch(() => undefined);
        return this.scanCache.result;
      }
    }
    if (this.inFlightScan) return this.inFlightScan;

    this.inFlightScan = scanGenerationThroughputProfiles(this.swarmManager)
      .then((result) => {
        this.scanCache = createGenerationThroughputCacheEntry(result);
        this.queuePersistCacheWrite();
        return result;
      })
      .finally(() => {
        this.inFlightScan = null;
      });
    return this.inFlightScan;
  }

  private async ensurePersistentCacheLoaded(): Promise<void> {
    if (this.persistentCacheLoaded) return;
    this.persistentCacheLoaded = true;
    this.scanCache = await loadPersistedGenerationThroughputCache(this.cacheFilePath);
  }

  private queuePersistCacheWrite(): void {
    this.persistQueue = this.persistQueue
      .then(() => persistGenerationThroughputCache(this.cacheFilePath, this.scanCache))
      .catch(() => undefined);
  }
}

function compareRecentCalls(left: GenerationMeasurementRecord, right: GenerationMeasurementRecord): number {
  const byTime = (right.completedAtMs ?? Number.NEGATIVE_INFINITY) - (left.completedAtMs ?? Number.NEGATIVE_INFINITY);
  return byTime || right.measurementId.localeCompare(left.measurementId);
}

function isAfterCursor(
  record: GenerationMeasurementRecord,
  cursor: { completedAt: string; measurementId: string },
): boolean {
  const cursorMs = Date.parse(cursor.completedAt);
  const recordMs = record.completedAtMs ?? Number.NEGATIVE_INFINITY;
  return recordMs < cursorMs || (recordMs === cursorMs && record.measurementId < cursor.measurementId);
}
