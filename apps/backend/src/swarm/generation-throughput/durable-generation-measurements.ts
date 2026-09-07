import { getStatsSourceCache } from "../../stats/stats-source-cache.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GenerationMeasurementRecordV1 } from "@forge/protocol";
import { getSessionFilePath, getWorkersDir } from "../data-paths.js";
import {
  foldGenerationMeasurementRecords,
  type GenerationMeasurementRecordSource,
} from "../../utils/generation-measurement-records.js";

/**
 * Reads only compact generation custom entries for one manager session and its
 * workers. The fold makes copied worker entries and normal lifecycle updates
 * one durable source of truth for reconnect/bootstrap summaries.
 */
export async function loadDurableGenerationMeasurements(
  dataDir: string,
  profileId: string,
  sessionAgentId: string,
): Promise<GenerationMeasurementRecordV1[]> {
  const sessionFile = getSessionFilePath(dataDir, profileId, sessionAgentId);
  const workersDir = getWorkersDir(dataDir, profileId, sessionAgentId);
  const workerFiles = await listWorkerFiles(workersDir);
  const sources: GenerationMeasurementRecordSource[] = [];

  for (const path of [sessionFile, ...workerFiles.map((file) => join(workersDir, file))]) {
    for (const { entry, byteOffset } of await getStatsSourceCache(dataDir).read(path)) {
      const record = entry.type === "custom" && entry.customType === "swarm_generation_measurement"
      ? entry.data as GenerationMeasurementRecordV1 | null : null;
      if (record) sources.push({ record, sourcePath: path, byteOffset });
    }
  }

  return foldGenerationMeasurementRecords(sources).records;
}

async function listWorkerFiles(workersDir: string): Promise<string[]> {
  try {
    return (await readdir(workersDir))
      .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".conversation.jsonl"));
  } catch (error) {
    if (isEnoentError(error)) return [];
    throw error;
  }
}

function isEnoentError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
