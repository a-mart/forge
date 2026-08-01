import type {
  GenerationThroughputCallsPage,
  GenerationThroughputCallsQuery,
  GenerationThroughputQuery,
  GenerationThroughputSnapshot,
  GenerationMeasurementRecordV1,
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
export interface GenerationThroughputServiceOptions {
  scanProfiles?: typeof scanGenerationThroughputProfiles;
}

export class GenerationThroughputService {
  private scanCache: GenerationThroughputCacheEntry | null = null;
  private inFlightScan: { generation: number; promise: Promise<GenerationThroughputScanResult> } | null = null;
  private persistentCacheLoaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private cacheGeneration = 0;
  private readonly cacheFilePath: string;
  private readonly scanProfiles: typeof scanGenerationThroughputProfiles;

  constructor(
    private readonly swarmManager: SwarmManager,
    options: GenerationThroughputServiceOptions = {},
  ) {
    this.cacheFilePath = getSharedGenerationThroughputCachePath(this.swarmManager.getConfig().paths.dataDir);
    this.scanProfiles = options.scanProfiles ?? scanGenerationThroughputProfiles;
    this.swarmManager.on("generation_measurement_terminal_persisted", this.onTerminalRecordPersisted);
  }

  clearCache(): void {
    this.cacheGeneration += 1;
    this.scanCache = null;
  }

  /** A post-append terminal event invalidates stale disk scans without trusting live payloads. */
  invalidateFromRuntimeCompletion(): void {
    this.clearCache();
  }

  private readonly onTerminalRecordPersisted = (record: GenerationMeasurementRecordV1): void => {
    if (record.recordState === "terminal") this.invalidateFromRuntimeCompletion();
  };

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
      diagnostics: {
        ...scanResult.diagnostics,
        incompleteCallCount: base.filter((record) => record.recordState === "started").length,
      },
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
    if (this.inFlightScan?.generation === this.cacheGeneration) return this.inFlightScan.promise;

    const generation = this.cacheGeneration;
    const promise = this.scanProfiles(this.swarmManager)
      .then((result) => {
        if (generation === this.cacheGeneration) {
          const entry = createGenerationThroughputCacheEntry(result);
          this.scanCache = entry;
          this.queuePersistCacheWrite(generation, entry);
        }
        return result;
      })
      .finally(() => {
        if (this.inFlightScan?.promise === promise) this.inFlightScan = null;
      });
    this.inFlightScan = { generation, promise };
    return promise;
  }

  private async ensurePersistentCacheLoaded(): Promise<void> {
    if (this.persistentCacheLoaded) return;
    this.persistentCacheLoaded = true;
    const generation = this.cacheGeneration;
    const entry = await loadPersistedGenerationThroughputCache(this.cacheFilePath);
    if (generation === this.cacheGeneration) this.scanCache = entry;
  }

  private queuePersistCacheWrite(generation: number, entry: GenerationThroughputCacheEntry): void {
    this.persistQueue = this.persistQueue
      .then(() => generation === this.cacheGeneration
        ? persistGenerationThroughputCache(this.cacheFilePath, entry)
        : undefined)
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
