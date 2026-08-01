import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GenerationMeasurementRecordV1 } from "@forge/protocol";
import { getSessionFilePath, getWorkersDir } from "../data-paths.js";
import {
  foldGenerationMeasurementRecords,
  parseGenerationMeasurementCustomEntry,
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
    await collectMeasurementSources(path, sources);
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

async function collectMeasurementSources(
  path: string,
  destinations: GenerationMeasurementRecordSource[],
): Promise<void> {
  let byteOffset = 0;
  let pending = Buffer.alloc(0);

  try {
    for await (const chunk of createReadStream(path)) {
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, Buffer.from(chunk)]);
      let newlineIndex: number;
      while ((newlineIndex = pending.indexOf(0x0a)) >= 0) {
        collectLine(pending.subarray(0, newlineIndex), path, byteOffset, destinations);
        byteOffset += newlineIndex + 1;
        pending = pending.subarray(newlineIndex + 1);
      }
    }
    if (pending.length > 0) collectLine(pending, path, byteOffset, destinations);
  } catch (error) {
    if (!isEnoentError(error)) throw error;
  }
}

function collectLine(
  rawLine: Buffer,
  sourcePath: string,
  byteOffset: number,
  destinations: GenerationMeasurementRecordSource[],
): void {
  try {
    const entry = JSON.parse(rawLine.toString("utf8").trim()) as unknown;
    const record = parseGenerationMeasurementCustomEntry(entry);
    if (record) destinations.push({ record, sourcePath, byteOffset });
  } catch {
    // A malformed history line cannot prevent a count-only reconnect summary.
  }
}

function isEnoentError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
