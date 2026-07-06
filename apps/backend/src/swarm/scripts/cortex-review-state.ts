import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CortexChangelogAction, CortexChangelogEntry } from "@forge/protocol";
import { getCortexReviewLogPath } from "../data-paths.js";

export interface AppendCortexReviewLogEntryInput {
  runId: string;
  action: CortexChangelogAction;
  entryId?: string;
  sourceEntryIds?: string[];
  why: string;
  recordedAt?: string;
}

export type CortexReviewLogEntry = CortexChangelogEntry;

export async function appendCortexReviewLogEntry(options: {
  dataDir: string;
  entry: AppendCortexReviewLogEntryInput;
}): Promise<CortexReviewLogEntry> {
  const logPath = getCortexReviewLogPath(resolve(options.dataDir));
  const entry: CortexReviewLogEntry = {
    runId: options.entry.runId.trim(),
    action: options.entry.action,
    ...(options.entry.entryId ? { entryId: options.entry.entryId.trim() } : {}),
    ...(options.entry.sourceEntryIds?.length ? { sourceEntryIds: [...new Set(options.entry.sourceEntryIds)] } : {}),
    why: options.entry.why.trim(),
    recordedAt: options.entry.recordedAt ?? new Date().toISOString(),
  };

  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function readCortexReviewLogEntries(dataDir: string): Promise<CortexReviewLogEntry[]> {
  const logPath = getCortexReviewLogPath(resolve(dataDir));
  try {
    const raw = await readFile(logPath, "utf8");
    return raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseStoredCortexReviewLogEntry)
      .filter((entry): entry is CortexReviewLogEntry => entry !== null);
  } catch (error) {
    if (isEnoentError(error)) return [];
    throw error;
  }
}

function parseStoredCortexReviewLogEntry(line: string): CortexReviewLogEntry | null {
  try {
    const parsed = JSON.parse(line) as Partial<CortexReviewLogEntry>;
    if (
      typeof parsed.runId !== "string" ||
      !isAction(parsed.action) ||
      typeof parsed.why !== "string" ||
      typeof parsed.recordedAt !== "string"
    ) {
      return null;
    }
    return {
      runId: parsed.runId,
      action: parsed.action,
      ...(typeof parsed.entryId === "string" ? { entryId: parsed.entryId } : {}),
      ...(Array.isArray(parsed.sourceEntryIds)
        ? { sourceEntryIds: parsed.sourceEntryIds.filter((id): id is string => typeof id === "string") }
        : {}),
      why: parsed.why,
      recordedAt: parsed.recordedAt,
    };
  } catch {
    return null;
  }
}

function isAction(value: unknown): value is CortexChangelogAction {
  return value === "added" || value === "merged" || value === "archived" || value === "superseded" || value === "reindexed";
}

function isEnoentError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
