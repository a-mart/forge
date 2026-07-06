import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CortexConsolidationRunRecord } from "@forge/protocol";
import { readJsonFileIfExists, writeJsonFileAtomic } from "../utils/atomic-files.js";
import { getCortexConsolidationRunsPath } from "./data-paths.js";

const FILE_VERSION = 1;
const MAX_STORED_RUNS = 30;

interface StoredRunsFile {
  version: 1;
  runs: CortexConsolidationRunRecord[];
}

export function createCortexConsolidationRunId(): string {
  return `consolidation-${randomUUID()}`;
}

export async function appendCortexConsolidationRun(
  dataDir: string,
  run: CortexConsolidationRunRecord,
): Promise<void> {
  await updateCortexConsolidationRuns(dataDir, (runs) => [run, ...runs.filter((entry) => entry.runId !== run.runId)]);
}

export async function readCortexConsolidationRuns(dataDir: string): Promise<CortexConsolidationRunRecord[]> {
  return (await readRunsFile(dataDir)).runs;
}

async function updateCortexConsolidationRuns(
  dataDir: string,
  mutator: (runs: CortexConsolidationRunRecord[]) => CortexConsolidationRunRecord[],
): Promise<CortexConsolidationRunRecord[]> {
  const path = getCortexConsolidationRunsPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  const current = await readRunsFile(dataDir);
  const seen = new Set<string>();
  const runs = mutator(current.runs)
    .filter(isRun)
    .filter((run) => {
      if (seen.has(run.runId)) return false;
      seen.add(run.runId);
      return true;
    })
    .slice(0, MAX_STORED_RUNS);
  await writeJsonFileAtomic(path, { version: FILE_VERSION, runs } satisfies StoredRunsFile);
  return runs;
}

async function readRunsFile(dataDir: string): Promise<StoredRunsFile> {
  const parsed = await readJsonFileIfExists<Partial<StoredRunsFile>>(getCortexConsolidationRunsPath(dataDir));
  if (!parsed || !Array.isArray(parsed.runs)) {
    return { version: FILE_VERSION, runs: [] };
  }
  return { version: FILE_VERSION, runs: parsed.runs.filter(isRun) };
}

function isRun(value: unknown): value is CortexConsolidationRunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CortexConsolidationRunRecord>;
  return (
    typeof candidate.runId === "string" &&
    (candidate.trigger === "manual" || candidate.trigger === "threshold" || candidate.trigger === "daily") &&
    (candidate.status === "completed" || candidate.status === "skipped" || candidate.status === "failed") &&
    typeof candidate.requestedAt === "string" &&
    (typeof candidate.completedAt === "string" || candidate.completedAt === null) &&
    typeof candidate.merged === "number" &&
    typeof candidate.archived === "number" &&
    typeof candidate.superseded === "number" &&
    Array.isArray(candidate.reindexedScopes) &&
    Array.isArray(candidate.changelog)
  );
}
