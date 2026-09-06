import { randomUUID } from "node:crypto";
import type {
  HistoryCatalogSnapshot,
  HistoryCoverage,
  HistoryCoverageState,
  HistoryDirtySource,
  HistoryEntryPart,
  HistoryReadEntry,
  HistoryReadOmission,
  HistoryReadRequest,
  HistoryReadResponse,
  HistorySearchHit,
  HistorySearchRequest,
  HistorySearchResponse,
  HistorySearchScope,
  HistorySessionHit,
  HistorySessionsRequest,
  HistorySessionsResponse,
} from "@forge/protocol";
import { getHistoryRecallIndexPath } from "../storage/data-paths.js";
import {
  createProjectorState,
  isProvisionalWindowId,
  projectCanonicalRecord,
} from "./canonical-projector.js";
import {
  buildCenteredSnippet,
  clipText,
  DEFAULT_READ_CHARS,
  MAX_INDEX_TEXT_CHARS,
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
  isCatalogSourceAllowed,
  listIndexableSources,
  listProjectSources,
  listSessionSources,
  resolveCallerSession,
  resolveProfileId,
  sourcesFromCatalog,
} from "./source-catalog.js";
import {
  BACKGROUND_ARCHIVE_SHARE,
  BACKGROUND_SLICE_SOURCES,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SESSION_LIMIT,
  EMPTY_CATALOG,
  IDLE_RECONCILE_MS,
  MAX_INDEX_CATCHUP_BYTES,
  MAX_LIVE_SNAPSHOTS,
  MAX_NEIGHBORS,
  MAX_SEARCH_LIMIT,
  MAX_SESSION_LIMIT,
  MAX_SNAPSHOT_HITS,
  SNAPSHOT_TTL_MS,
  type HistorySearchServiceHost,
  type HistorySourceDescriptor,
} from "./types.js";

interface SnapshotPage<T> {
  id: string;
  identity: string;
  kind: "search" | "sessions";
  createdAt: number;
  expiresAt: number;
  items: T[];
  scope: HistorySearchScope;
  warnings: string[];
  coverage: HistoryCoverage;
  complete: boolean;
}

interface SearchCursor {
  snapshotId?: string;
  offset: number;
}

export class HistorySearchService {
  private storePromise: Promise<HistoryRecallIndexStore> | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private started = false;
  private catalog: HistoryCatalogSnapshot = EMPTY_CATALOG;
  private readonly dirtySourceIds = new Set<string>();
  private backgroundTimer: ReturnType<typeof setTimeout> | undefined;
  private backgroundRunning = false;
  private backgroundWake = false;
  private readonly searchSnapshots = new Map<string, SnapshotPage<HistorySearchHit>>();
  private readonly sessionSnapshots = new Map<string, SnapshotPage<HistorySessionHit>>();
  private activeCursor = 0;
  private archivalCursor = 0;

  constructor(private readonly host: HistorySearchServiceHost) {}

  async start(snapshot: HistoryCatalogSnapshot): Promise<void> {
    this.assertOpen();
    this.replaceCatalog(snapshot);
    this.started = true;
    this.ensureStore();
    this.scheduleBackground(0);
  }

  replaceCatalog(snapshot: HistoryCatalogSnapshot): void {
    this.assertOpen();
    this.catalog = {
      revision: snapshot.revision,
      hydration: snapshot.hydration,
      sources: snapshot.sources.filter((source) => isCatalogSourceAllowed(this.host, source)),
    };
    if (this.started) {
      this.scheduleBackground(0);
    }
  }

  markSourceDirty(source: HistoryDirtySource): void {
    this.assertOpen();
    this.dirtySourceIds.add(`${source.sessionAgentId}:${source.actorAgentId}`);
    if (this.started) {
      this.scheduleBackground(0);
    }
  }

  async invalidateSource(source: HistoryDirtySource): Promise<void> {
    this.assertOpen();
    const sourceId = `${source.sessionAgentId}:${source.actorAgentId}`;
    await this.runExclusive((store) => {
      store.purgeSource(sourceId);
    }).catch(() => undefined);
    this.dirtySourceIds.add(sourceId);
    if (this.started) {
      this.scheduleBackground(0);
    }
  }

  async search(callerAgentId: string, request: HistorySearchRequest): Promise<HistorySearchResponse> {
    this.assertOpen();
    const callerSession = resolveCallerSession(this.host, callerAgentId);
    const query = parseHistoryQuery(request.query ?? "");
    if (query.tokens.length === 0 || !query.ftsMatch) {
      throw new HistoryRecallError("Query must include a searchable term or quoted phrase");
    }
    const resolved = this.resolveSearchSources(callerSession, request);
    const identity = snapshotIdentity("search", callerSession.agentId, request);
    const existing = request.cursor ? this.readSearchCursor(request.cursor, identity) : undefined;
    if (existing) {
      return this.pageSearchSnapshot(existing.page, existing.offset, request.limit);
    }

    return this.runExclusive(async (store) => {
      const catchup = this.catchUpForSearch(store, resolved.sources, request.sessionAgentId);
      const sourceWindows = this.sourceWindows(store, resolved.sources, request.window);
      const limit = clampLimit(request.limit);
      const rows = store.search({
        ftsMatch: query.ftsMatch,
        sourceIds: resolved.sources.map((source) => source.sourceId),
        sourceWindows,
        kinds: request.kinds,
        toolName: request.toolName,
        role: request.role,
        since: request.since,
        until: request.until,
        limit: MAX_SNAPSHOT_HITS + 1,
        offset: 0,
        order: request.order,
        includeHistoryArtifacts: request.includeHistoryArtifacts,
        allowProvisional: !request.window || request.window === "all",
      });
      const capped = rows.length > MAX_SNAPSHOT_HITS;
      const pageRows = capped ? rows.slice(0, MAX_SNAPSHOT_HITS) : rows;
      const sourceById = new Map(resolved.sources.map((source) => [source.sourceId, source]));
      const results: HistorySearchHit[] = [];
      const warnings = [...resolved.warnings, ...catchup.warnings];
      if (capped) {
        warnings.push(`Search snapshot was capped at ${MAX_SNAPSHOT_HITS} hits; narrow the query to continue.`);
      }
      for (const row of pageRows) {
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
            ...(row.part_id ? { partId: row.part_id } : {}),
            ...(row.chunk_index ? { chunkIndex: row.chunk_index } : {}),
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
          ...(row.provisional || isProvisionalWindowId(row.window_id) ? { provisional: true } : {}),
        });
      }
      const coverage = this.buildCoverage(store, resolved.sources, catchup.incomplete || resolved.incomplete);
      const incomplete = catchup.incomplete || resolved.incomplete;
      const snapshot: SnapshotPage<HistorySearchHit> = {
        id: randomUUID(),
        identity,
        kind: "search",
        createdAt: Date.now(),
        expiresAt: Date.now() + SNAPSHOT_TTL_MS,
        items: results,
        scope: resolved.scope,
        warnings: unique([...warnings, ...resolved.scopeNotes]),
        coverage,
        complete: this.started ? conservativeComplete(coverage, incomplete) : !incomplete,
      };
      this.rememberSnapshot(this.searchSnapshots, snapshot);
      return this.pageSearchSnapshot(snapshot, 0, limit);
    });
  }

  async sessions(callerAgentId: string, request: HistorySessionsRequest): Promise<HistorySessionsResponse> {
    this.assertOpen();
    const callerSession = resolveCallerSession(this.host, callerAgentId);
    const resolved = this.resolveSearchSources(callerSession, {
      scope: request.scope,
      sessionAgentId: request.sessionAgentId,
      profileId: request.profileId,
      reason: request.reason,
    });
    const identity = snapshotIdentity("sessions", callerSession.agentId, request);
    const existing = request.cursor ? this.readSessionCursor(request.cursor, identity) : undefined;
    if (existing) {
      return this.pageSessionSnapshot(existing.page, existing.offset, request.limit);
    }
    const query = (request.query ?? "").trim().toLowerCase();
    const grouped = new Map<string, HistorySessionHit>();
    for (const source of resolved.sources) {
      const current = grouped.get(source.sessionAgentId);
      const lastActivityAt = newerTimestamp(current?.lastActivityAt, source.lastActivityAt);
      const actorLabels = unique([...(current?.actorLabels ?? []), source.actorLabel]);
      grouped.set(source.sessionAgentId, {
        sessionAgentId: source.sessionAgentId,
        profileId: source.profileId,
        sessionLabel: source.sessionLabel,
        archived: source.archived || Boolean(current?.archived),
        actorCount: actorLabels.length,
        actorLabels,
        ...(lastActivityAt ? { lastActivityAt } : {}),
        snippet: [source.sessionLabel, ...actorLabels].join(" "),
      });
    }
    let items = [...grouped.values()];
    if (query) {
      items = items.filter((item) => (
        item.sessionLabel.toLowerCase().includes(query)
        || item.actorLabels.some((label) => label.toLowerCase().includes(query))
        || item.sessionAgentId.toLowerCase().includes(query)
        || item.profileId.toLowerCase().includes(query)
      ));
    }
    items.sort((left, right) => {
      if (!left.lastActivityAt && right.lastActivityAt) return 1;
      if (left.lastActivityAt && !right.lastActivityAt) return -1;
      if (left.lastActivityAt && right.lastActivityAt && left.lastActivityAt !== right.lastActivityAt) {
        return right.lastActivityAt.localeCompare(left.lastActivityAt);
      }
      return left.sessionLabel.localeCompare(right.sessionLabel);
    });
    const coverage = await this.runExclusive((store) => this.buildCoverage(store, resolved.sources, resolved.incomplete))
      .catch(() => unknownCoverage(this.catalog, resolved.sources.length, resolved.incomplete));
    const snapshot: SnapshotPage<HistorySessionHit> = {
      id: randomUUID(),
      identity,
      kind: "sessions",
      createdAt: Date.now(),
      expiresAt: Date.now() + SNAPSHOT_TTL_MS,
      items,
      scope: resolved.scope,
      warnings: unique([...resolved.warnings, ...resolved.scopeNotes]),
      coverage,
      complete: conservativeComplete(coverage, resolved.incomplete),
    };
    this.rememberSnapshot(this.sessionSnapshots, snapshot);
    return this.pageSessionSnapshot(snapshot, 0, request.limit);
  }

  async read(callerAgentId: string, request: HistoryReadRequest): Promise<HistoryReadResponse> {
    this.assertOpen();
    resolveCallerSession(this.host, callerAgentId);
    const ref = request.ref;
    if (!ref?.sessionAgentId || !ref.actorAgentId || !ref.entryId || !ref.sourceVersion) {
      throw new HistoryRecallError("Read requires a source-qualified history reference");
    }
    const source = findSource(this.host, ref.sessionAgentId, ref.actorAgentId, this.started ? this.catalog : undefined);
    if (!source) {
      throw new HistoryRecallError("History source not found", 404);
    }
    const generation = this.currentSourceGeneration(source);
    if (!generation || generation !== ref.sourceVersion) {
      throw new HistoryRecallError("History reference is stale; the source was replaced or reset", 409);
    }

    if (ref.byteOffset !== undefined) {
      if (!Number.isSafeInteger(ref.byteOffset) || ref.byteOffset < 0) throw new HistoryRecallError("Invalid history byte offset");
      const line = readLineAt(source.path, ref.byteOffset);
      if (!line || line.oversized) throw new HistoryRecallError("Checkpoint evidence is unavailable or exceeds the readable row limit", 404);
      const projected = projectCanonicalRecord(line.line, line.byteOffset, createProjectorState(), "read");
      if (!projected || projected.entryId !== ref.entryId || this.currentSourceGeneration(source) !== generation) {
        throw new HistoryRecallError("History reference is stale or does not identify this row", 409);
      }
      const selected = selectReadParts(projected.parts, ref.partId, ref.chunkIndex);
      const entry = this.toReadEntry(
        source,
        generation,
        combineReadParts(projected, selected),
        Math.max(0, request.offset ?? chunkStart(ref.chunkIndex)),
        clampReadChars(request.maxChars),
        { remaining: MAX_READ_RESPONSE_CHARS },
        selected,
      );
      entry.ref.byteOffset = ref.byteOffset;
      return {
        entry,
        before: [],
        after: [],
        warnings: request.before || request.after
          ? ["Checkpoint direct reads omit neighbors; use search for indexed context expansion."]
          : [],
      };
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
      if (ref.partId) {
        const parts = store.listIndexedParts(source.sourceId, ref.entryId);
        if (!parts.some((part) => part.part_id === ref.partId && (ref.chunkIndex === undefined || part.chunk_index === ref.chunkIndex))) {
          throw new HistoryRecallError("History part was not found on this entry", 404);
        }
      }
      const neighbors = store.listNeighbors(source.sourceId, indexed.byte_offset, clampNeighbors(request.before), clampNeighbors(request.after), indexed);
      const budget = { remaining: MAX_READ_RESPONSE_CHARS };
      const warnings: string[] = [];
      const main = this.readIndexedEntry(source, generation, indexed, request, budget, warnings);
      const before = neighbors.before.map((row) => this.readIndexedEntry(source, generation, row, { ref: { ...ref, entryId: row.entry_id, partId: undefined, chunkIndex: undefined }, offset: 0, maxChars: clampNeighborChars(budget.remaining) }, budget, warnings));
      const after = neighbors.after.map((row) => this.readIndexedEntry(source, generation, row, { ref: { ...ref, entryId: row.entry_id, partId: undefined, chunkIndex: undefined }, offset: 0, maxChars: clampNeighborChars(budget.remaining) }, budget, warnings));
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
    this.started = false;
    this.backgroundWake = false;
    this.clearBackgroundTimer();
    this.backgroundRunning = false;
    this.searchSnapshots.clear();
    this.sessionSnapshots.clear();
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

  private catchUpForSearch(
    store: HistoryRecallIndexStore,
    sources: HistorySourceDescriptor[],
    sessionAgentId: string | undefined,
  ): { incomplete: boolean; warnings: string[] } {
    if (this.started) {
      const preferred = sessionAgentId
        ? sources.filter((source) => source.sessionAgentId === sessionAgentId)
        : [...sources].sort((left, right) => {
          const leftActivity = left.lastActivityAt ?? "";
          const rightActivity = right.lastActivityAt ?? "";
          if (leftActivity !== rightActivity) {
            return rightActivity.localeCompare(leftActivity);
          }
          return left.sourceId.localeCompare(right.sourceId);
        }).slice(0, 4);
      const warnings: string[] = [];
      let incomplete = this.catalog.hydration !== "complete";
      for (const source of preferred) {
        const result = store.ingestSource(source, MAX_INDEX_CATCHUP_BYTES);
        warnings.push(...result.warnings);
        if (result.incomplete || result.pending) incomplete = true;
      }
      const counts = store.coverageCounts(sources.map((source) => source.sourceId));
      return { incomplete: incomplete || counts.pendingSourceCount > 0, warnings: unique(warnings) };
    }
    return store.reconcileSources(sources, {
      liveSourceIds: listIndexableSources(this.host).map((source) => source.sourceId),
      purgeMissing: true,
    });
  }

  private scheduleBackground(delayMs = 0): void {
    if (!this.started || this.disposed) {
      return;
    }
    if (delayMs === 0) {
      this.backgroundWake = true;
    }
    if (this.backgroundRunning) {
      return;
    }
    if (this.backgroundTimer) {
      if (delayMs === 0) {
        clearTimeout(this.backgroundTimer);
        this.backgroundTimer = undefined;
      } else {
        return;
      }
    }
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = undefined;
      void this.runBackgroundTick();
    }, delayMs);
    this.backgroundTimer.unref?.();
  }

  private clearBackgroundTimer(): void {
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = undefined;
    }
  }

  private async runBackgroundTick(): Promise<void> {
    if (!this.started || this.disposed || this.backgroundRunning) {
      return;
    }
    this.backgroundRunning = true;
    this.backgroundWake = false;
    let pendingWork = false;
    try {
      pendingWork = await this.runExclusive((store) => this.runBackgroundSlice(store));
    } catch {
      pendingWork = true;
    } finally {
      this.backgroundRunning = false;
    }
    if (!this.started || this.disposed) {
      return;
    }
    this.scheduleBackground(pendingWork || this.backgroundWake ? 0 : IDLE_RECONCILE_MS);
  }

  private runBackgroundSlice(store: HistoryRecallIndexStore): boolean {
    const catalogSources = sourcesFromCatalog(this.host, this.catalog);
    const byId = new Map(catalogSources.map((source) => [source.sourceId, source]));
    if (this.catalog.hydration === "complete") {
      for (const sourceId of store.listIndexedSourceIds()) {
        if (!byId.has(sourceId)) {
          store.purgeSource(sourceId);
        }
      }
    }
    const dirtyIds = new Set(this.dirtySourceIds);
    this.dirtySourceIds.clear();
    const dirty = catalogSources.filter((source) => dirtyIds.has(source.sourceId));
    const active = catalogSources.filter((source) => !source.archived);
    const archives = catalogSources.filter((source) => source.archived);
    const wantsWork = (source: HistorySourceDescriptor): boolean => dirtyIds.has(source.sourceId) || store.needsScan(source);
    const promoted = dirty.slice(0, 2);
    const remainingSlots = BACKGROUND_SLICE_SOURCES - promoted.length;
    const archiveNeed = archives.some((source) => !promoted.some((entry) => entry.sourceId === source.sourceId) && wantsWork(source));
    const archiveShare = archiveNeed ? Math.min(BACKGROUND_ARCHIVE_SHARE, remainingSlots) : 0;
    const activeShare = remainingSlots - archiveShare;
    const skipPromoted = (source: HistorySourceDescriptor): boolean => !promoted.some((entry) => entry.sourceId === source.sourceId);
    const activePick = takeRotating(active, this.activeCursor, activeShare, (source) => skipPromoted(source) && wantsWork(source));
    const archivePick = takeRotating(archives, this.archivalCursor, archiveShare, (source) => skipPromoted(source) && wantsWork(source));
    this.activeCursor = activePick.nextCursor;
    this.archivalCursor = archivePick.nextCursor;
    const queue = uniqueSources([...promoted, ...activePick.picked, ...archivePick.picked]);
    if (queue.length === 0) {
      return this.dirtySourceIds.size > 0;
    }
    store.reconcileSources(queue, {
      preferRecent: false,
      purgeMissing: false,
      maxSources: BACKGROUND_SLICE_SOURCES,
      maxBytes: MAX_INDEX_CATCHUP_BYTES,
      perSourceBytes: MAX_INDEX_CATCHUP_BYTES,
    });
    const stillPending = catalogSources.some((source) => store.needsScan(source)) || this.dirtySourceIds.size > 0;
    return stillPending;
  }

  private ensureStore(): void {
    void this.getStore().catch(() => undefined);
  }

  private runExclusive<T>(operation: (store: HistoryRecallIndexStore) => T | Promise<T>): Promise<T> {
    const run = this.writeChain.then(async () => {
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
      ).catch((error) => {
        this.storePromise = undefined;
        throw error;
      });
    }
    return this.storePromise;
  }

  private resolveSearchSources(callerSession: ReturnType<typeof resolveCallerSession>, request: Pick<HistorySearchRequest, "scope" | "sessionAgentId" | "profileId" | "reason">): {
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
    const catalogSources = this.started && this.catalog.hydration === "complete"
      ? sourcesFromCatalog(this.host, this.catalog)
      : undefined;
    const incomplete = this.started ? this.catalog.hydration !== "complete" : false;

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
          sources: catalogSources
            ? catalogSources.filter((source) => source.sessionAgentId === targetSession.agentId)
            : listSessionSources(this.host, targetSession),
          warnings,
          scopeNotes: [
            ...scopeNotes,
            `Effective scope is session ${targetSession.sessionLabel ?? targetSession.agentId}, including associated workers.`,
          ],
          incomplete,
        };
      }
      return {
        scope: outsideProject ? "all_local" : "project",
        sources: catalogSources
          ? catalogSources.filter((source) => source.profileId === targetProfileId)
          : listProjectSources(this.host, targetProfileId!),
        warnings,
        scopeNotes: [
          ...scopeNotes,
          `Effective scope is project ${targetProfileId}, including sessions and archives.`,
        ],
        incomplete,
      };
    }

    if (scope === "session") {
      return {
        scope,
        sources: catalogSources
          ? catalogSources.filter((source) => source.sessionAgentId === callerSession.agentId)
          : listSessionSources(this.host, callerSession),
        warnings,
        scopeNotes: ["Effective scope is the current session, including associated workers."],
        incomplete,
      };
    }
    if (scope === "project") {
      return {
        scope,
        sources: catalogSources
          ? catalogSources.filter((source) => source.profileId === callerProfileId)
          : listProjectSources(this.host, callerProfileId),
        warnings,
        scopeNotes: ["Effective scope is the current project, including sessions and archives."],
        incomplete,
      };
    }
    if (!hasReason(request.reason)) {
      throw new HistoryRecallError("Searching outside the current project requires a specific reason");
    }
    scopeNotes.push(`Outside-project search reason: ${request.reason!.trim()}`);
    scopeNotes.push("Effective scope is all local Builder projects, excluding restricted Cortex, Collaboration, plugin, and capture-check sources.");
    return {
      scope,
      sources: catalogSources ?? listIndexableSources(this.host),
      warnings,
      scopeNotes,
      incomplete,
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

  private buildCoverage(
    store: HistoryRecallIndexStore,
    sources: HistorySourceDescriptor[],
    incomplete: boolean,
  ): HistoryCoverage {
    const counts = store.coverageCounts(sources.map((source) => source.sourceId));
    const hydration = this.started ? this.catalog.hydration : "partial";
    const pendingSourceCount = Math.max(counts.pendingSourceCount, incomplete && counts.pendingSourceCount === 0 ? 1 : 0);
    const state = coverageState({
      unavailable: sources.length > 0 && counts.unreadableSourceCount >= sources.length,
      pending: pendingSourceCount > 0 || hydration === "partial" && this.started,
      omitted: counts.omittedEligibleText,
    });
    return {
      catalogHydration: hydration,
      state,
      catalogRevision: this.catalog.revision,
      pendingSourceCount,
      unreadableSourceCount: counts.unreadableSourceCount,
      omittedEligibleText: counts.omittedEligibleText,
      ...(hydration === "complete" ? { eligibleSourceCount: sources.length } : {}),
    };
  }

  private readIndexedEntry(
    source: HistorySourceDescriptor,
    generation: string,
    row: EntryRow,
    request: Pick<HistoryReadRequest, "ref" | "offset" | "maxChars">,
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
        entryId: row.entry_id,
        kind: row.kind,
        timestamp: row.timestamp ?? undefined,
        role: row.role ?? undefined,
        toolName: row.tool_name ?? undefined,
        windowId: row.window_id,
        text: OVERSIZED_LINE_WARNING,
        partId: row.part_id || undefined,
      }, 0, Math.min(clampReadChars(request.maxChars), budget.remaining), budget, [], [{
        reason: "oversized",
        detail: OVERSIZED_LINE_WARNING,
      }]);
    }
    const projected = projectCanonicalRecord(line.line, line.byteOffset, createProjectorState({
      windowId: isProvisionalWindowId(row.window_id) ? undefined : row.window_id,
    }), "read");
    if (!projected || projected.entryId !== row.entry_id) {
      throw new HistoryRecallError("History reference is stale or does not identify this row", 409);
    }
    if (request.ref.entryId && request.ref.entryId !== projected.entryId) {
      throw new HistoryRecallError("History reference is stale or does not identify this row", 409);
    }
    const selected = selectReadParts(projected.parts, request.ref.partId, request.ref.chunkIndex);
    const combined = combineReadParts(projected, selected);
    const offset = Math.max(0, request.offset ?? chunkStart(request.ref.chunkIndex));
    return this.toReadEntry(
      source,
      generation,
      combined,
      offset,
      Math.min(clampReadChars(request.maxChars), Math.max(0, budget.remaining)),
      budget,
      selected,
    );
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
      partId?: string;
    },
    offset: number,
    maxChars: number,
    budget: { remaining: number },
    parts: HistoryEntryPart[] = [],
    omissions: HistoryReadOmission[] = [],
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
        ...(entry.partId ? { partId: entry.partId } : {}),
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
      ...(parts.length > 1 || entry.partId ? { parts } : {}),
      ...(omissions.length > 0 ? { omissions } : {}),
    };
  }

  private pageSearchSnapshot(page: SnapshotPage<HistorySearchHit>, offset: number, limit: number | undefined): HistorySearchResponse {
    const size = clampLimit(limit);
    if (offset > page.items.length) {
      throw new HistoryRecallError("History search snapshot does not contain this page", 400, "snapshot_cap_exceeded");
    }
    const results = page.items.slice(offset, offset + size);
    const hasMore = offset + results.length < page.items.length;
    return {
      scope: page.scope,
      results,
      ...(hasMore ? { nextCursor: encodeSearchCursor({ snapshotId: page.id, offset: offset + results.length }) } : {}),
      complete: page.complete,
      warnings: page.warnings,
      coverage: page.coverage,
      snapshotId: page.id,
      snapshotExpiresAt: new Date(page.expiresAt).toISOString(),
    };
  }

  private pageSessionSnapshot(page: SnapshotPage<HistorySessionHit>, offset: number, limit: number | undefined): HistorySessionsResponse {
    const size = clampSessionLimit(limit);
    if (offset > page.items.length) {
      throw new HistoryRecallError("History session snapshot does not contain this page", 400, "snapshot_cap_exceeded");
    }
    const results = page.items.slice(offset, offset + size);
    const hasMore = offset + results.length < page.items.length;
    return {
      scope: page.scope,
      results,
      ...(hasMore ? { nextCursor: encodeSearchCursor({ snapshotId: page.id, offset: offset + results.length }) } : {}),
      warnings: page.warnings,
      coverage: page.coverage,
      snapshotId: page.id,
      snapshotExpiresAt: new Date(page.expiresAt).toISOString(),
    };
  }

  private readSearchCursor(cursor: string, identity: string): { page: SnapshotPage<HistorySearchHit>; offset: number } | undefined {
    const parsed = decodeSearchCursor(cursor);
    if (!parsed.snapshotId) {
      return undefined;
    }
    const page = this.searchSnapshots.get(parsed.snapshotId);
    this.assertSnapshot(page, identity);
    return { page: page!, offset: parsed.offset };
  }

  private readSessionCursor(cursor: string, identity: string): { page: SnapshotPage<HistorySessionHit>; offset: number } | undefined {
    const parsed = decodeSearchCursor(cursor);
    if (!parsed.snapshotId) {
      return undefined;
    }
    const page = this.sessionSnapshots.get(parsed.snapshotId);
    this.assertSnapshot(page, identity);
    return { page: page!, offset: parsed.offset };
  }

  private assertSnapshot(page: SnapshotPage<unknown> | undefined, identity: string): void {
    if (!page) {
      throw new HistoryRecallError("History snapshot expired", 400, "snapshot_expired");
    }
    if (page.expiresAt <= Date.now()) {
      this.searchSnapshots.delete(page.id);
      this.sessionSnapshots.delete(page.id);
      throw new HistoryRecallError("History snapshot expired", 400, "snapshot_expired");
    }
    if (page.identity !== identity) {
      throw new HistoryRecallError("History snapshot does not match this query", 400, "snapshot_mismatch");
    }
  }

  private rememberSnapshot<T>(map: Map<string, SnapshotPage<T>>, snapshot: SnapshotPage<T>): void {
    map.set(snapshot.id, snapshot);
    while (map.size > MAX_LIVE_SNAPSHOTS) {
      const oldest = [...map.values()].sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!oldest) {
        break;
      }
      map.delete(oldest.id);
    }
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new HistoryRecallError("History search service has been disposed", 503);
    }
  }
}

function selectReadParts(
  parts: Array<{ partId: string; kind: HistoryReadEntry["kind"]; role?: "user" | "assistant"; toolName?: string; text: string; chunkIndex: number }>,
  partId: string | undefined,
  chunkIndex: number | undefined,
): HistoryEntryPart[] {
  const mapped = parts.map((part) => ({
    partId: part.partId,
    kind: part.kind,
    role: part.role,
    toolName: part.toolName,
    text: part.text,
    ...(part.chunkIndex ? { chunkIndex: part.chunkIndex } : {}),
  }));
  if (!partId) {
    return mapped;
  }
  const selected = mapped.filter((part) => part.partId === partId);
  if (selected.length === 0) {
    throw new HistoryRecallError("History part was not found on this entry", 404);
  }
  if (chunkIndex === undefined) {
    return selected;
  }
  const chunk = selected.filter((part) => (part.chunkIndex ?? 0) === chunkIndex);
  return chunk.length > 0 ? chunk : selected;
}

function combineReadParts(
  record: { entryId: string; windowId: string; parts: Array<{ kind: HistoryReadEntry["kind"]; role?: "user" | "assistant"; toolName?: string; text: string; timestamp?: string; partId: string }> },
  selected: HistoryEntryPart[],
): {
  entryId: string;
  kind: HistoryReadEntry["kind"];
  timestamp?: string;
  role?: "user" | "assistant";
  toolName?: string;
  windowId: string;
  text: string;
  partId?: string;
} {
  const primary = selected[0] ?? {
    partId: "message",
    kind: "message" as const,
    text: "",
  };
  const combinedText = selected.map((part) => part.text).join(selected.length > 1 ? "\n" : "");
  const sameKind = selected.every((part) => part.kind === primary.kind);
  return {
    entryId: record.entryId,
    kind: primary.kind,
    role: sameKind ? primary.role : undefined,
    toolName: selected.length === 1 ? primary.toolName : undefined,
    windowId: record.windowId,
    text: combinedText,
    partId: selected.length === 1 ? primary.partId : undefined,
    timestamp: record.parts[0]?.timestamp,
  };
}

function chunkStart(chunkIndex: number | undefined): number {
  if (!Number.isSafeInteger(chunkIndex) || !chunkIndex || chunkIndex < 0) {
    return 0;
  }
  return chunkIndex * MAX_INDEX_TEXT_CHARS;
}

function coverageState(input: { unavailable: boolean; pending: boolean; omitted: boolean }): HistoryCoverageState {
  if (input.unavailable) {
    return "unavailable";
  }
  if (input.pending) {
    return "building";
  }
  if (input.omitted) {
    return "degraded";
  }
  return "ready";
}

function conservativeComplete(coverage: HistoryCoverage, incomplete: boolean): boolean {
  return !incomplete && coverage.state === "ready" && coverage.catalogHydration !== "partial";
}

function unknownCoverage(catalog: HistoryCatalogSnapshot, sourceCount: number, incomplete: boolean): HistoryCoverage {
  return {
    catalogHydration: catalog.hydration,
    state: incomplete ? "building" : "unavailable",
    catalogRevision: catalog.revision,
    pendingSourceCount: incomplete ? Math.max(1, sourceCount) : 0,
    unreadableSourceCount: 0,
    omittedEligibleText: false,
  };
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit!)));
}

function clampSessionLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_SESSION_LIMIT;
  }
  return Math.max(1, Math.min(MAX_SESSION_LIMIT, Math.floor(limit!)));
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

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSearchCursor(cursor: string | undefined): SearchCursor {
  if (!cursor) {
    return { offset: 0 };
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as SearchCursor;
    return {
      snapshotId: typeof parsed.snapshotId === "string" ? parsed.snapshotId : undefined,
      offset: Number.isFinite(parsed.offset) ? Math.max(0, Math.floor(parsed.offset)) : 0,
    };
  } catch {
    throw new HistoryRecallError("History snapshot expired", 400, "snapshot_expired");
  }
}

function snapshotIdentity(kind: string, callerSessionId: string, request: object): string {
  const rest = { ...(request as Record<string, unknown>) };
  delete rest.cursor;
  delete rest.limit;
  return JSON.stringify({ kind, callerSessionId, request: rest });
}

function newerTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return right > left ? right : left;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function takeRotating<T>(
  items: T[],
  cursor: number,
  count: number,
  want: (item: T) => boolean,
): { picked: T[]; nextCursor: number } {
  if (items.length === 0 || count <= 0) {
    return { picked: [], nextCursor: cursor };
  }
  const picked: T[] = [];
  let scanned = 0;
  const start = ((cursor % items.length) + items.length) % items.length;
  while (picked.length < count && scanned < items.length) {
    const item = items[(start + scanned) % items.length]!;
    scanned += 1;
    if (want(item)) {
      picked.push(item);
    }
  }
  return { picked, nextCursor: (start + Math.max(scanned, 1)) % items.length };
}

function uniqueSources(sources: HistorySourceDescriptor[]): HistorySourceDescriptor[] {
  const seen = new Set<string>();
  const uniqueList: HistorySourceDescriptor[] = [];
  for (const source of sources) {
    if (seen.has(source.sourceId)) {
      continue;
    }
    seen.add(source.sourceId);
    uniqueList.push(source);
  }
  return uniqueList;
}
