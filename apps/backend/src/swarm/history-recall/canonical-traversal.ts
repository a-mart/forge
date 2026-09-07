import { randomUUID } from "node:crypto";
import type {
  HistoryCanonicalPage, HistoryItemsRequest, HistorySearchHit, HistorySearchRequest,
  HistoryWindowHit, HistoryWindowsRequest,
} from "@forge/protocol";
import { createProjectorState, projectCanonicalRecord } from "./canonical-projector.js";
import { buildCenteredSnippet, MAX_SNIPPET_CHARS, OVERSIZED_LINE_WARNING } from "./content-policy.js";
import { isSourceReadError, readCompleteLines, readPrefixTailHash, readSourceGeneration, readSourceStat } from "./jsonl-reader.js";
import { HistoryRecallError } from "./source-catalog.js";
import {
  DEFAULT_SEARCH_LIMIT, MAX_INDEX_CATCHUP_TOTAL_BYTES, MAX_INDEX_CATCHUP_SOURCES,
  MAX_LIVE_SNAPSHOTS, MAX_SEARCH_LIMIT, SCAN_BATCH_BYTES, SNAPSHOT_TTL_MS,
  type HistorySourceDescriptor, type JsonlCompleteLine, type ProjectedHistoryEntry, type ProjectorState,
} from "./types.js";

type Operation = "items" | "windows" | "literal";
type Request = HistoryItemsRequest & Partial<HistorySearchRequest>;
type Hit = HistorySearchHit | HistoryWindowHit;
interface SourceScan {
  source: HistorySourceDescriptor;
  generation: string;
  end: number;
  endHash: string;
  offset: number;
  skippingOversized: boolean;
  projector: ProjectorState;
  lines: JsonlCompleteLine[];
  parts: ProjectedHistoryEntry[];
  lastWindow?: string;
}
interface Traversal {
  id: string;
  identity: string;
  expiresAt: number;
  step: number;
  sources: HistorySourceDescriptor[];
  sourceIndex: number;
  scan?: SourceScan;
  warnings: Set<string>;
  omitted: boolean;
  previous?: { step: number; response: HistoryCanonicalPage<Hit> };
}

/** Bounded canonical recovery, deliberately independent of the disposable SQLite cache.
 * Cursors own scan offsets/projector state; callers cannot supply paths or raw seek positions.
 */
export class CanonicalHistoryTraversal {
  private readonly traversals = new Map<string, Traversal>();

  clear(): void { this.traversals.clear(); }

  page(operation: Operation, callerAgentId: string, request: Request | HistoryWindowsRequest,
    sources: HistorySourceDescriptor[], initialWarnings: string[] = [], incompleteCatalog = false): HistoryCanonicalPage<Hit> {
    const options = request as Request;
    const identity = JSON.stringify({ operation, callerAgentId, request: Object.fromEntries(Object.entries(request).filter(([key]) => key !== "cursor" && key !== "limit").sort(([a], [b]) => a.localeCompare(b))) });
    const { traversal, step } = this.resolve(identity, options.cursor, sources, initialWarnings, incompleteCatalog);
    // Revalidate catalog eligibility even on retries; cached locators are never read authority.
    const allowed = new Map(sources.map(source => [source.sourceId, source.path]));
    if (traversal.sources.some(source => allowed.get(source.sourceId) !== source.path)) {
      this.traversals.delete(traversal.id);
      throw new HistoryRecallError("History traversal sources changed; start a new traversal", 409, "snapshot_mismatch");
    }
    traversal.expiresAt = Date.now() + SNAPSHOT_TTL_MS;
    if (traversal.previous?.step === step) return traversal.previous.response;
    if (step !== traversal.step) throw new HistoryRecallError("History traversal cursor expired", 400, "snapshot_expired");
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(options.limit!))) : DEFAULT_SEARCH_LIMIT;
    const results: Hit[] = [];
    let bytesRemaining = MAX_INDEX_CATCHUP_TOTAL_BYTES;
    let visitedSources = 0;
    const validated = new Set<SourceScan>();
    while (results.length < limit && bytesRemaining > 0 && visitedSources < MAX_INDEX_CATCHUP_SOURCES) {
      let scan = traversal.scan;
      if (!scan) {
        const source = traversal.sources[traversal.sourceIndex];
        if (!source) break;
        visitedSources++;
        try {
          const stat = readSourceStat(source.path);
          if (!stat) throw new HistoryRecallError("Transcript unavailable", 404);
          scan = { source, generation: readSourceGeneration(source.path, stat), end: stat.size,
            endHash: readPrefixTailHash(source.path, stat.size), offset: 0, skippingOversized: false,
            projector: createProjectorState(), lines: [], parts: [] };
          traversal.scan = scan;
        } catch (error) {
          if (!(error instanceof HistoryRecallError) && !isSourceReadError(error)) throw error;
          traversal.omitted = true;
          traversal.warnings.add("An eligible transcript is unavailable; its history was not scanned.");
          traversal.sourceIndex++;
          continue;
        }
      }
      try {
        if (!validated.has(scan)) { this.validate(scan); validated.add(scan); }
        if (scan.parts.length) {
          const part = scan.parts.shift()!;
          if (operation === "windows") {
            if (part.windowId !== scan.lastWindow) {
              scan.lastWindow = part.windowId;
              results.push({ sessionAgentId: scan.source.sessionAgentId, actorAgentId: scan.source.actorAgentId,
                actorLabel: scan.source.actorLabel, windowId: part.windowId,
                firstRef: reference(scan, part), timestamp: part.timestamp });
            }
          } else if (matches(part, options, operation)) {
            results.push({ ref: reference(scan, part), profileId: scan.source.profileId,
              sessionLabel: scan.source.sessionLabel, actorLabel: scan.source.actorLabel,
              timestamp: part.timestamp, kind: part.kind, role: part.role, toolName: part.toolName,
              windowId: part.windowId, archived: scan.source.archived, score: 0,
              snippet: operation === "literal" ? literalSnippet(part.text, options.query!, options.caseSensitive !== false)
                : buildCenteredSnippet(part.text, []) });
          }
          continue;
        }
        if (scan.lines.length) {
          const line = scan.lines.shift()!;
          const record = projectCanonicalRecord(line.line, line.byteOffset, scan.projector, "read");
          if (record) scan.parts.push(...record.parts);
          else {
            try { JSON.parse(line.line); }
            catch {
              traversal.omitted = true;
              traversal.warnings.add("A malformed canonical row was omitted.");
            }
          }
          continue;
        }
        if (scan.offset >= scan.end) {
          traversal.scan = undefined;
          traversal.sourceIndex++;
          continue;
        }
        const batch = readCompleteLines(scan.source.path, scan.offset, scan.end, Math.min(bytesRemaining, SCAN_BATCH_BYTES), {
          resumeSkippingOversized: scan.skippingOversized,
        });
        bytesRemaining -= batch.scannedBytes;
        scan.lines = batch.lines;
        scan.skippingOversized = batch.skippingOversized;
        if (batch.skippedOversized) {
          traversal.omitted = true;
          traversal.warnings.add(OVERSIZED_LINE_WARNING);
        }
        if (batch.nextOffset === scan.offset && batch.lines.length === 0) {
          // A frozen source ending mid-record cannot make progress by rereading the same suffix.
          traversal.omitted = true;
          traversal.warnings.add("An unfinished canonical row was omitted; start a new traversal after it is durably completed.");
          scan.offset = scan.end;
        } else scan.offset = batch.nextOffset;
      } catch (error) {
        if (error instanceof HistoryRecallError) throw error;
        if (!isSourceReadError(error)) throw error;
        traversal.omitted = true;
        traversal.warnings.add("An eligible transcript became unreadable during traversal.");
        traversal.scan = undefined;
        traversal.sourceIndex++;
      }
    }
    // A full output page may have consumed the last record exactly.
    const scan = traversal.scan;
    if (scan && !scan.parts.length && !scan.lines.length && scan.offset >= scan.end) {
      traversal.scan = undefined;
      traversal.sourceIndex++;
    }
    const hasMore = traversal.sourceIndex < traversal.sources.length;
    traversal.step++;
    const response: HistoryCanonicalPage<Hit> = { results, complete: !hasMore && !traversal.omitted,
      warnings: [...traversal.warnings],
      ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ id: traversal.id, step: traversal.step })).toString("base64url") } : {}) };
    traversal.previous = { step, response };
    return response;
  }

  private validate(scan: SourceScan): void {
    const stat = readSourceStat(scan.source.path);
    if (!stat || stat.size < scan.end || readSourceGeneration(scan.source.path, stat) !== scan.generation
      || readPrefixTailHash(scan.source.path, scan.end) !== scan.endHash) {
      throw new HistoryRecallError("Canonical transcript changed or was reset; start a new traversal", 409, "snapshot_mismatch");
    }
  }

  private resolve(identity: string, cursor: string | undefined, sources: HistorySourceDescriptor[], warnings: string[], incomplete: boolean): { traversal: Traversal; step: number } {
    for (const [id, traversal] of this.traversals) if (traversal.expiresAt <= Date.now()) this.traversals.delete(id);
    if (cursor) {
      let parsed: { id?: string; step?: number };
      try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
      catch { throw new HistoryRecallError("Invalid canonical history cursor", 400, "snapshot_expired"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HistoryRecallError("Invalid canonical history cursor", 400, "snapshot_expired");
      const traversal = typeof parsed.id === "string" ? this.traversals.get(parsed.id) : undefined;
      if (!traversal || !Number.isSafeInteger(parsed.step) || parsed.step! < 0) throw new HistoryRecallError("History traversal expired", 400, "snapshot_expired");
      if (traversal.identity !== identity) throw new HistoryRecallError("History traversal cursor does not match this request", 400, "snapshot_mismatch");
      return { traversal, step: parsed.step! };
    }
    const traversal: Traversal = { id: randomUUID(), identity, expiresAt: Date.now() + SNAPSHOT_TTL_MS, step: 0,
      sources: [...sources].sort((a, b) => a.sourceId.localeCompare(b.sourceId)), sourceIndex: 0,
      warnings: new Set(warnings), omitted: incomplete };
    if (incomplete) traversal.warnings.add("The source catalog is still hydrating; this traversal may omit eligible actors.");
    this.traversals.set(traversal.id, traversal);
    while (this.traversals.size > MAX_LIVE_SNAPSHOTS) this.traversals.delete(this.traversals.keys().next().value!);
    return { traversal, step: 0 };
  }
}

function reference(scan: SourceScan, part: ProjectedHistoryEntry) {
  return { sessionAgentId: scan.source.sessionAgentId, actorAgentId: scan.source.actorAgentId,
    entryId: part.entryId, partId: part.partId, sourceVersion: scan.generation, byteOffset: part.byteOffset };
}

function matches(part: ProjectedHistoryEntry, request: Request, operation: Operation): boolean {
  if (request.windowId && part.windowId !== request.windowId) return false;
  if (request.kinds?.length && !request.kinds.includes(part.kind)) return false;
  if (request.toolName && part.toolName !== request.toolName) return false;
  if (request.role && part.role !== request.role) return false;
  if (request.since && (!part.timestamp || part.timestamp < request.since)) return false;
  if (request.until && (!part.timestamp || part.timestamp > request.until)) return false;
  if (!request.includeHistoryArtifacts && part.toolName === "history") return false;
  if (operation !== "literal") return true;
  return request.caseSensitive === false ? part.text.toLowerCase().includes(request.query!.toLowerCase()) : part.text.includes(request.query!);
}

function literalSnippet(text: string, query: string, caseSensitive: boolean): string {
  let index = caseSensitive ? text.indexOf(query) : text.toLowerCase().indexOf(query.toLowerCase());
  if (!caseSensitive && index >= 0) {
    // Lowercasing can expand a character (for example İ→i + combining dot).
    let foldedOffset = 0;
    let rawOffset = 0;
    for (const character of text) {
      const width = character.toLowerCase().length;
      if (foldedOffset + width > index) break;
      foldedOffset += width;
      rawOffset += character.length;
    }
    index = rawOffset;
  }
  const start = Math.max(0, index - Math.floor(MAX_SNIPPET_CHARS / 2));
  return `${start > 0 ? "…" : ""}${text.slice(start, start + MAX_SNIPPET_CHARS)}${start + MAX_SNIPPET_CHARS < text.length ? "…" : ""}`;
}
