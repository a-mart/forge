import type {
  TokenAnalyticsQuery,
  TokenAnalyticsSnapshot,
  TokenAnalyticsWorkerEventsQuery,
  TokenAnalyticsWorkerEventsResponse,
  TokenAnalyticsWorkerPage,
  TokenAnalyticsWorkerPageQuery,
} from "@forge/protocol";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { getSharedTokenAnalyticsCachePath } from "../swarm/data-paths.js";
import {
  aggregateSingleWorker,
  aggregateWorkers,
  buildAttributionSummary,
  buildAvailableFilters,
  buildSpecialistBreakdown,
  buildTotals,
  buildWorkerMap,
  toWorkerRunSummary,
} from "./token-analytics/token-analytics-aggregate.js";
import {
  createTokenAnalyticsCacheEntry,
  loadPersistedTokenAnalyticsCache,
  persistTokenAnalyticsCache,
} from "./token-analytics/token-analytics-cache.js";
import { cloneUsageTotals, toWorkerKey } from "./token-analytics/token-analytics-math.js";
import {
  compareWorkerSummaries,
  decodeCursor,
  encodeCursor,
  filterEvents,
  normalizeOptionalString,
  parsePageLimit,
  parseSortDirection,
  parseWorkerSort,
  resolveTokenAnalyticsQuery,
  TokenAnalyticsError,
} from "./token-analytics/token-analytics-query.js";
import { deriveFallbackWorkerRecord, scanTokenAnalyticsProfiles } from "./token-analytics/token-analytics-scan.js";
import type { ScanCacheEntry, TokenAnalyticsScanResult } from "./token-analytics/token-analytics-types.js";

export { TokenAnalyticsError } from "./token-analytics/token-analytics-query.js";

export class TokenAnalyticsService {
  private scanCache: ScanCacheEntry | null = null;
  private inFlightScan: Promise<TokenAnalyticsScanResult> | null = null;
  private readonly cacheFilePath: string;

  private persistentCacheLoaded = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly swarmManager: SwarmManager) {
    this.cacheFilePath = getSharedTokenAnalyticsCachePath(this.swarmManager.getConfig().paths.dataDir);
  }

  clearCache(): void {
    this.scanCache = null;
  }

  async prewarmInBackground(): Promise<void> {
    await this.ensurePersistentCacheLoaded();
    void this.refreshScanInBackground().catch(() => {
      // best-effort startup prewarm
    });
  }

  async refreshScanInBackground(): Promise<TokenAnalyticsScanResult | null> {
    await this.ensurePersistentCacheLoaded();

    try {
      return await this.getScanResult(true);
    } catch {
      return null;
    }
  }

  async getSnapshot(
    input: TokenAnalyticsQuery,
    options: { forceRefresh?: boolean } = {}
  ): Promise<TokenAnalyticsSnapshot> {
    const profiles = this.swarmManager.listProfiles();
    const [scanResult, resolved] = await Promise.all([
      this.getScanResult(options.forceRefresh === true),
      Promise.resolve(resolveTokenAnalyticsQuery(input, profiles)),
    ]);

    const baseEvents = filterEvents(scanResult.events, resolved, {
      includeProvider: false,
      includeModel: false,
      includeAttribution: false,
      includeSpecialist: false,
    });
    const scopedEvents = filterEvents(scanResult.events, resolved, {
      includeProvider: true,
      includeModel: true,
      includeAttribution: true,
      includeSpecialist: true,
    });
    const scopedWorkerMap = buildWorkerMap(scanResult.workers);
    const scopedWorkerAggregates = aggregateWorkers(scopedEvents, scopedWorkerMap);

    return {
      computedAt: new Date().toISOString(),
      query: resolved.query,
      availableFilters: buildAvailableFilters(scanResult, baseEvents, resolved.query),
      totals: buildTotals(scopedWorkerAggregates),
      attribution: buildAttributionSummary(scopedWorkerAggregates),
      specialistBreakdown: buildSpecialistBreakdown(
        scanResult,
        scopedWorkerAggregates,
        resolved.query.profileId
      ),
    };
  }

  async getWorkerPage(
    input: TokenAnalyticsWorkerPageQuery,
    options: { forceRefresh?: boolean } = {}
  ): Promise<TokenAnalyticsWorkerPage> {
    const profiles = this.swarmManager.listProfiles();
    const [scanResult, resolved] = await Promise.all([
      this.getScanResult(options.forceRefresh === true),
      Promise.resolve(resolveTokenAnalyticsQuery(input, profiles)),
    ]);

    const scopedEvents = filterEvents(scanResult.events, resolved, {
      includeProvider: true,
      includeModel: true,
      includeAttribution: true,
      includeSpecialist: true,
    });
    const workerMap = buildWorkerMap(scanResult.workers);
    const workerAggregates = aggregateWorkers(scopedEvents, workerMap);
    const items = workerAggregates.map((aggregate) =>
      toWorkerRunSummary(scanResult, aggregate, resolved.query.profileId)
    );

    const sort = parseWorkerSort(input.sort);
    const direction = parseSortDirection(input.direction);
    const sorted = items.slice().sort((left, right) => compareWorkerSummaries(left, right, sort, direction));

    const limit = parsePageLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const offset = cursor && cursor.sort === sort && cursor.direction === direction ? cursor.offset : 0;
    const pageItems = sorted.slice(offset, offset + limit);
    const nextOffset = offset + pageItems.length;

    return {
      computedAt: new Date().toISOString(),
      query: resolved.query,
      totalCount: sorted.length,
      nextCursor: nextOffset < sorted.length ? encodeCursor({ offset: nextOffset, sort, direction }) : null,
      items: pageItems,
    };
  }

  async getWorkerEvents(
    input: TokenAnalyticsWorkerEventsQuery,
    options: { forceRefresh?: boolean } = {}
  ): Promise<TokenAnalyticsWorkerEventsResponse> {
    const scanResult = await this.getScanResult(options.forceRefresh === true);
    const profileId = normalizeOptionalString(input.profileId);
    const sessionId = normalizeOptionalString(input.sessionId);
    const workerId = normalizeOptionalString(input.workerId);

    if (!profileId || !sessionId || !workerId) {
      throw new TokenAnalyticsError(400, "profileId, sessionId, and workerId are required");
    }

    const workerKey = toWorkerKey(profileId, sessionId, workerId);
    const workerMap = buildWorkerMap(scanResult.workers);
    const workerRecord = workerMap.get(workerKey) ?? deriveFallbackWorkerRecord(scanResult.events, workerKey);
    const events = scanResult.events
      .filter((event) => toWorkerKey(event.profileId, event.sessionId, event.workerId) === workerKey)
      .sort((left, right) => left.timestampMs - right.timestampMs);

    if (!workerRecord || events.length === 0) {
      throw new TokenAnalyticsError(404, `Unknown worker: ${workerKey}`);
    }

    const aggregate = aggregateSingleWorker(workerRecord, events);

    return {
      computedAt: new Date().toISOString(),
      worker: toWorkerRunSummary(scanResult, aggregate, profileId),
      events: events.map((event) => ({
        timestamp: new Date(event.timestampMs).toISOString(),
        modelId: event.modelId,
        provider: event.provider,
        reasoningLevel: event.reasoningLevel,
        usage: cloneUsageTotals(event.usage),
        cost: event.cost ? { ...event.cost } : null,
      })),
    };
  }

  private async getScanResult(forceRefresh: boolean): Promise<TokenAnalyticsScanResult> {
    await this.ensurePersistentCacheLoaded();

    const nowMs = Date.now();
    if (!forceRefresh) {
      if (this.scanCache && this.scanCache.expiresAt > nowMs) {
        return this.scanCache.result;
      }

      if (this.scanCache) {
        void this.refreshScanInBackground().catch(() => {
          // best-effort stale-while-revalidate refresh
        });
        return this.scanCache.result;
      }
    }

    if (this.inFlightScan) {
      return this.inFlightScan;
    }

    const computePromise = scanTokenAnalyticsProfiles(this.swarmManager)
      .then((result) => {
        this.scanCache = createTokenAnalyticsCacheEntry(result);
        this.queuePersistCacheWrite();
        return result;
      })
      .finally(() => {
        this.inFlightScan = null;
      });

    this.inFlightScan = computePromise;
    return computePromise;
  }

  private async ensurePersistentCacheLoaded(): Promise<void> {
    if (this.persistentCacheLoaded) {
      return;
    }
    this.persistentCacheLoaded = true;
    this.scanCache = await loadPersistedTokenAnalyticsCache(this.cacheFilePath);
  }

  private queuePersistCacheWrite(): void {
    this.persistQueue = this.persistQueue
      .then(() => persistTokenAnalyticsCache(this.cacheFilePath, this.scanCache))
      .catch(() => {
        // best-effort persistent cache write
      });
  }
}
