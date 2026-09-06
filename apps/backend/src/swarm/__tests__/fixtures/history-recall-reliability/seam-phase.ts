import Database from "better-sqlite3";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { HistoryRecallIndexStore } from "../../../history-recall/index-store.js";
import { readSourceGeneration, readSourceStat } from "../../../history-recall/jsonl-reader.js";
import { parseHistoryQuery } from "../../../history-recall/query-parser.js";
import { getSessionFilePath } from "../../../storage/data-paths.js";
import {
  MAX_INDEX_CATCHUP_BYTES,
  SCAN_BATCH_BYTES,
  type HistorySourceDescriptor,
} from "../../../history-recall/types.js";
import { ENTRY, NEEDLE, PROFILE, SESSION, TIME } from "./ids.js";
import { conversationMessage, joinJsonl, nativeUser, sessionHeader } from "./jsonl.js";
import type { ObservedHit } from "./scoring.js";

export interface IsolatedSeamPhaseResult {
  unanchored: boolean;
  phase: "provisional" | "converged";
  hits: ObservedHit[];
  provisionalEntryIds: string[];
  convergedEntryIds: string[];
  forwardEntryIds: string[];
  notes: string[];
  durationMs: number;
}

const SEAM_SOURCE_ID = "isolated-seam-unanchored";
const FORWARD_SOURCE_ID = "isolated-seam-forward";

export async function runIsolatedSeamPhases(dataDir: string): Promise<IsolatedSeamPhaseResult> {
  const started = performance.now();
  const notes: string[] = [];
  const seamPath = getSessionFilePath(dataDir, PROFILE.alpha, SESSION.seam);
  const isolatedDir = join(dataDir, "isolated-seam-phase");
  await mkdir(isolatedDir, { recursive: true });
  const indexPath = join(isolatedDir, "index.sqlite");
  const forwardPath = join(isolatedDir, "forward.jsonl");
  const store = await HistoryRecallIndexStore.open(indexPath, async () => Database);
  try {
    const seam = descriptor(SEAM_SOURCE_ID, seamPath);
    freezeUnanchoredTail(store, seam);
    const row = store.getSourceRow(seam.sourceId);
    const unanchored = Boolean(row && row.suffix_start > 0 && row.suffix_ready === 0);
    const provisionalHits = searchHits(store, seam);
    const provisionalEntryIds = uniqueIds(provisionalHits);
    if (unanchored) {
      notes.push("precondition: suffix unanchored after isolated tail-prep");
    } else {
      notes.push("precondition: isolated tail-prep did not leave an unanchored suffix; skip dual-id assertion");
    }

    for (let i = 0; i < 32 && store.needsScan(seam); i += 1) {
      store.ingestSource(seam, MAX_INDEX_CATCHUP_BYTES);
    }
    const convergedHits = searchHits(store, seam);
    const convergedEntryIds = uniqueIds(convergedHits);

    await writeFile(forwardPath, forwardTranscript());
    const forward = descriptor(FORWARD_SOURCE_ID, forwardPath);
    store.ingestSource(forward, MAX_INDEX_CATCHUP_BYTES);
    const forwardHits = searchHits(store, forward);
    const forwardEntryIds = uniqueIds(forwardHits);
    notes.push(`converged=${convergedEntryIds.join(",") || "none"} forward=${forwardEntryIds.join(",") || "none"}`);

    return {
      unanchored,
      phase: unanchored ? "provisional" : "converged",
      hits: unanchored ? provisionalHits : convergedHits,
      provisionalEntryIds,
      convergedEntryIds,
      forwardEntryIds,
      notes,
      durationMs: performance.now() - started,
    };
  } finally {
    store.close();
  }
}

function freezeUnanchoredTail(store: HistoryRecallIndexStore, source: HistorySourceDescriptor): void {
  const stat = readSourceStat(source.path);
  if (!stat) {
    throw new Error(`isolated seam source is unreadable: ${source.path}`);
  }
  const generation = readSourceGeneration(source.path, stat);
  const prepareTail = Reflect.get(store, "prepareTail");
  if (typeof prepareTail !== "function") {
    store.ingestSource(source, SCAN_BATCH_BYTES);
    return;
  }
  prepareTail.call(store, source, generation, stat, SCAN_BATCH_BYTES, []);
}

function descriptor(sourceId: string, path: string): HistorySourceDescriptor {
  return {
    sourceId,
    profileId: PROFILE.alpha,
    sessionAgentId: SESSION.seam,
    actorAgentId: SESSION.seam,
    path,
    archived: false,
    sessionLabel: "isolated-seam",
    actorLabel: "isolated-seam",
  };
}

function searchHits(store: HistoryRecallIndexStore, source: HistorySourceDescriptor): ObservedHit[] {
  return store.search({
    ftsMatch: parseHistoryQuery(NEEDLE.seam).ftsMatch,
    sourceIds: [source.sourceId],
    limit: 10,
    offset: 0,
    allowProvisional: true,
  }).map((row) => ({
    sessionAgentId: SESSION.seam,
    actorAgentId: SESSION.seam,
    entryId: row.entry_id,
    partId: row.part_id || undefined,
    kind: row.kind,
    snippet: row.text,
    provisional: row.provisional === 1,
  }));
}

function uniqueIds(hits: ObservedHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.entryId).filter((id): id is string => Boolean(id)))].sort();
}

function forwardTranscript(): string {
  return joinJsonl([
    sessionHeader(`${SESSION.seam}-forward-header`, "/tmp/hrr/hrr-seam-forward", TIME.archive),
    conversationMessage(ENTRY.seamUnanchoredCustom, "user", NEEDLE.seam, TIME.september),
    nativeUser(ENTRY.seamUnanchoredNative, NEEDLE.seam, TIME.september),
  ]);
}
