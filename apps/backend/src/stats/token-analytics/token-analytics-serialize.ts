import type {
  AgentModelDescriptor,
  ManagerProfile,
  TokenAnalyticsAttributionKind,
  TokenCostTotals,
  TokenUsageTotals,
} from "@forge/protocol";

const LEGACY_CACHE_DEFAULT_MODEL_FALLBACK: AgentModelDescriptor = {
  provider: "unknown",
  modelId: "unknown",
  thinkingLevel: "unknown",
};
import { isRecord } from "../stats-shared.js";
import { toFiniteNumber } from "./token-analytics-math.js";
import type {
  PersistedTokenAnalyticsScanResult,
  SpecialistDisplayMeta,
  TokenAnalyticsEventRecord,
  TokenAnalyticsScanResult,
  TokenAnalyticsWorkerRecord,
} from "./token-analytics-types.js";

export function serializePersistedScanResult(result: TokenAnalyticsScanResult): PersistedTokenAnalyticsScanResult {
  const specialistMetadataByProfile: Record<string, Record<string, SpecialistDisplayMeta>> = {};

  for (const [profileId, roster] of result.specialistMetadataByProfile.entries()) {
    const serializedRoster: Record<string, SpecialistDisplayMeta> = {};
    for (const [specialistId, metadata] of roster.entries()) {
      serializedRoster[specialistId] = {
        displayName: metadata.displayName,
        color: metadata.color,
      };
    }
    specialistMetadataByProfile[profileId] = serializedRoster;
  }

  return {
    scannedAt: result.scannedAt,
    events: result.events,
    workers: result.workers,
    profiles: result.profiles,
    specialistMetadataByProfile,
  };
}

export function hydratePersistedScanResult(value: unknown): TokenAnalyticsScanResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const scannedAt = typeof value.scannedAt === "string" ? value.scannedAt : null;
  const rawEvents = Array.isArray(value.events) ? value.events : null;
  const rawWorkers = Array.isArray(value.workers) ? value.workers : null;
  const rawProfiles = Array.isArray(value.profiles) ? value.profiles : null;
  if (!scannedAt || !rawEvents || !rawWorkers || !rawProfiles || !isRecord(value.specialistMetadataByProfile)) {
    return null;
  }

  const events = rawEvents
    .map((event) => hydratePersistedEventRecord(event))
    .filter((event): event is TokenAnalyticsEventRecord => event !== null);
  const workers = rawWorkers
    .map((worker) => hydratePersistedWorkerRecord(worker))
    .filter((worker): worker is TokenAnalyticsWorkerRecord => worker !== null);
  const profiles = rawProfiles
    .map((profile) => hydratePersistedManagerProfile(profile, scannedAt))
    .filter((profile): profile is ManagerProfile => profile !== null);

  const droppedEventCount = rawEvents.length - events.length;
  const droppedWorkerCount = rawWorkers.length - workers.length;
  const droppedProfileCount = rawProfiles.length - profiles.length;
  const droppedRowCount = droppedEventCount + droppedWorkerCount + droppedProfileCount;
  if (droppedRowCount > 0) {
    console.debug(
      `[token-analytics] Dropped ${droppedRowCount} malformed persisted cache row${droppedRowCount === 1 ? "" : "s"} (events: ${droppedEventCount}, workers: ${droppedWorkerCount}, profiles: ${droppedProfileCount})`
    );
  }

  const originalRowCount = rawEvents.length + rawWorkers.length + rawProfiles.length;
  const validatedRowCount = events.length + workers.length + profiles.length;
  if (originalRowCount > 0 && validatedRowCount === 0) {
    return null;
  }

  const specialistMetadataByProfile = new Map<string, Map<string, SpecialistDisplayMeta>>();
  for (const [profileId, rawRoster] of Object.entries(value.specialistMetadataByProfile)) {
    if (!isRecord(rawRoster)) {
      continue;
    }

    const roster = new Map<string, SpecialistDisplayMeta>();
    for (const [specialistId, rawMetadata] of Object.entries(rawRoster)) {
      if (!isRecord(rawMetadata) || typeof rawMetadata.displayName !== "string") {
        continue;
      }

      roster.set(specialistId, {
        displayName: rawMetadata.displayName,
        color: normalizeOptionalString(rawMetadata.color),
      });
    }
    specialistMetadataByProfile.set(profileId, roster);
  }

  return {
    scannedAt,
    events,
    workers,
    profiles,
    specialistMetadataByProfile,
  };
}

function hydratePersistedEventRecord(value: unknown): TokenAnalyticsEventRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const profileId = normalizeOptionalString(value.profileId);
  const sessionId = normalizeOptionalString(value.sessionId);
  const workerId = normalizeOptionalString(value.workerId);
  const provider = normalizeOptionalString(value.provider);
  const modelId = normalizeOptionalString(value.modelId);
  const attributionKind = hydrateAttributionKind(value.attributionKind);
  const usage = hydrateTokenUsageTotals(value.usage);
  const cost = value.cost === null ? null : hydrateTokenCostTotals(value.cost);
  const timestampMs = toFiniteNumber(value.timestampMs);

  if (!profileId || !sessionId || !workerId || !provider || !modelId || !attributionKind || !usage || cost === undefined || timestampMs === null) {
    return null;
  }

  return {
    timestampMs,
    profileId,
    sessionId,
    workerId,
    provider,
    modelId,
    reasoningLevel: normalizeOptionalString(value.reasoningLevel),
    specialistId: normalizeOptionalString(value.specialistId),
    attributionKind,
    usage,
    cost,
  };
}

function hydratePersistedWorkerRecord(value: unknown): TokenAnalyticsWorkerRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const profileId = normalizeOptionalString(value.profileId);
  const sessionId = normalizeOptionalString(value.sessionId);
  const sessionLabel = normalizeOptionalString(value.sessionLabel);
  const workerId = normalizeOptionalString(value.workerId);
  const attributionKind = hydrateAttributionKind(value.attributionKind);
  const createdAtMs = toFiniteNumber(value.createdAtMs);
  const terminatedAtMs = hydrateNullableFiniteNumber(value.terminatedAtMs);
  const durationMs = hydrateNullableFiniteNumber(value.durationMs);

  if (
    !profileId ||
    !sessionId ||
    !sessionLabel ||
    !workerId ||
    !attributionKind ||
    createdAtMs === null ||
    terminatedAtMs === undefined ||
    durationMs === undefined
  ) {
    return null;
  }

  return {
    profileId,
    sessionId,
    sessionLabel,
    workerId,
    specialistId: normalizeOptionalString(value.specialistId),
    attributionKind,
    createdAtMs,
    terminatedAtMs,
    durationMs,
  };
}

function hydratePersistedManagerProfile(value: unknown, fallbackTimestamp: string): ManagerProfile | null {
  if (!isRecord(value)) {
    return null;
  }

  const profileId = normalizeOptionalString(value.profileId);
  const displayName = normalizeOptionalString(value.displayName);
  if (!profileId || !displayName) {
    return null;
  }

  const defaultSessionAgentId = normalizeOptionalString(value.defaultSessionAgentId) ?? profileId;
  const defaultModel = hydratePersistedModelDescriptor(value.defaultModel) ?? LEGACY_CACHE_DEFAULT_MODEL_FALLBACK;

  const createdAt = typeof value.createdAt === "string" ? value.createdAt : fallbackTimestamp;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : fallbackTimestamp;
  const sortOrder = toFiniteNumber(value.sortOrder);

  return {
    profileId,
    displayName,
    defaultSessionAgentId,
    defaultModel,
    createdAt,
    updatedAt,
    ...(sortOrder !== null ? { sortOrder } : {}),
  };
}

function hydratePersistedModelDescriptor(value: unknown): AgentModelDescriptor | null {
  if (!isRecord(value)) {
    return null;
  }

  const provider = normalizeOptionalString(value.provider);
  const modelId = normalizeOptionalString(value.modelId);
  const thinkingLevel = normalizeOptionalString(value.thinkingLevel);
  if (!provider || !modelId || !thinkingLevel) {
    return null;
  }

  return {
    provider,
    modelId,
    thinkingLevel,
  };
}

function hydrateTokenUsageTotals(value: unknown): TokenUsageTotals | null {
  if (!isRecord(value)) {
    return null;
  }

  const input = toFiniteNumber(value.input);
  const output = toFiniteNumber(value.output);
  const cacheRead = toFiniteNumber(value.cacheRead);
  const cacheWrite = toFiniteNumber(value.cacheWrite);
  const total = toFiniteNumber(value.total);
  if (input === null || output === null || cacheRead === null || cacheWrite === null || total === null) {
    return null;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
  };
}

function hydrateTokenCostTotals(value: unknown): TokenCostTotals | null | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const input = toFiniteNumber(value.input);
  const output = toFiniteNumber(value.output);
  const cacheRead = toFiniteNumber(value.cacheRead);
  const cacheWrite = toFiniteNumber(value.cacheWrite);
  const total = toFiniteNumber(value.total);
  if (input === null || output === null || cacheRead === null || cacheWrite === null || total === null) {
    return undefined;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
  };
}

function hydrateAttributionKind(value: unknown): TokenAnalyticsAttributionKind | null {
  if (value === "specialist" || value === "ad_hoc" || value === "unknown") {
    return value;
  }
  return null;
}

function hydrateNullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return toFiniteNumber(value) ?? undefined;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
