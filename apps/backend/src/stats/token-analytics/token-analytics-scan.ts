import { join } from "node:path";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  getSessionMetaPath,
  getSessionsDir,
  getWorkersDir,
} from "../../swarm/data-paths.js";
import { resolveRoster } from "../../swarm/specialists/specialist-registry.js";
import { modelCatalogService } from "../../swarm/model-catalog-service.js";
import {
  extractReasoningLevel,
  extractUsage,
  isRecord,
  listDirectoryNames,
  listFileNames,
  readJsonFileOrNull,
  scanJsonlFile,
  toTimestampMs,
} from "../stats-shared.js";
import {
  cloneUsageTotals,
  round2,
  toFiniteNumber,
  toNonNegativeNumber,
  toWorkerKey,
} from "./token-analytics-math.js";
import type {
  SessionMetaLite,
  SpecialistDisplayMeta,
  TokenAnalyticsEventRecord,
  TokenAnalyticsScanDiagnostics,
  TokenAnalyticsScanResult,
  TokenAnalyticsWorkerRecord,
  WorkerMetaLite,
} from "./token-analytics-types.js";
import type { TokenAnalyticsAttributionKind, TokenCostTotals } from "@forge/protocol";

export async function scanTokenAnalyticsProfiles(swarmManager: SwarmManager): Promise<TokenAnalyticsScanResult> {
  const dataDir = swarmManager.getConfig().paths.dataDir;
  const profiles = swarmManager.listProfiles();
  const events: TokenAnalyticsEventRecord[] = [];
  const workers: TokenAnalyticsWorkerRecord[] = [];
  const specialistMetadataByProfile = new Map<string, Map<string, SpecialistDisplayMeta>>();
  const diagnostics: TokenAnalyticsScanDiagnostics = {
    skippedMissingTimestampEvents: 0,
  };

  for (const profile of profiles) {
    specialistMetadataByProfile.set(profile.profileId, await readSpecialistMetadata(profile.profileId, dataDir));

    const sessionIds = await listDirectoryNames(getSessionsDir(dataDir, profile.profileId), { throwOnError: true });
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

      const workersDir = getWorkersDir(dataDir, profile.profileId, sessionId);
      const workerFileNames = (await listFileNames(workersDir, { throwOnError: true })).filter(
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

        await scanJsonlFile(join(workersDir, workerFileName), (entry, context) => {
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
        }, { throwOnError: true });
      }
    }
  }

  const workerMap = new Map(workers.map((worker) => [toWorkerKey(worker.profileId, worker.sessionId, worker.workerId), worker]));
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

export function deriveFallbackWorkerRecord(
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

async function readSpecialistMetadata(
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

async function readSessionMetaLite(path: string): Promise<SessionMetaLite | null> {
  return readJsonFileOrNull<SessionMetaLite>(path);
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
