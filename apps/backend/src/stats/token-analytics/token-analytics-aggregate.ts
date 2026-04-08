import type {
  TokenAnalyticsAttributionFilter,
  TokenAnalyticsAttributionKind,
  TokenAnalyticsAttributionSummary,
  TokenAnalyticsAvailableFilters,
  TokenAnalyticsResolvedQuery,
  TokenAnalyticsSpecialistSummary,
  TokenAnalyticsWorkerRunModelUsage,
  TokenAnalyticsWorkerRunSummary,
  TokenCostTotals,
  TokenUsageTotals,
} from "@forge/protocol";
import { modelCatalogService } from "../../swarm/model-catalog-service.js";
import {
  addCostTotals,
  addUsage,
  addWorkerKey,
  average,
  buildCostSummary,
  cloneUsageTotals,
  createEmptyUsageTotals,
  mergeCostTotalsInto,
  mergeUsageTotals,
  pickTopEntry,
  round2,
  splitModelKey,
  sumEventUsage,
  toModelKey,
  toWorkerKey,
} from "./token-analytics-math.js";
import type {
  SpecialistDisplayMeta,
  TokenAnalyticsEventRecord,
  TokenAnalyticsScanResult,
  TokenAnalyticsWorkerRecord,
  WorkerAggregate,
} from "./token-analytics-types.js";

export function buildWorkerMap(workers: TokenAnalyticsWorkerRecord[]): Map<string, TokenAnalyticsWorkerRecord> {
  return new Map(workers.map((worker) => [toWorkerKey(worker.profileId, worker.sessionId, worker.workerId), worker]));
}

export function aggregateWorkers(
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

export function aggregateSingleWorker(
  worker: TokenAnalyticsWorkerRecord,
  events: TokenAnalyticsEventRecord[]
): WorkerAggregate {
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

export function buildTotals(workerAggregates: WorkerAggregate[]) {
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

export function buildAttributionSummary(workerAggregates: WorkerAggregate[]): TokenAnalyticsAttributionSummary {
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

export function buildAvailableFilters(
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

  const specialistOptions = buildSpecialistMetadataIndex(scanResult, resolvedQuery.profileId);
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

export function buildSpecialistBreakdown(
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
      const modelKey = toModelKey(model.provider, model.modelId);
      existing.modelTotals.set(modelKey, (existing.modelTotals.get(modelKey) ?? 0) + model.totalTokens);
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

export function toWorkerRunSummary(
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

export function buildSpecialistMetadataIndex(
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

export function resolveSpecialistDisplayMeta(
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

function toAttributionBucket(
  attributionKind: TokenAnalyticsAttributionKind,
  bucket:
    | {
        runCount: number;
        usage: TokenUsageTotals;
        eventCount: number;
        costTotals: TokenCostTotals | null;
        costCoveredEventCount: number;
      }
    | undefined,
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
