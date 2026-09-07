import { getStatsSourceCache } from "../stats-source-cache.js";
import { join } from "node:path";
import type { GenerationMeasurementRecordV1, TokenAnalyticsAttributionKind } from "@forge/protocol";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  getSessionFilePath,
  getSessionMetaPath,
  getSessionsDir,
  getWorkersDir,
} from "../../swarm/data-paths.js";
import { resolveRoster } from "../../swarm/specialists/specialist-registry.js";
import {
  GENERATION_MEASUREMENT_ENTRY_TYPE,
  foldGenerationMeasurementRecords,
  type GenerationMeasurementRecordSource,
} from "../../utils/generation-measurement-records.js";
import { isRecord, listDirectoryNames, listFileNames, readJsonFileOrNull } from "../stats-shared.js";
import type {
  GenerationMeasurementRecord,
  GenerationThroughputScanDiagnostics,
  GenerationThroughputScanResult,
} from "./generation-throughput-types.js";

interface SessionMetaLite {
  label?: string | null;
}

interface SpecialistDisplayMeta {
  displayName: string;
  color: string | null;
}

/**
 * Streams manager and worker session JSONL files. The only retained payload is
 * the validated count-only generation record, never an assistant message body.
 */
export async function scanGenerationThroughputProfiles(
  swarmManager: Pick<SwarmManager, "getConfig" | "listUserProfiles">,
): Promise<GenerationThroughputScanResult> {
  const dataDir = swarmManager.getConfig().paths.dataDir;
  const profiles = swarmManager.listUserProfiles();
  const sources: GenerationMeasurementRecordSource[] = [];
  const diagnostics: GenerationThroughputScanDiagnostics = {
    malformedRecordCount: 0,
    duplicateRecordCount: 0,
    conflictRecordCount: 0,
    startOnlyCallCount: 0,
  };
  const sessionLabels = new Map<string, string>();
  const specialistMetadataByProfile = new Map<string, Map<string, SpecialistDisplayMeta>>();

  for (const profile of profiles) {
    specialistMetadataByProfile.set(profile.profileId, await readSpecialistMetadata(profile.profileId, dataDir));
    const sessionIds = await listDirectoryNames(getSessionsDir(dataDir, profile.profileId), { throwOnError: true });

    for (const sessionId of sessionIds) {
      const meta = await readJsonFileOrNull<SessionMetaLite>(getSessionMetaPath(dataDir, profile.profileId, sessionId));
      sessionLabels.set(sessionKey(profile.profileId, sessionId), normalizeLabel(meta?.label, sessionId));

      await scanMeasurementFile(getSessionFilePath(dataDir, profile.profileId, sessionId), sources, diagnostics, dataDir);

      const workersDir = getWorkersDir(dataDir, profile.profileId, sessionId);
      const workerFiles = (await listFileNames(workersDir, { throwOnError: true }))
        .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".conversation.jsonl"));
      for (const workerFile of workerFiles) {
        await scanMeasurementFile(join(workersDir, workerFile), sources, diagnostics, dataDir);
      }
    }
  }

  const folded = foldGenerationMeasurementRecords(sources);
  diagnostics.duplicateRecordCount = folded.diagnostics.duplicateCount;
  diagnostics.conflictRecordCount = folded.diagnostics.conflictCount;

  const profileDisplayNames = new Map(profiles.map((profile) => [profile.profileId, profile.displayName]));
  const records = folded.records.map((record) => toMeasurementRecord(
    record,
    profileDisplayNames,
    sessionLabels,
    specialistMetadataByProfile,
  ));
  diagnostics.startOnlyCallCount = records.filter((record) => record.recordState === "started").length;

  return {
    scannedAt: new Date().toISOString(),
    records,
    diagnostics,
  };
}

async function scanMeasurementFile(
  path: string,
  destinations: GenerationMeasurementRecordSource[],
  diagnostics: GenerationThroughputScanDiagnostics,
  dataDir: string,
): Promise<void> {
  for (const { entry, byteOffset } of await getStatsSourceCache(dataDir).read(path)) {
    const record = entry.type === "custom" && entry.customType === "swarm_generation_measurement"
      ? entry.data as GenerationMeasurementRecordV1 | null : null;
    if (record) destinations.push({ record, sourcePath: path, byteOffset });
    else if (isGenerationMeasurementCustomEntry(entry)) diagnostics.malformedRecordCount += 1;
  }
}

function isGenerationMeasurementCustomEntry(entry: unknown): boolean {
  return isRecord(entry) && entry.type === "custom" && entry.customType === GENERATION_MEASUREMENT_ENTRY_TYPE;
}

async function readSpecialistMetadata(profileId: string, dataDir: string): Promise<Map<string, SpecialistDisplayMeta>> {
  const roster = await resolveRoster(profileId, dataDir);
  const result = new Map<string, SpecialistDisplayMeta>();
  for (const entry of roster) {
    result.set(entry.specialistId, {
      displayName: entry.displayName,
      color: entry.color ?? null,
    });
  }
  return result;
}

function toMeasurementRecord(
  record: GenerationMeasurementRecordV1,
  profileDisplayNames: Map<string, string>,
  sessionLabels: Map<string, string>,
  specialistMetadataByProfile: Map<string, Map<string, SpecialistDisplayMeta>>,
): GenerationMeasurementRecord {
  const specialist = record.identity.specialistId
    ? specialistMetadataByProfile.get(record.identity.profileId)?.get(record.identity.specialistId) ?? null
    : null;
  const attributionKind = deriveAttributionKind(
    record.identity.specialistId,
    record.identity.specialistAttributionKnown,
  );
  const completedAtMs = record.completedAt ? Date.parse(record.completedAt) : null;

  return {
    ...record,
    completedAtMs: completedAtMs !== null && Number.isFinite(completedAtMs) ? completedAtMs : null,
    effectiveModelId: record.model.responseModelId ?? record.model.requestedModelId,
    attributionKind,
    profileDisplayName: profileDisplayNames.get(record.identity.profileId) ?? record.identity.profileId,
    sessionLabel: sessionLabels.get(sessionKey(record.identity.profileId, record.identity.sessionId)) ?? record.identity.sessionId,
    specialistDisplayName: specialist?.displayName ?? null,
    specialistColor: specialist?.color ?? null,
  };
}

function deriveAttributionKind(
  specialistId: string | null,
  attributionKnown: boolean | null,
): TokenAnalyticsAttributionKind {
  if (specialistId) return "specialist";
  return attributionKnown === true ? "ad_hoc" : "unknown";
}

function normalizeLabel(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function sessionKey(profileId: string, sessionId: string): string {
  return `${profileId}\u0000${sessionId}`;
}
