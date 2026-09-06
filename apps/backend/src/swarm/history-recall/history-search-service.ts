import type {
  HistoryReadEntry,
  HistoryReadRequest,
  HistoryReadResponse,
  HistorySearchHit,
  HistorySearchRequest,
  HistorySearchResponse,
  HistorySearchScope,
} from "@forge/protocol";
import { getHistoryRecallIndexPath } from "../storage/data-paths.js";
import { projectCanonicalLine } from "./canonical-projector.js";
import {
  buildCenteredSnippet,
  clipText,
  DEFAULT_READ_CHARS,
  MAX_READ_CHARS,
  MAX_READ_RESPONSE_CHARS,
  OVERSIZED_LINE_WARNING,
} from "./content-policy.js";
import { HistoryRecallIndexStore, type EntryRow } from "./index-store.js";
import { readLineAt, readSourceGeneration, readSourceStat } from "./jsonl-reader.js";
import { parseHistoryQuery } from "./query-parser.js";
import {
  findSource,
  HistoryRecallError,
  listIndexableSources,
  listProjectSources,
  listSessionSources,
  resolveCallerSession,
  resolveProfileId,
} from "./source-catalog.js";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_INDEX_CATCHUP_BYTES,
  MAX_NEIGHBORS,
  MAX_SEARCH_LIMIT,
  type HistorySearchServiceHost,
  type HistorySourceDescriptor,
} from "./types.js";

interface SearchCursor {
  offset: number;
}

export class HistorySearchService {
  private storePromise: Promise<HistoryRecallIndexStore> | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly host: HistorySearchServiceHost) {}

  async search(callerAgentId: string, request: HistorySearchRequest): Promise<HistorySearchResponse> {
    this.assertOpen();
    const callerSession = resolveCallerSession(this.host, callerAgentId);
    const query = parseHistoryQuery(request.query ?? "");
    if (query.tokens.length === 0 || !query.ftsMatch) {
      throw new HistoryRecallError("Query must include a searchable term or quoted phrase");
    }
    const resolved = this.resolveSearchSources(callerSession, request);
    return this.runExclusive((store) => {
      const catchup = store.reconcileSources(resolved.sources, {
        liveSourceIds: listIndexableSources(this.host).map((source) => source.sourceId),
      });
      const sourceWindows = this.sourceWindows(store, resolved.sources, request.window);
      const limit = clampLimit(request.limit);
      const offset = decodeSearchCursor(request.cursor);
      const rows = store.search({
        ftsMatch: query.ftsMatch,
        sourceIds: resolved.sources.map((source) => source.sourceId),
        sourceWindows,
        kinds: request.kinds,
        toolName: request.toolName,
        role: request.role,
        since: request.since,
        until: request.until,
        limit: limit + 1,
        offset,
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const sourceById = new Map(resolved.sources.map((source) => [source.sourceId, source]));
      const results: HistorySearchHit[] = [];
      const warnings = [...resolved.warnings, ...catchup.warnings];
      for (const row of page) {
        const source = sourceById.get(row.source_id);
        if (!source) {
          continue;
        }
        const generation = this.currentSourceGeneration(source);
        const indexedGeneration = store.getSourceRow(source.sourceId)?.generation;
        if (!generation || generation !== indexedGeneration) {
          warnings.push("A search hit referred to a replaced transcript and was skipped.");
          continue;
        }
        results.push({
          ref: {
            sessionAgentId: source.sessionAgentId,
            actorAgentId: source.actorAgentId,
            entryId: row.entry_id,
            sourceVersion: generation,
          },
          profileId: source.profileId,
          sessionLabel: source.sessionLabel,
          actorLabel: source.actorLabel,
          timestamp: row.timestamp ?? undefined,
          kind: row.kind,
          role: row.role ?? undefined,
          toolName: row.tool_name ?? undefined,
          windowId: row.window_id,
          archived: source.archived,
          snippet: buildCenteredSnippet(row.text, query.snippetTerms),
          score: typeof row.score === "number" ? -row.score : 0,
        });
      }
      return {
        scope: resolved.scope,
        results,
        ...(hasMore ? { nextCursor: encodeSearchCursor(offset + results.length) } : {}),
        complete: !catchup.incomplete && !resolved.incomplete,
        warnings: unique([
          ...warnings,
          ...resolved.scopeNotes,
        ]),
      };
    });
  }

  async read(callerAgentId: string, request: HistoryReadRequest): Promise<HistoryReadResponse> {
    this.assertOpen();
    resolveCallerSession(this.host, callerAgentId);
    const ref = request.ref;
    if (!ref?.sessionAgentId || !ref.actorAgentId || !ref.entryId || !ref.sourceVersion) {
      throw new HistoryRecallError("Read requires a source-qualified history reference");
    }
    const source = findSource(this.host, ref.sessionAgentId, ref.actorAgentId);
    if (!source) {
      throw new HistoryRecallError("History source not found", 404);
    }
    const generation = this.currentSourceGeneration(source);
    if (!generation || generation !== ref.sourceVersion) {
      throw new HistoryRecallError("History reference is stale; the source was replaced or reset", 409);
    }

    // Checkpoint references can be consumed immediately, before index catch-up.
    if (ref.byteOffset !== undefined) {
      if (!Number.isSafeInteger(ref.byteOffset) || ref.byteOffset < 0) throw new HistoryRecallError("Invalid history byte offset");
      const line = readLineAt(source.path, ref.byteOffset);
      if (!line || line.oversized) throw new HistoryRecallError("Checkpoint evidence is unavailable or exceeds the readable row limit", 404);
      const projected = projectCanonicalLine(line.line, line.byteOffset, { windowId: "window:checkpoint-evidence", seenContentKeys: new Map() }, "read");
      if (!projected || projected.entryId !== ref.entryId || this.currentSourceGeneration(source) !== generation) {
        throw new HistoryRecallError("History reference is stale or does not identify this row", 409);
      }
      const entry = this.toReadEntry(source, generation, projected, Math.max(0, request.offset ?? 0), clampReadChars(request.maxChars), { remaining: MAX_READ_RESPONSE_CHARS });
      entry.ref.byteOffset = ref.byteOffset;
      return { entry, before: [], after: [], warnings: request.before || request.after ? ["Checkpoint direct reads omit neighbors; use search for indexed context expansion."] : [] };
    }

    return this.runExclusive((store) => {
      const indexedGeneration = store.getSourceRow(source.sourceId)?.generation;
      if (indexedGeneration && indexedGeneration !== ref.sourceVersion) {
        throw new HistoryRecallError("History reference is stale; the source was replaced or reset", 409);
      }
      store.ingestSource(source, MAX_INDEX_CATCHUP_BYTES);
      const currentGeneration = this.currentSourceGeneration(source);
      if (!currentGeneration || currentGeneration !== ref.sourceVersion) {
        throw new HistoryRecallError("History reference is stale; the source was replaced or reset", 409);
      }
      const indexed = store.getIndexedEntry(source.sourceId, ref.entryId);
      if (!indexed) {
        throw new HistoryRecallError("History entry not found", 404);
      }
      const neighbors = store.listNeighbors(source.sourceId, indexed.byte_offset, clampNeighbors(request.before), clampNeighbors(request.after));
      const budget = { remaining: MAX_READ_RESPONSE_CHARS };
      const warnings: string[] = [];
      const main = this.readIndexedEntry(source, generation, indexed, Math.max(0, request.offset ?? 0), clampReadChars(request.maxChars), budget, warnings);
      const before = neighbors.before.map((row) => this.readIndexedEntry(source, generation, row, 0, clampNeighborChars(budget.remaining), budget, warnings));
      const after = neighbors.after.map((row) => this.readIndexedEntry(source, generation, row, 0, clampNeighborChars(budget.remaining), budget, warnings));
      if (budget.remaining <= 0) {
        warnings.push(`Read response was bounded to ${MAX_READ_RESPONSE_CHARS} characters across the main entry and neighbors.`);
      }
      return { entry: main, before, after, warnings: unique(warnings) };
    });
  }

  async invalidateSession(sessionAgentId: string): Promise<void> {
    this.assertOpen();
    await this.runExclusive((store) => {
      store.purgeSession(sessionAgentId);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const run = this.writeChain.then(async () => {
      const pending = this.storePromise;
      this.storePromise = undefined;
      if (!pending) {
        return;
      }
      const store = await pending;
      if (store.database.open) {
        store.close();
      }
    });
    this.writeChain = run.then(() => undefined, () => undefined);
    await run;
  }

  private runExclusive<T>(operation: (store: HistoryRecallIndexStore) => T | Promise<T>): Promise<T> {
    const run = this.writeChain.then(async () => {
      // Let health checks, stop requests, and other sessions run between catch-up
      // batches instead of draining concurrent history calls as one microtask chain.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return operation(await this.getStore());
    });
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async getStore(): Promise<HistoryRecallIndexStore> {
    if (!this.storePromise) {
      this.storePromise = HistoryRecallIndexStore.open(
        getHistoryRecallIndexPath(this.host.config.paths.dataDir),
        this.host.loadDatabaseModule,
      );
    }
    return this.storePromise;
  }

  private resolveSearchSources(callerSession: ReturnType<typeof resolveCallerSession>, request: HistorySearchRequest): {
    scope: HistorySearchScope;
    sources: HistorySourceDescriptor[];
    warnings: string[];
    scopeNotes: string[];
    incomplete: boolean;
  } {
    const scope = request.scope ?? "session";
    const warnings: string[] = [];
    const scopeNotes: string[] = [];
    const callerProfileId = resolveProfileId(callerSession);

    if (request.sessionAgentId || request.profileId) {
      const targetSession = request.sessionAgentId ? this.host.getAgent(request.sessionAgentId) : undefined;
      const targetProfileId = request.profileId
        ?? (targetSession ? resolveProfileId(targetSession) : undefined);
      const outsideProject = Boolean(
        (targetProfileId && targetProfileId !== callerProfileId)
        || (targetSession && resolveProfileId(targetSession) !== callerProfileId),
      );
      if (outsideProject && !hasReason(request.reason)) {
        throw new HistoryRecallError("Searching outside the current project requires a specific reason");
      }
      if (outsideProject) {
        scopeNotes.push(`Outside-project search reason: ${request.reason!.trim()}`);
      }
      if (request.sessionAgentId) {
        if (!targetSession || targetSession.role !== "manager") {
          throw new HistoryRecallError("Requested session was not found", 404);
        }
        return {
          scope: outsideProject ? "all_local" : "session",
          sources: listSessionSources(this.host, targetSession),
          warnings,
          scopeNotes: [
            ...scopeNotes,
            `Effective scope is session ${targetSession.sessionLabel ?? targetSession.agentId}, including associated workers.`,
          ],
          incomplete: false,
        };
      }
      return {
        scope: outsideProject ? "all_local" : "project",
        sources: listProjectSources(this.host, targetProfileId!),
        warnings,
        scopeNotes: [
          ...scopeNotes,
          `Effective scope is project ${targetProfileId}, including sessions and archives.`,
        ],
        incomplete: false,
      };
    }

    if (scope === "session") {
      return {
        scope,
        sources: listSessionSources(this.host, callerSession),
        warnings,
        scopeNotes: ["Effective scope is the current session, including associated workers."],
        incomplete: false,
      };
    }
    if (scope === "project") {
      return {
        scope,
        sources: listProjectSources(this.host, callerProfileId),
        warnings,
        scopeNotes: ["Effective scope is the current project, including sessions and archives."],
        incomplete: false,
      };
    }
    if (!hasReason(request.reason)) {
      throw new HistoryRecallError("Searching outside the current project requires a specific reason");
    }
    scopeNotes.push(`Outside-project search reason: ${request.reason!.trim()}`);
    scopeNotes.push("Effective scope is all local Builder projects, excluding restricted Cortex, Collaboration, plugin, and capture-check sources.");
    return {
      scope,
      sources: listIndexableSources(this.host),
      warnings,
      scopeNotes,
      incomplete: false,
    };
  }

  private sourceWindows(
    store: HistoryRecallIndexStore,
    sources: HistorySourceDescriptor[],
    window: HistorySearchRequest["window"],
  ): Array<{ sourceId: string; windowIds: string[] }> | undefined {
    if (!window || window === "all") {
      return undefined;
    }
    return sources.map((source) => {
      if (window === "current") {
        return { sourceId: source.sourceId, windowIds: [store.getCurrentWindowId(source.sourceId)] };
      }
      return { sourceId: source.sourceId, windowIds: store.listNonCurrentWindowIds(source.sourceId) };
    });
  }

  private currentSourceGeneration(source: HistorySourceDescriptor): string | undefined {
    const stat = readSourceStat(source.path);
    if (!stat) {
      return undefined;
    }
    return readSourceGeneration(source.path, stat);
  }

  private readIndexedEntry(
    source: HistorySourceDescriptor,
    generation: string,
    row: EntryRow,
    offset: number,
    maxChars: number,
    budget: { remaining: number },
    warnings: string[],
  ): HistoryReadEntry {
    const line = readLineAt(source.path, row.byte_offset);
    if (!line) {
      throw new HistoryRecallError("History entry not found", 404);
    }
    if (line.oversized) {
      warnings.push(OVERSIZED_LINE_WARNING);
      return this.toReadEntry(source, generation, {
        kind: row.kind,
        timestamp: row.timestamp ?? undefined,
        role: row.role ?? undefined,
        toolName: row.tool_name ?? undefined,
        windowId: row.window_id,
        text: OVERSIZED_LINE_WARNING,
        entryId: row.entry_id,
      }, 0, Math.min(maxChars, budget.remaining), budget);
    }
    const projected = projectCanonicalLine(line.line, line.byteOffset, {
      windowId: row.window_id,
      seenContentKeys: new Map(),
    }, "read");
    if (!projected) {
      throw new HistoryRecallError("History entry is not readable under the content policy", 404);
    }
    return this.toReadEntry(source, generation, projected, offset, Math.min(maxChars, Math.max(0, budget.remaining)), budget);
  }

  private toReadEntry(
    source: HistorySourceDescriptor,
    generation: string,
    entry: {
      entryId: string;
      kind: HistoryReadEntry["kind"];
      timestamp?: string;
      role?: "user" | "assistant";
      toolName?: string;
      windowId: string;
      text: string;
    },
    offset: number,
    maxChars: number,
    budget: { remaining: number },
  ): HistoryReadEntry {
    const totalChars = entry.text.length;
    const start = Math.min(offset, totalChars);
    const allowed = Math.max(0, Math.min(maxChars, budget.remaining));
    const text = clipText(entry.text.slice(start), allowed);
    budget.remaining = Math.max(0, budget.remaining - text.length);
    const nextOffset = start + text.length < totalChars ? start + text.length : undefined;
    return {
      ref: {
        sessionAgentId: source.sessionAgentId,
        actorAgentId: source.actorAgentId,
        entryId: entry.entryId,
        sourceVersion: generation,
      },
      kind: entry.kind,
      timestamp: entry.timestamp,
      role: entry.role,
      toolName: entry.toolName,
      windowId: entry.windowId,
      text,
      offset: start,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      totalChars,
    };
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new HistoryRecallError("History search service has been disposed", 503);
    }
  }
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit!)));
}

function clampReadChars(maxChars: number | undefined): number {
  if (!Number.isFinite(maxChars)) {
    return DEFAULT_READ_CHARS;
  }
  return Math.max(256, Math.min(MAX_READ_CHARS, Math.floor(maxChars!)));
}

function clampNeighbors(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_NEIGHBORS, Math.floor(value!)));
}

function clampNeighborChars(remaining: number): number {
  return Math.max(0, Math.min(DEFAULT_READ_CHARS, remaining));
}

function hasReason(reason: string | undefined): boolean {
  return typeof reason === "string" && reason.trim().length > 0;
}

function encodeSearchCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset } satisfies SearchCursor), "utf8").toString("base64url");
}

function decodeSearchCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as SearchCursor;
    return Number.isFinite(parsed.offset) ? Math.max(0, Math.floor(parsed.offset)) : 0;
  } catch {
    return 0;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
