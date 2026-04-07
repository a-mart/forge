import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  ManagerProfile,
  ResolvedSpecialistDefinition,
  TokenAnalyticsAttributionFilter,
  TokenAnalyticsAttributionKind,
  TokenAnalyticsAttributionSummary,
  TokenAnalyticsAvailableFilters,
  TokenAnalyticsCostCoverage,
  TokenAnalyticsCostSummary,
  TokenAnalyticsQuery,
  TokenAnalyticsResolvedQuery,
  TokenAnalyticsSnapshot,
  TokenAnalyticsSpecialistSummary,
  TokenAnalyticsWorkerEvent,
  TokenAnalyticsWorkerEventsQuery,
  TokenAnalyticsWorkerEventsResponse,
  TokenAnalyticsWorkerPage,
  TokenAnalyticsWorkerPageQuery,
  TokenAnalyticsWorkerRunModelUsage,
  TokenAnalyticsWorkerRunSummary,
  TokenAnalyticsWorkerSort,
  TokenAnalyticsSortDirection,
  TokenCostTotals,
  TokenUsageTotals,
} from "@forge/protocol";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { getProfilesDir, getSessionMetaPath, getSessionsDir, getWorkersDir } from "../swarm/data-paths.js";
import { resolveRoster } from "../swarm/specialists/specialist-registry.js";
import { modelCatalogService } from "../swarm/model-catalog-service.js";
import {
  STATS_CACHE_TTL_MS,
  dayKeyToStartMs,
  extractReasoningLevel,
  extractThinkingLevelChange,
  extractUsage,
  isEnoentError,
  isRecord,
  normalizeTimezone,
  shiftDayKey,
  toDayKey,
  toTimestampMs,
} from "./stats-service.js";

interface SessionMetaLite {
  label?: string | null;
  workers?: WorkerMetaLite[];
}

interface WorkerMetaLite {
  id?: string;
  specialistId?: string | null;
  specialistAttributionKnown?: boolean;
  createdAt?: string;
  terminatedAt?: string | null;
}

interface SpecialistDisplayMeta {
  displayName: string;
  color: string | null;
}

interface TokenAnalyticsEventRecord {
  timestampMs: number;
  profileId: string;
  sessionId: string;
  workerId: string;
  provider: string;
  modelId: string;
  reasoningLevel: string | null;
  specialistId: string | null;
  attributionKind: TokenAnalyticsAttributionKind;
  usage: TokenUsageTotals;
  cost: TokenCostTotals | null;
}

interface TokenAnalyticsWorkerRecord {
  profileId: string;
  sessionId: string;
  sessionLabel: string;
  workerId: string;
  specialistId: string | null;
  attributionKind: TokenAnalyticsAttributionKind;
  createdAtMs: number;
  terminatedAtMs: number | null;
  durationMs: number | null;
}

interface TokenAnalyticsScanResult {
  scannedAt: string;
  events: TokenAnalyticsEventRecord[];
  workers: TokenAnalyticsWorkerRecord[];
  profiles: ManagerProfile[];
  specialistMetadataByProfile: Map<string, Map<string, SpecialistDisplayMeta>>;
}

interface TokenAnalyticsScanDiagnostics {
  skippedMissingTimestampEvents: number;
}

interface ScanCacheEntry {
  expiresAt: number;
  result: TokenAnalyticsScanResult;
}

interface ResolvedQueryWindow {
  query: TokenAnalyticsResolvedQuery;
  startMs: number | null;
  endExclusiveMs: number | null;
}

interface EventGroupStats {
  eventCount: number;
  usage: TokenUsageTotals;
  costTotals: TokenCostTotals | null;
  costCoveredEventCount: number;
}

interface WorkerAggregate {
  worker: TokenAnalyticsWorkerRecord;
  events: TokenAnalyticsEventRecord[];
  eventCount: number;
  usage: TokenUsageTotals;
  costTotals: TokenCostTotals | null;
  costCoveredEventCount: number;
  reasoningLevels: Set<string>;
  modelsUsed: Map<string, TokenAnalyticsWorkerRunModelUsage>;
}

interface DecodedCursor {
  offset: number;
  sort: TokenAnalyticsWorkerSort;
  direction: TokenAnalyticsSortDirection;
}

const DEFAULT_WORKER_PAGE_LIMIT = 25;
const MAX_WORKER_PAGE_LIMIT = 100;
const SERVER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export class TokenAnalyticsService {
  private scanCache: ScanCacheEntry | null = null;
  private inFlightScan: Promise<TokenAnalyticsScanResult> | null = null;

  constructor(private readonly swarmManager: SwarmManager) {}

  clearCache(): void {
    this.scanCache = null;
  }

  async getSnapshot(
    input: TokenAnalyticsQuery,
    options: { forceRefresh?: boolean } = {}
  ): Promise<TokenAnalyticsSnapshot> {
    const [scanResult, resolved] = await Promise.all([
      this.getScanResult(options.forceRefresh === true),
      this.resolveQuery(input),
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
      availableFilters: this.buildAvailableFilters(scanResult, baseEvents, resolved.query),
      totals: buildTotals(scopedWorkerAggregates),
      attribution: buildAttributionSummary(scopedWorkerAggregates),
      specialistBreakdown: this.buildSpecialistBreakdown(
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
    const [scanResult, resolved] = await Promise.all([
      this.getScanResult(options.forceRefresh === true),
      this.resolveQuery(input),
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
      this.toWorkerRunSummary(scanResult, aggregate, aggregate.worker.profileId)
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
      worker: this.toWorkerRunSummary(scanResult, aggregate, profileId),
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
    const nowMs = Date.now();
    if (!forceRefresh && this.scanCache && this.scanCache.expiresAt > nowMs) {
      return this.scanCache.result;
    }

    if (this.inFlightScan) {
      return this.inFlightScan;
    }

    const computePromise = this.scanProfiles()
      .then((result) => {
        this.scanCache = {
          expiresAt: Date.now() + STATS_CACHE_TTL_MS,
          result,
        };
        return result;
      })
      .finally(() => {
        this.inFlightScan = null;
      });

    this.inFlightScan = computePromise;
    return computePromise;
  }

  private async scanProfiles(): Promise<TokenAnalyticsScanResult> {
    const dataDir = this.swarmManager.getConfig().paths.dataDir;
    const profiles = this.swarmManager.listProfiles();
    const events: TokenAnalyticsEventRecord[] = [];
    const workers: TokenAnalyticsWorkerRecord[] = [];
    const specialistMetadataByProfile = new Map<string, Map<string, SpecialistDisplayMeta>>();
    const diagnostics: TokenAnalyticsScanDiagnostics = {
      skippedMissingTimestampEvents: 0,
    };

    for (const profile of profiles) {
      specialistMetadataByProfile.set(profile.profileId, await this.readSpecialistMetadata(profile.profileId, dataDir));

      const sessionIds = await listDirectoryNames(getSessionsDir(dataDir, profile.profileId));
      for (const sessionId of sessionIds) {
        const meta = await readSessionMetaLite(getSessionMetaPath(dataDir, profile.profileId, sessionId));
        const sessionLabel = normalizeSessionLabel(meta?.label, sessionId);
        const workerMetaById = new Map<string, WorkerMetaLite>();

        for (const workerMeta of meta?.workers ?? []) {
          const workerId = normalizeOptionalString(workerMeta.id);
          if (!workerId || workerId.endsWith(".conversation")) {
            continue;
          }

          workerMetaById.set(workerId, workerMeta);
          const createdAtMs = toTimestampMs(workerMeta.createdAt);
          if (createdAtMs === null) {
            continue;
          }

          const terminatedAtMs = toTimestampMs(workerMeta.terminatedAt);
          workers.push({
            profileId: profile.profileId,
            sessionId,
            sessionLabel,
            workerId,
            specialistId: normalizeOptionalString(workerMeta.specialistId),
            attributionKind: deriveAttributionKind(workerMeta.specialistId, workerMeta.specialistAttributionKnown),
            createdAtMs,
            terminatedAtMs,
            durationMs:
              terminatedAtMs !== null && terminatedAtMs >= createdAtMs ? terminatedAtMs - createdAtMs : null,
          });
        }

        const workerFileNames = (await listFileNames(getWorkersDir(dataDir, profile.profileId, sessionId))).filter(
          (name) => name.endsWith(".jsonl") && !name.endsWith(".conversation.jsonl")
        );

        for (const workerFileName of workerFileNames) {
          const workerId = workerFileName.slice(0, -".jsonl".length);
          const workerMeta = workerMetaById.get(workerId);
          const specialistId = normalizeOptionalString(workerMeta?.specialistId);
          const attributionKind = deriveAttributionKind(
            workerMeta?.specialistId,
            workerMeta?.specialistAttributionKnown
          );

          await scanJsonlFile(join(getWorkersDir(dataDir, profile.profileId, sessionId), workerFileName), (entry, context) => {
            const event = toEventRecord(entry, {
              profileId: profile.profileId,
              sessionId,
              workerId,
              specialistId,
              attributionKind,
              fallbackThinkingLevel: context.thinkingLevel,
              diagnostics,
            });
            if (event) {
              events.push(event);
            }
          });
        }
      }
    }

    const workerMap = buildWorkerMap(workers);
    for (const fallback of buildFallbackWorkersFromEvents(events, workerMap)) {
      workers.push(fallback);
    }

    if (diagnostics.skippedMissingTimestampEvents > 0) {
      console.debug(
        `[token-analytics] Skipped ${diagnostics.skippedMissingTimestampEvents} usage event${diagnostics.skippedMissingTimestampEvents === 1 ? "" : "s"} with missing or invalid timestamps during scan`
      );
    }

    return {
      scannedAt: new Date().toISOString(),
      events,
      workers,
      profiles,
      specialistMetadataByProfile,
    };
  }

  private async resolveQuery(input: TokenAnalyticsQuery): Promise<ResolvedQueryWindow> {
    const profiles = this.swarmManager.listProfiles();
    const knownProfileIds = new Set(profiles.map((profile) => profile.profileId));
    const timezone = normalizeTimezone(input.timezone);
    const rangePreset = parseRangePreset(input.rangePreset);
    const profileId = normalizeOptionalString(input.profileId);
    const provider = normalizeOptionalString(input.provider);
    const modelId = normalizeOptionalString(input.modelId);
    const attribution = parseAttributionFilter(input.attribution);
    const specialistId = normalizeOptionalString(input.specialistId);

    if (profileId && !knownProfileIds.has(profileId)) {
      throw new TokenAnalyticsError(400, `Unknown profileId: ${profileId}`);
    }

    if (rangePreset === "custom") {
      const startDate = normalizeDateString(input.startDate);
      const endDate = normalizeDateString(input.endDate);
      if (!startDate || !endDate) {
        throw new TokenAnalyticsError(400, "custom rangePreset requires startDate and endDate");
      }
      if (endDate < startDate) {
        throw new TokenAnalyticsError(400, "endDate must be on or after startDate");
      }

      return {
        query: {
          rangePreset,
          startDate,
          endDate,
          timezone,
          profileId: profileId ?? null,
          provider: provider ?? null,
          modelId: modelId ?? null,
          attribution,
          specialistId,
        },
        startMs: dayKeyToStartMs(startDate, timezone),
        endExclusiveMs: dayKeyToStartMs(shiftDayKey(endDate, 1), timezone),
      };
    }

    if (rangePreset === "all") {
      return {
        query: {
          rangePreset,
          startDate: null,
          endDate: null,
          timezone,
          profileId: profileId ?? null,
          provider: provider ?? null,
          modelId: modelId ?? null,
          attribution,
          specialistId,
        },
        startMs: null,
        endExclusiveMs: null,
      };
    }

    const todayKey = toDayKey(Date.now(), timezone);
    const startDate = rangePreset === "7d" ? shiftDayKey(todayKey, -6) : shiftDayKey(todayKey, -29);

    return {
      query: {
        rangePreset,
        startDate,
        endDate: todayKey,
        timezone,
        profileId: profileId ?? null,
        provider: provider ?? null,
        modelId: modelId ?? null,
        attribution,
        specialistId,
      },
      startMs: dayKeyToStartMs(startDate, timezone),
      endExclusiveMs: dayKeyToStartMs(shiftDayKey(todayKey, 1), timezone),
    };
  }

  private async readSpecialistMetadata(
    profileId: string,
    dataDir: string
  ): Promise<Map<string, SpecialistDisplayMeta>> {
    const roster = await resolveRoster(profileId, dataDir);
    const byId = new Map<string, SpecialistDisplayMeta>();
    for (const entry of roster) {
      byId.set(entry.specialistId, {
        displayName: entry.displayName,
        color: entry.color ?? null,
      });
    }
    return byId;
  }

  private buildAvailableFilters(
    scanResult: TokenAnalyticsScanResult,
    baseEvents: TokenAnalyticsEventRecord[],
    resolvedQuery: TokenAnalyticsResolvedQuery
  ): TokenAnalyticsAvailableFilters {
    const workerKeysByProfile = new Map<string, Set<string>>();
    const workerKeysByProvider = new Map<string, Set<string>>();
    const workerKeysByModel = new Map<string, Set<string>>();
    const workerKeysByAttribution = new Map<TokenAnalyticsAttributionFilter, Set<string>>();
    const workerKeysBySpecialist = new Map<string, Set<string>>();

    const usageByProfile = new Map<string, TokenUsageTotals>();
    const usageByProvider = new Map<string, TokenUsageTotals>();
    const usageByModel = new Map<string, TokenUsageTotals>();
    const usageByAttribution = new Map<TokenAnalyticsAttributionFilter, TokenUsageTotals>();
    const usageBySpecialist = new Map<string, TokenUsageTotals>();

    for (const event of baseEvents) {
      const workerKey = toWorkerKey(event.profileId, event.sessionId, event.workerId);
      addWorkerKey(workerKeysByProfile, event.profileId, workerKey);
      addWorkerKey(workerKeysByProvider, event.provider, workerKey);
      addWorkerKey(workerKeysByModel, toModelKey(event.provider, event.modelId), workerKey);
      addWorkerKey(workerKeysByAttribution, event.attributionKind, workerKey);
      if (event.specialistId) {
        addWorkerKey(workerKeysBySpecialist, event.specialistId, workerKey);
      }

      addUsage(usageByProfile, event.profileId, event.usage);
      addUsage(usageByProvider, event.provider, event.usage);
      addUsage(usageByModel, toModelKey(event.provider, event.modelId), event.usage);
      addUsage(usageByAttribution, event.attributionKind, event.usage);
      if (event.specialistId) {
        addUsage(usageBySpecialist, event.specialistId, event.usage);
      }
    }

    const allWorkerKeys = new Set(baseEvents.map((event) => toWorkerKey(event.profileId, event.sessionId, event.workerId)));
    const totalUsage = sumEventUsage(baseEvents);
    workerKeysByAttribution.set("all", allWorkerKeys);
    usageByAttribution.set("all", totalUsage);

    const profiles = Array.from(usageByProfile.entries())
      .map(([profileId, usage]) => {
        const profile = scanResult.profiles.find((entry) => entry.profileId === profileId);
        return {
          profileId,
          displayName: profile?.displayName ?? profileId,
          runCount: workerKeysByProfile.get(profileId)?.size ?? 0,
          usage,
        };
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName));

    const providers = Array.from(usageByProvider.entries())
      .map(([provider, usage]) => ({
        provider,
        displayName: provider,
        runCount: workerKeysByProvider.get(provider)?.size ?? 0,
        usage,
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));

    const models = Array.from(usageByModel.entries())
      .map(([key, usage]) => {
        const [provider, modelId] = splitModelKey(key);
        return {
          modelId,
          displayName: modelCatalogService.getModelDisplayName(modelId, provider),
          provider,
          runCount: workerKeysByModel.get(key)?.size ?? 0,
          usage,
        };
      })
      .sort((left, right) => right.usage.total - left.usage.total || left.displayName.localeCompare(right.displayName));

    const attributions: TokenAnalyticsAvailableFilters["attributions"] = [
      {
        value: "all",
        displayName: "All attribution",
        runCount: workerKeysByAttribution.get("all")?.size ?? 0,
        usage: cloneUsageTotals(usageByAttribution.get("all") ?? createEmptyUsageTotals()),
      },
      {
        value: "specialist",
        displayName: "Named specialists",
        runCount: workerKeysByAttribution.get("specialist")?.size ?? 0,
        usage: cloneUsageTotals(usageByAttribution.get("specialist") ?? createEmptyUsageTotals()),
      },
      {
        value: "ad_hoc",
        displayName: "Ad hoc",
        runCount: workerKeysByAttribution.get("ad_hoc")?.size ?? 0,
        usage: cloneUsageTotals(usageByAttribution.get("ad_hoc") ?? createEmptyUsageTotals()),
      },
      {
        value: "unknown",
        displayName: "Unknown",
        runCount: workerKeysByAttribution.get("unknown")?.size ?? 0,
        usage: cloneUsageTotals(usageByAttribution.get("unknown") ?? createEmptyUsageTotals()),
      },
    ];

    const specialistOptions = buildSpecialistMetadataIndex(
      scanResult,
      resolvedQuery.profileId
    );
    const specialists = Array.from(usageBySpecialist.entries())
      .map(([specialistId, usage]) => {
        const metadata = specialistOptions.get(specialistId);
        return {
          specialistId,
          displayName: metadata?.displayName ?? specialistId,
          color: metadata?.color ?? null,
          hasProfileVariants: metadata?.hasProfileVariants,
          runCount: workerKeysBySpecialist.get(specialistId)?.size ?? 0,
          usage,
        };
      })
      .sort((left, right) => right.usage.total - left.usage.total || left.displayName.localeCompare(right.displayName));

    return {
      profiles,
      providers,
      models,
      attributions,
      specialists,
    };
  }

  private buildSpecialistBreakdown(
    scanResult: TokenAnalyticsScanResult,
    workerAggregates: WorkerAggregate[],
    scopedProfileId: string | null
  ): TokenAnalyticsSpecialistSummary[] {
    const byBucket = new Map<string, {
      specialistId: string | null;
      attributionKind: TokenAnalyticsAttributionKind;
      runCount: number;
      eventCount: number;
      usage: TokenUsageTotals;
      durations: number[];
      costTotals: TokenCostTotals | null;
      costCoveredEventCount: number;
      modelTotals: Map<string, number>;
      profileTotals: Map<string, number>;
    }>();

    for (const aggregate of workerAggregates) {
      const key =
        aggregate.worker.attributionKind === "specialist" && aggregate.worker.specialistId
          ? `specialist:${aggregate.worker.specialistId}`
          : aggregate.worker.attributionKind;
      const existing =
        byBucket.get(key) ?? {
          specialistId: aggregate.worker.specialistId,
          attributionKind: aggregate.worker.attributionKind,
          runCount: 0,
          eventCount: 0,
          usage: createEmptyUsageTotals(),
          durations: [],
          costTotals: null,
          costCoveredEventCount: 0,
          modelTotals: new Map<string, number>(),
          profileTotals: new Map<string, number>(),
        };

      existing.runCount += 1;
      existing.eventCount += aggregate.eventCount;
      mergeUsageTotals(existing.usage, aggregate.usage);
      if (typeof aggregate.worker.durationMs === "number" && aggregate.worker.durationMs >= 0) {
        existing.durations.push(aggregate.worker.durationMs);
      }
      mergeCostTotalsInto(existing, aggregate.costTotals, aggregate.costCoveredEventCount);

      for (const model of aggregate.modelsUsed.values()) {
        const key = toModelKey(model.provider, model.modelId);
        existing.modelTotals.set(key, (existing.modelTotals.get(key) ?? 0) + model.totalTokens);
      }
      existing.profileTotals.set(
        aggregate.worker.profileId,
        (existing.profileTotals.get(aggregate.worker.profileId) ?? 0) + aggregate.usage.total
      );

      byBucket.set(key, existing);
    }

    const specialistMetadata = buildSpecialistMetadataIndex(scanResult, scopedProfileId);
    const profileDisplayNames = new Map(scanResult.profiles.map((profile) => [profile.profileId, profile.displayName]));
    const totalScopedTokens = workerAggregates.reduce((sum, aggregate) => sum + aggregate.usage.total, 0);

    return Array.from(byBucket.values())
      .map((bucket) => {
        const topModel = pickTopEntry(bucket.modelTotals);
        const topProfile = pickTopEntry(bucket.profileTotals);
        const specialistMeta = bucket.specialistId ? specialistMetadata.get(bucket.specialistId) : null;

        return {
          specialistId: bucket.specialistId,
          displayName:
            bucket.attributionKind === "ad_hoc"
              ? "Ad hoc"
              : bucket.attributionKind === "unknown"
                ? "Unknown"
                : specialistMeta?.displayName ?? bucket.specialistId ?? "Unknown",
          color: bucket.attributionKind === "specialist" ? specialistMeta?.color ?? null : null,
          attributionKind: bucket.attributionKind,
          hasProfileVariants: bucket.attributionKind === "specialist" ? specialistMeta?.hasProfileVariants : undefined,
          runCount: bucket.runCount,
          eventCount: bucket.eventCount,
          usage: bucket.usage,
          averageTokensPerRun: bucket.runCount > 0 ? Math.round(bucket.usage.total / bucket.runCount) : 0,
          averageDurationMs: bucket.durations.length > 0 ? Math.round(average(bucket.durations)) : null,
          percentOfScopedTokens: totalScopedTokens > 0 ? round2((bucket.usage.total / totalScopedTokens) * 100) : 0,
          topModelId: topModel ? splitModelKey(topModel.key)[1] : null,
          topModelProvider: topModel ? splitModelKey(topModel.key)[0] : null,
          topProfileId: topProfile?.key ?? null,
          topProfileDisplayName: topProfile ? profileDisplayNames.get(topProfile.key) ?? topProfile.key : null,
          cost: buildCostSummary(bucket.costTotals, bucket.costCoveredEventCount, bucket.eventCount),
        } satisfies TokenAnalyticsSpecialistSummary;
      })
      .sort((left, right) => {
        if (right.usage.total !== left.usage.total) {
          return right.usage.total - left.usage.total;
        }
        if (right.runCount !== left.runCount) {
          return right.runCount - left.runCount;
        }
        return left.displayName.localeCompare(right.displayName);
      });
  }

  private toWorkerRunSummary(
    scanResult: TokenAnalyticsScanResult,
    aggregate: WorkerAggregate,
    scopedProfileId: string | null
  ): TokenAnalyticsWorkerRunSummary {
    const profile = scanResult.profiles.find((entry) => entry.profileId === aggregate.worker.profileId);
    const specialistMeta = aggregate.worker.specialistId
      ? resolveSpecialistDisplayMeta(
          scanResult,
          aggregate.worker.profileId,
          aggregate.worker.specialistId,
          scopedProfileId
        )
      : null;

    const modelsUsed = Array.from(aggregate.modelsUsed.values()).sort(
      (left, right) => right.totalTokens - left.totalTokens || left.modelId.localeCompare(right.modelId)
    );
    const reasoningLevels = Array.from(aggregate.reasoningLevels.values()).sort((left, right) => left.localeCompare(right));

    return {
      profileId: aggregate.worker.profileId,
      profileDisplayName: profile?.displayName ?? aggregate.worker.profileId,
      sessionId: aggregate.worker.sessionId,
      sessionLabel: aggregate.worker.sessionLabel,
      workerId: aggregate.worker.workerId,
      specialistId: aggregate.worker.specialistId,
      specialistDisplayName: specialistMeta?.displayName ?? null,
      specialistColor: specialistMeta?.color ?? null,
      attributionKind: aggregate.worker.attributionKind,
      startedAt: new Date(aggregate.worker.createdAtMs).toISOString(),
      endedAt: aggregate.worker.terminatedAtMs !== null ? new Date(aggregate.worker.terminatedAtMs).toISOString() : null,
      durationMs: aggregate.worker.durationMs,
      eventCount: aggregate.eventCount,
      usage: cloneUsageTotals(aggregate.usage),
      reasoningLevels,
      modelsUsed,
      cost: buildCostSummary(aggregate.costTotals, aggregate.costCoveredEventCount, aggregate.eventCount),
    };
  }
}

export class TokenAnalyticsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "TokenAnalyticsError";
  }
}

function filterEvents(
  events: TokenAnalyticsEventRecord[],
  resolved: ResolvedQueryWindow,
  options: {
    includeProvider: boolean;
    includeModel: boolean;
    includeAttribution: boolean;
    includeSpecialist: boolean;
  }
): TokenAnalyticsEventRecord[] {
  return events.filter((event) => {
    if (resolved.query.profileId && event.profileId !== resolved.query.profileId) {
      return false;
    }
    if (resolved.startMs !== null && event.timestampMs < resolved.startMs) {
      return false;
    }
    if (resolved.endExclusiveMs !== null && event.timestampMs >= resolved.endExclusiveMs) {
      return false;
    }
    if (options.includeProvider && resolved.query.provider && event.provider !== resolved.query.provider) {
      return false;
    }
    if (options.includeModel && resolved.query.modelId && event.modelId !== resolved.query.modelId) {
      return false;
    }
    if (options.includeAttribution && resolved.query.attribution !== "all" && event.attributionKind !== resolved.query.attribution) {
      return false;
    }
    if (options.includeSpecialist && resolved.query.specialistId && event.specialistId !== resolved.query.specialistId) {
      return false;
    }
    return true;
  });
}

function buildWorkerMap(workers: TokenAnalyticsWorkerRecord[]): Map<string, TokenAnalyticsWorkerRecord> {
  return new Map(workers.map((worker) => [toWorkerKey(worker.profileId, worker.sessionId, worker.workerId), worker]));
}

function aggregateWorkers(
  events: TokenAnalyticsEventRecord[],
  workerMap: Map<string, TokenAnalyticsWorkerRecord>
): WorkerAggregate[] {
  const aggregates = new Map<string, WorkerAggregate>();

  for (const event of events) {
    const workerKey = toWorkerKey(event.profileId, event.sessionId, event.workerId);
    const worker = workerMap.get(workerKey) ?? {
      profileId: event.profileId,
      sessionId: event.sessionId,
      sessionLabel: event.sessionId,
      workerId: event.workerId,
      specialistId: event.specialistId,
      attributionKind: event.attributionKind,
      createdAtMs: event.timestampMs,
      terminatedAtMs: null,
      durationMs: null,
    };
    const existing =
      aggregates.get(workerKey) ?? {
        worker,
        events: [],
        eventCount: 0,
        usage: createEmptyUsageTotals(),
        costTotals: null,
        costCoveredEventCount: 0,
        reasoningLevels: new Set<string>(),
        modelsUsed: new Map<string, TokenAnalyticsWorkerRunModelUsage>(),
      };

    existing.events.push(event);
    existing.eventCount += 1;
    mergeUsageTotals(existing.usage, event.usage);
    if (event.cost) {
      existing.costCoveredEventCount += 1;
      existing.costTotals = addCostTotals(existing.costTotals, event.cost);
    }
    if (event.reasoningLevel) {
      existing.reasoningLevels.add(event.reasoningLevel);
    }
    const modelKey = toModelKey(event.provider, event.modelId);
    const existingModel = existing.modelsUsed.get(modelKey) ?? {
      modelId: event.modelId,
      provider: event.provider,
      totalTokens: 0,
    };
    existingModel.totalTokens += event.usage.total;
    existing.modelsUsed.set(modelKey, existingModel);

    aggregates.set(workerKey, existing);
  }

  return Array.from(aggregates.values());
}

function aggregateSingleWorker(worker: TokenAnalyticsWorkerRecord, events: TokenAnalyticsEventRecord[]): WorkerAggregate {
  const aggregates = aggregateWorkers(events, new Map([[toWorkerKey(worker.profileId, worker.sessionId, worker.workerId), worker]]));
  const aggregate = aggregates[0];
  if (!aggregate) {
    return {
      worker,
      events: [],
      eventCount: 0,
      usage: createEmptyUsageTotals(),
      costTotals: null,
      costCoveredEventCount: 0,
      reasoningLevels: new Set<string>(),
      modelsUsed: new Map<string, TokenAnalyticsWorkerRunModelUsage>(),
    };
  }
  return aggregate;
}

function buildTotals(workerAggregates: WorkerAggregate[]) {
  const usage = workerAggregates.reduce((sum, aggregate) => {
    mergeUsageTotals(sum, aggregate.usage);
    return sum;
  }, createEmptyUsageTotals());
  const eventCount = workerAggregates.reduce((sum, aggregate) => sum + aggregate.eventCount, 0);
  const durations = workerAggregates
    .map((aggregate) => aggregate.worker.durationMs)
    .filter((durationMs): durationMs is number => typeof durationMs === "number" && durationMs >= 0);
  const costTotals = workerAggregates.reduce<TokenCostTotals | null>(
    (sum, aggregate) => addCostTotals(sum, aggregate.costTotals),
    null
  );
  const costCoveredEventCount = workerAggregates.reduce(
    (sum, aggregate) => sum + aggregate.costCoveredEventCount,
    0
  );

  return {
    runCount: workerAggregates.length,
    eventCount,
    usage,
    averageTokensPerRun: workerAggregates.length > 0 ? Math.round(usage.total / workerAggregates.length) : 0,
    averageDurationMs: durations.length > 0 ? Math.round(average(durations)) : null,
    cost: buildCostSummary(costTotals, costCoveredEventCount, eventCount),
  };
}

function buildAttributionSummary(workerAggregates: WorkerAggregate[]): TokenAnalyticsAttributionSummary {
  const totalsByKind = new Map<TokenAnalyticsAttributionKind, {
    runCount: number;
    usage: TokenUsageTotals;
    eventCount: number;
    costTotals: TokenCostTotals | null;
    costCoveredEventCount: number;
  }>();

  for (const kind of ["specialist", "ad_hoc", "unknown"] as const) {
    totalsByKind.set(kind, {
      runCount: 0,
      usage: createEmptyUsageTotals(),
      eventCount: 0,
      costTotals: null,
      costCoveredEventCount: 0,
    });
  }

  for (const aggregate of workerAggregates) {
    const bucket = totalsByKind.get(aggregate.worker.attributionKind);
    if (!bucket) {
      continue;
    }

    bucket.runCount += 1;
    bucket.eventCount += aggregate.eventCount;
    mergeUsageTotals(bucket.usage, aggregate.usage);
    bucket.costTotals = addCostTotals(bucket.costTotals, aggregate.costTotals);
    bucket.costCoveredEventCount += aggregate.costCoveredEventCount;
  }

  const totalRuns = workerAggregates.length;
  const totalTokens = workerAggregates.reduce((sum, aggregate) => sum + aggregate.usage.total, 0);

  return {
    specialist: toAttributionBucket("specialist", totalsByKind.get("specialist"), totalRuns, totalTokens),
    adHoc: toAttributionBucket("ad_hoc", totalsByKind.get("ad_hoc"), totalRuns, totalTokens),
    unknown: toAttributionBucket("unknown", totalsByKind.get("unknown"), totalRuns, totalTokens),
  };
}

function toAttributionBucket(
  attributionKind: TokenAnalyticsAttributionKind,
  bucket: {
    runCount: number;
    usage: TokenUsageTotals;
    eventCount: number;
    costTotals: TokenCostTotals | null;
    costCoveredEventCount: number;
  } | undefined,
  totalRuns: number,
  totalTokens: number
) {
  const normalized =
    bucket ?? {
      runCount: 0,
      usage: createEmptyUsageTotals(),
      eventCount: 0,
      costTotals: null,
      costCoveredEventCount: 0,
    };

  return {
    attributionKind,
    runCount: normalized.runCount,
    runPercentage: totalRuns > 0 ? round2((normalized.runCount / totalRuns) * 100) : 0,
    usage: cloneUsageTotals(normalized.usage),
    tokenPercentage: totalTokens > 0 ? round2((normalized.usage.total / totalTokens) * 100) : 0,
    cost: buildCostSummary(normalized.costTotals, normalized.costCoveredEventCount, normalized.eventCount),
  };
}

function buildSpecialistMetadataIndex(
  scanResult: TokenAnalyticsScanResult,
  scopedProfileId: string | null
): Map<string, SpecialistDisplayMeta & { hasProfileVariants?: boolean }> {
  const result = new Map<string, SpecialistDisplayMeta & { hasProfileVariants?: boolean }>();

  if (scopedProfileId) {
    for (const [specialistId, metadata] of scanResult.specialistMetadataByProfile.get(scopedProfileId) ?? new Map()) {
      result.set(specialistId, { ...metadata });
    }
    return result;
  }

  const variants = new Map<string, Array<SpecialistDisplayMeta>>();
  for (const roster of scanResult.specialistMetadataByProfile.values()) {
    for (const [specialistId, metadata] of roster.entries()) {
      const existing = variants.get(specialistId) ?? [];
      existing.push(metadata);
      variants.set(specialistId, existing);
    }
  }

  for (const [specialistId, entries] of variants.entries()) {
    const first = entries[0];
    if (!first) {
      continue;
    }
    const hasProfileVariants = entries.some(
      (entry) => entry.displayName !== first.displayName || entry.color !== first.color
    );
    result.set(specialistId, {
      displayName: first.displayName,
      color: first.color,
      ...(hasProfileVariants ? { hasProfileVariants: true } : {}),
    });
  }

  return result;
}

function resolveSpecialistDisplayMeta(
  scanResult: TokenAnalyticsScanResult,
  profileId: string,
  specialistId: string,
  scopedProfileId: string | null
): (SpecialistDisplayMeta & { hasProfileVariants?: boolean }) | null {
  const profileMeta = scanResult.specialistMetadataByProfile.get(profileId)?.get(specialistId);
  if (profileMeta) {
    const crossProfileMeta = buildSpecialistMetadataIndex(scanResult, scopedProfileId).get(specialistId);
    return {
      displayName: profileMeta.displayName,
      color: profileMeta.color,
      ...(crossProfileMeta?.hasProfileVariants ? { hasProfileVariants: true } : {}),
    };
  }

  return buildSpecialistMetadataIndex(scanResult, scopedProfileId).get(specialistId) ?? null;
}

async function scanJsonlFile(
  path: string,
  onEntry: (entry: unknown, context: { thinkingLevel: string | null }) => void
): Promise<void> {
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
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
          // Ignore malformed lines.
        }
      }
    } finally {
      reader.close();
    }
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }
    throw error;
  }
}

async function readSessionMetaLite(path: string): Promise<SessionMetaLite | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as SessionMetaLite;
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }
    return null;
  }
}

async function listDirectoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }
    throw error;
  }
}

async function listFileNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }
    throw error;
  }
}

function toEventRecord(
  entry: unknown,
  options: {
    profileId: string;
    sessionId: string;
    workerId: string;
    specialistId: string | null;
    attributionKind: TokenAnalyticsAttributionKind;
    fallbackThinkingLevel: string | null;
    diagnostics: TokenAnalyticsScanDiagnostics;
  }
): TokenAnalyticsEventRecord | null {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
    return null;
  }

  const message = entry.message;
  const usage = extractUsage(message.usage);
  if (!usage) {
    return null;
  }

  const { provider, modelId } = extractProviderAndModel(message);
  const timestampMs = toTimestampMs(entry.timestamp) ?? toTimestampMs(message.timestamp);
  if (timestampMs === null) {
    options.diagnostics.skippedMissingTimestampEvents += 1;
    return null;
  }
  const reasoningLevel = extractReasoningLevel(message, options.fallbackThinkingLevel);

  return {
    timestampMs,
    profileId: options.profileId,
    sessionId: options.sessionId,
    workerId: options.workerId,
    provider,
    modelId,
    reasoningLevel,
    specialistId: options.specialistId,
    attributionKind: options.attributionKind,
    usage: cloneUsageTotals(usage),
    cost: extractCostTotals(message.usage),
  };
}

function extractProviderAndModel(message: Record<string, unknown>): { provider: string; modelId: string } {
  const explicitProvider = normalizeOptionalString(message.provider);
  const explicitModelId = normalizeOptionalString(message.modelId) ?? normalizeOptionalString(message.model);
  const rawModelId = explicitModelId ?? "unknown";

  if (explicitProvider) {
    return {
      provider: explicitProvider,
      modelId: rawModelId,
    };
  }

  const inferredProvider = modelCatalogService.inferProvider(rawModelId) ?? inferProviderFromScopedModelId(rawModelId) ?? "unknown";
  return {
    provider: inferredProvider,
    modelId: rawModelId,
  };
}

function inferProviderFromScopedModelId(modelId: string): string | null {
  const normalized = modelId.trim();
  if (!normalized) {
    return null;
  }

  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
    return null;
  }

  const prefix = normalized.slice(0, slashIndex);
  const knownPrefixes = new Set(["anthropic", "openai", "openai-codex", "claude-sdk", "xai", "openrouter"]);
  return knownPrefixes.has(prefix) ? prefix : null;
}

function extractCostTotals(value: unknown): TokenCostTotals | null {
  if (!isRecord(value) || !isRecord(value.cost)) {
    return null;
  }

  const input = toNonNegativeNumber(value.cost.input ?? value.cost.input_tokens);
  const output = toNonNegativeNumber(value.cost.output ?? value.cost.output_tokens);
  const cacheRead = toNonNegativeNumber(value.cost.cacheRead ?? value.cost.cache_read_input_tokens);
  const cacheWrite = toNonNegativeNumber(value.cost.cacheWrite ?? value.cost.cache_creation_input_tokens);
  const total = toFiniteNumber(value.cost.total) ?? input + output + cacheRead + cacheWrite;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: round2(total),
  };
}

function buildFallbackWorkersFromEvents(
  events: TokenAnalyticsEventRecord[],
  existingWorkers: Map<string, TokenAnalyticsWorkerRecord>
): TokenAnalyticsWorkerRecord[] {
  const byWorker = new Map<string, {
    profileId: string;
    sessionId: string;
    workerId: string;
    specialistId: string | null;
    attributionKind: TokenAnalyticsAttributionKind;
    minTimestampMs: number;
    maxTimestampMs: number;
  }>();

  for (const event of events) {
    const workerKey = toWorkerKey(event.profileId, event.sessionId, event.workerId);
    if (existingWorkers.has(workerKey)) {
      continue;
    }
    const current = byWorker.get(workerKey);
    if (!current) {
      byWorker.set(workerKey, {
        profileId: event.profileId,
        sessionId: event.sessionId,
        workerId: event.workerId,
        specialistId: event.specialistId,
        attributionKind: event.attributionKind,
        minTimestampMs: event.timestampMs,
        maxTimestampMs: event.timestampMs,
      });
      continue;
    }
    current.minTimestampMs = Math.min(current.minTimestampMs, event.timestampMs);
    current.maxTimestampMs = Math.max(current.maxTimestampMs, event.timestampMs);
  }

  return Array.from(byWorker.values()).map((entry) => ({
    profileId: entry.profileId,
    sessionId: entry.sessionId,
    sessionLabel: entry.sessionId,
    workerId: entry.workerId,
    specialistId: entry.specialistId,
    attributionKind: entry.attributionKind,
    createdAtMs: entry.minTimestampMs,
    terminatedAtMs: null,
    durationMs: null,
  }));
}

function deriveFallbackWorkerRecord(
  events: TokenAnalyticsEventRecord[],
  workerKey: string
): TokenAnalyticsWorkerRecord | null {
  const matching = events.filter((event) => toWorkerKey(event.profileId, event.sessionId, event.workerId) === workerKey);
  if (matching.length === 0) {
    return null;
  }

  const sorted = matching.slice().sort((left, right) => left.timestampMs - right.timestampMs);
  const first = sorted[0];
  if (!first) {
    return null;
  }

  return {
    profileId: first.profileId,
    sessionId: first.sessionId,
    sessionLabel: first.sessionId,
    workerId: first.workerId,
    specialistId: first.specialistId,
    attributionKind: first.attributionKind,
    createdAtMs: first.timestampMs,
    terminatedAtMs: null,
    durationMs: null,
  };
}

function deriveAttributionKind(
  specialistId: unknown,
  specialistAttributionKnown: unknown
): TokenAnalyticsAttributionKind {
  if (normalizeOptionalString(specialistId)) {
    return "specialist";
  }

  if (specialistAttributionKnown === true) {
    return "ad_hoc";
  }

  return "unknown";
}

function normalizeSessionLabel(label: string | null | undefined, sessionId: string): string {
  const normalized = normalizeOptionalString(label);
  return normalized ?? sessionId;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDateString(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  return /^\d{4}-\d{2}-\d{2}$/u.test(normalized) ? normalized : null;
}

function parseRangePreset(value: unknown): TokenAnalyticsResolvedQuery["rangePreset"] {
  if (value === "7d" || value === "30d" || value === "all" || value === "custom") {
    return value;
  }
  return "7d";
}

function parseAttributionFilter(value: unknown): TokenAnalyticsAttributionFilter {
  if (value === "all" || value === "specialist" || value === "ad_hoc" || value === "unknown") {
    return value;
  }
  return "all";
}

function parseWorkerSort(value: unknown): TokenAnalyticsWorkerSort {
  if (value === "startedAt" || value === "durationMs" || value === "totalTokens" || value === "cost") {
    return value;
  }
  return "startedAt";
}

function parseSortDirection(value: unknown): TokenAnalyticsSortDirection {
  return value === "asc" ? "asc" : "desc";
}

function parsePageLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WORKER_PAGE_LIMIT;
  }
  return Math.min(MAX_WORKER_PAGE_LIMIT, Math.max(1, Math.trunc(parsed)));
}

function encodeCursor(cursor: DecodedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): DecodedCursor | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const offset = typeof parsed.offset === "number" ? Math.trunc(parsed.offset) : Number.NaN;
    const sort = parseWorkerSort(parsed.sort);
    const direction = parseSortDirection(parsed.direction);
    if (!Number.isFinite(offset) || offset < 0) {
      return null;
    }
    return { offset, sort, direction };
  } catch {
    return null;
  }
}

function compareWorkerSummaries(
  left: TokenAnalyticsWorkerRunSummary,
  right: TokenAnalyticsWorkerRunSummary,
  sort: TokenAnalyticsWorkerSort,
  direction: TokenAnalyticsSortDirection
): number {
  const directionMultiplier = direction === "asc" ? 1 : -1;
  const leftValue = getWorkerSortValue(left, sort);
  const rightValue = getWorkerSortValue(right, sort);

  if (leftValue < rightValue) {
    return -1 * directionMultiplier;
  }
  if (leftValue > rightValue) {
    return 1 * directionMultiplier;
  }

  const leftKey = toWorkerKey(left.profileId, left.sessionId, left.workerId);
  const rightKey = toWorkerKey(right.profileId, right.sessionId, right.workerId);
  return leftKey.localeCompare(rightKey) * directionMultiplier;
}

function getWorkerSortValue(item: TokenAnalyticsWorkerRunSummary, sort: TokenAnalyticsWorkerSort): number {
  if (sort === "durationMs") {
    return item.durationMs ?? Number.NEGATIVE_INFINITY;
  }
  if (sort === "totalTokens") {
    return item.usage.total;
  }
  if (sort === "cost") {
    return item.cost.totals?.total ?? Number.NEGATIVE_INFINITY;
  }
  return Date.parse(item.startedAt);
}

function toWorkerKey(profileId: string, sessionId: string, workerId: string): string {
  return `${profileId}/${sessionId}/${workerId}`;
}

function toModelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

function splitModelKey(value: string): [string, string] {
  const separatorIndex = value.indexOf("\u0000");
  if (separatorIndex < 0) {
    return ["unknown", value];
  }
  return [value.slice(0, separatorIndex), value.slice(separatorIndex + 1)];
}

function addWorkerKey(map: Map<any, Set<string>>, key: any, workerKey: string): void {
  const existing = map.get(key) ?? new Set<string>();
  existing.add(workerKey);
  map.set(key, existing);
}

function addUsage(map: Map<any, TokenUsageTotals>, key: any, usage: TokenUsageTotals): void {
  const existing = map.get(key) ?? createEmptyUsageTotals();
  mergeUsageTotals(existing, usage);
  map.set(key, existing);
}

function sumEventUsage(events: TokenAnalyticsEventRecord[]): TokenUsageTotals {
  return events.reduce((sum, event) => {
    mergeUsageTotals(sum, event.usage);
    return sum;
  }, createEmptyUsageTotals());
}

function createEmptyUsageTotals(): TokenUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
}

function cloneUsageTotals(usage: TokenUsageTotals): TokenUsageTotals {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.total,
  };
}

function createEmptyCostTotals(): TokenCostTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
}

function mergeUsageTotals(target: TokenUsageTotals, source: TokenUsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

function addCostTotals(left: TokenCostTotals | null, right: TokenCostTotals | null): TokenCostTotals | null {
  if (!left && !right) {
    return null;
  }

  const result = left ? { ...left } : createEmptyCostTotals();
  if (right) {
    result.input = round2(result.input + right.input);
    result.output = round2(result.output + right.output);
    result.cacheRead = round2(result.cacheRead + right.cacheRead);
    result.cacheWrite = round2(result.cacheWrite + right.cacheWrite);
    result.total = round2(result.total + right.total);
  }
  return result;
}

function mergeCostTotalsInto(
  target: { costTotals: TokenCostTotals | null; costCoveredEventCount: number },
  source: TokenCostTotals | null,
  costCoveredEventCount: number
): void {
  target.costTotals = addCostTotals(target.costTotals, source);
  target.costCoveredEventCount += costCoveredEventCount;
}

function buildCostSummary(
  totals: TokenCostTotals | null,
  costCoveredEventCount: number,
  totalEventCount: number
): TokenAnalyticsCostSummary {
  const costCoverage = computeCostCoverage(costCoveredEventCount, totalEventCount);
  return {
    totals: totals ? { ...totals } : null,
    costCoverage,
    costCoveredEventCount,
  };
}

function computeCostCoverage(
  costCoveredEventCount: number,
  totalEventCount: number
): TokenAnalyticsCostCoverage {
  if (costCoveredEventCount <= 0) {
    return "none";
  }
  if (costCoveredEventCount >= totalEventCount) {
    return "full";
  }
  return "partial";
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return round2(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function pickTopEntry(map: Map<string, number>): { key: string; value: number } | null {
  let best: { key: string; value: number } | null = null;
  for (const [key, value] of map.entries()) {
    if (!best || value > best.value) {
      best = { key, value };
    }
  }
  return best;
}
