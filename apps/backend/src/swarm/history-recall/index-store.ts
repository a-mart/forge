import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import type { HistoryEntryKind } from "@forge/protocol";
import type { SqliteDatabaseConstructor } from "../types.js";
import { createProjectorState, projectCanonicalLine } from "./canonical-projector.js";
import { ftsSafeText } from "./content-policy.js";
import { readCompleteLines, readPrefixTailHash, readSourceGeneration, readSourceStat } from "./jsonl-reader.js";
import {
  INITIAL_WINDOW_ID,
  MAX_INDEX_CATCHUP_BYTES,
  MAX_INDEX_CATCHUP_SOURCES,
  MAX_INDEX_CATCHUP_TOTAL_BYTES,
  type HistorySourceDescriptor,
  type ProjectedHistoryEntry,
} from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  session_agent_id TEXT NOT NULL,
  actor_agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  session_label TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  generation TEXT NOT NULL,
  inode TEXT NOT NULL,
  indexed_bytes INTEGER NOT NULL DEFAULT 0,
  source_size INTEGER NOT NULL DEFAULT 0,
  current_window_id TEXT NOT NULL DEFAULT 'window:initial',
  indexed_tail_hash TEXT NOT NULL DEFAULT '',
  oversized_state INTEGER NOT NULL DEFAULT 0,
  projector_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  source_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT,
  tool_name TEXT,
  timestamp TEXT,
  window_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  parent_id TEXT,
  content_key TEXT NOT NULL,
  text TEXT NOT NULL,
  extra TEXT NOT NULL,
  PRIMARY KEY (source_id, entry_id)
);
CREATE INDEX IF NOT EXISTS entries_source_offset_idx ON entries(source_id, byte_offset);
CREATE INDEX IF NOT EXISTS entries_source_window_idx ON entries(source_id, window_id, byte_offset);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  text,
  extra,
  source_id UNINDEXED,
  entry_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export interface SourceRow {
  source_id: string;
  profile_id: string;
  session_agent_id: string;
  actor_agent_id: string;
  path: string;
  archived: number;
  session_label: string;
  actor_label: string;
  generation: string;
  inode: string;
  indexed_bytes: number;
  source_size: number;
  current_window_id: string;
  indexed_tail_hash: string;
  oversized_state: number;
  projector_json: string;
  updated_at: string;
}

export interface EntryRow {
  source_id: string;
  entry_id: string;
  kind: HistoryEntryKind;
  role: "user" | "assistant" | null;
  tool_name: string | null;
  timestamp: string | null;
  window_id: string;
  origin: string;
  byte_offset: number;
  parent_id: string | null;
  content_key: string;
  text: string;
  extra: string;
}

export interface IndexedSourceState {
  sourceId: string;
  generation: string;
  indexedBytes: number;
  sourceSize: number;
  incomplete: boolean;
}

export class HistoryRecallIndexStore {
  private readonly insertSource: Database.Statement;
  private readonly updateSource: Database.Statement;
  private readonly getSource: Database.Statement;
  private readonly listSourceIds: Database.Statement;
  private readonly deleteSource: Database.Statement;
  private readonly deleteEntries: Database.Statement;
  private readonly deleteFts: Database.Statement;
  private readonly insertEntry: Database.Statement;
  private readonly insertFts: Database.Statement;
  private readonly deleteEntry: Database.Statement;
  private readonly deleteFtsEntry: Database.Statement;
  private readonly getEntry: Database.Statement;
  private readonly neighborsBefore: Database.Statement;
  private readonly neighborsAfter: Database.Statement;
  private readonly retagWindow: Database.Statement;
  private readonly distinctWindows: Database.Statement;
  readonly database: Database.Database;

  constructor(database: Database.Database) {
    this.database = database;
    this.insertSource = database.prepare(`
      INSERT INTO sources (
        source_id, profile_id, session_agent_id, actor_agent_id, path, archived,
        session_label, actor_label, generation, inode, indexed_bytes, source_size,
        current_window_id, indexed_tail_hash, oversized_state, projector_json, updated_at
      ) VALUES (
        @source_id, @profile_id, @session_agent_id, @actor_agent_id, @path, @archived,
        @session_label, @actor_label, @generation, @inode, @indexed_bytes, @source_size,
        @current_window_id, @indexed_tail_hash, @oversized_state, @projector_json, @updated_at
      )
    `);
    this.updateSource = database.prepare(`
      UPDATE sources SET
        profile_id=@profile_id, session_agent_id=@session_agent_id, actor_agent_id=@actor_agent_id,
        path=@path, archived=@archived, session_label=@session_label, actor_label=@actor_label,
        generation=@generation, inode=@inode, indexed_bytes=@indexed_bytes, source_size=@source_size,
        current_window_id=@current_window_id, indexed_tail_hash=@indexed_tail_hash,
        oversized_state=@oversized_state, projector_json=@projector_json, updated_at=@updated_at
      WHERE source_id=@source_id
    `);
    this.getSource = database.prepare("SELECT * FROM sources WHERE source_id = ?");
    this.listSourceIds = database.prepare("SELECT source_id FROM sources");
    this.deleteSource = database.prepare("DELETE FROM sources WHERE source_id = ?");
    this.deleteEntries = database.prepare("DELETE FROM entries WHERE source_id = ?");
    this.deleteFts = database.prepare("DELETE FROM entries_fts WHERE source_id = ?");
    this.insertEntry = database.prepare(`
      INSERT INTO entries (
        source_id, entry_id, kind, role, tool_name, timestamp, window_id, origin,
        byte_offset, parent_id, content_key, text, extra
      ) VALUES (
        @source_id, @entry_id, @kind, @role, @tool_name, @timestamp, @window_id, @origin,
        @byte_offset, @parent_id, @content_key, @text, @extra
      )
    `);
    this.insertFts = database.prepare(`
      INSERT INTO entries_fts (text, extra, source_id, entry_id)
      VALUES (@text, @extra, @source_id, @entry_id)
    `);
    this.deleteEntry = database.prepare("DELETE FROM entries WHERE source_id = ? AND entry_id = ?");
    this.deleteFtsEntry = database.prepare("DELETE FROM entries_fts WHERE source_id = ? AND entry_id = ?");
    this.getEntry = database.prepare("SELECT * FROM entries WHERE source_id = ? AND entry_id = ?");
    this.neighborsBefore = database.prepare(`
      SELECT * FROM entries WHERE source_id = ? AND byte_offset < ? ORDER BY byte_offset DESC LIMIT ?
    `);
    this.neighborsAfter = database.prepare(`
      SELECT * FROM entries WHERE source_id = ? AND byte_offset > ? ORDER BY byte_offset ASC LIMIT ?
    `);
    this.retagWindow = database.prepare(`
      UPDATE entries SET window_id = ? WHERE source_id = ? AND byte_offset >= ? AND byte_offset <= ?
    `);
    this.distinctWindows = database.prepare(`
      SELECT DISTINCT window_id FROM entries WHERE source_id = ? AND window_id != ?
    `);
  }

  static async open(
    path: string,
    loadDatabaseModule: () => Promise<SqliteDatabaseConstructor>,
  ): Promise<HistoryRecallIndexStore> {
    const DatabaseConstructor = await loadDatabaseModule();
    mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseConstructor(path);
    try {
      database.pragma("journal_mode = WAL");
      database.pragma("foreign_keys = ON");
      database.exec(SCHEMA_SQL);
      ensureSourceColumns(database);
      ensureIndexSchemaVersion(database);
      return new HistoryRecallIndexStore(database);
    } catch (error) {
      if (database.open) {
        database.close();
      }
      throw error;
    }
  }

  close(): void {
    if (this.database.open) {
      this.database.close();
    }
  }

  getSourceRow(sourceId: string): SourceRow | undefined {
    return this.getSource.get(sourceId) as SourceRow | undefined;
  }

  getIndexedEntry(sourceId: string, entryId: string): EntryRow | undefined {
    return this.getEntry.get(sourceId, entryId) as EntryRow | undefined;
  }

  getCurrentWindowId(sourceId: string): string {
    const row = this.getSourceRow(sourceId);
    return row?.current_window_id || INITIAL_WINDOW_ID;
  }

  listNonCurrentWindowIds(sourceId: string): string[] {
    const current = this.getCurrentWindowId(sourceId);
    return (this.distinctWindows.all(sourceId, current) as Array<{ window_id: string }>)
      .map((row) => row.window_id);
  }

  listNeighbors(sourceId: string, byteOffset: number, before: number, after: number): { before: EntryRow[]; after: EntryRow[] } {
    const beforeRows = before > 0
      ? (this.neighborsBefore.all(sourceId, byteOffset, before) as EntryRow[]).reverse()
      : [];
    const afterRows = after > 0
      ? this.neighborsAfter.all(sourceId, byteOffset, after) as EntryRow[]
      : [];
    return { before: beforeRows, after: afterRows };
  }

  search(params: {
    ftsMatch: string;
    sourceIds: string[];
    sourceWindows?: Array<{ sourceId: string; windowIds: string[] }>;
    kinds?: HistoryEntryKind[];
    toolName?: string;
    role?: "user" | "assistant";
    since?: string;
    until?: string;
    limit: number;
    offset: number;
  }): Array<EntryRow & { score: number }> {
    if (!params.ftsMatch) {
      return [];
    }
    const clauses = ["entries_fts MATCH @ftsMatch"];
    const bindings: Record<string, unknown> = {
      ftsMatch: params.ftsMatch,
      limit: params.limit,
      offset: params.offset,
    };
    if (params.sourceWindows) {
      const parts: string[] = [];
      params.sourceWindows.forEach((source, index) => {
        if (source.windowIds.length === 0) {
          return;
        }
        bindings[`s${index}`] = source.sourceId;
        const windowPlaceholders = source.windowIds.map((_, windowIndex) => {
          const key = `w${index}_${windowIndex}`;
          bindings[key] = source.windowIds[windowIndex];
          return `@${key}`;
        });
        parts.push(`(entries.source_id = @s${index} AND entries.window_id IN (${windowPlaceholders.join(", ")}))`);
      });
      if (parts.length === 0) {
        return [];
      }
      clauses.push(`(${parts.join(" OR ")})`);
    } else {
      if (params.sourceIds.length === 0) {
        return [];
      }
      clauses.push(`entries.source_id IN (${params.sourceIds.map((_, index) => `@s${index}`).join(", ")})`);
      params.sourceIds.forEach((sourceId, index) => {
        bindings[`s${index}`] = sourceId;
      });
    }
    if (params.kinds && params.kinds.length > 0) {
      clauses.push(`entries.kind IN (${params.kinds.map((_, index) => `@k${index}`).join(", ")})`);
      params.kinds.forEach((kind, index) => {
        bindings[`k${index}`] = kind;
      });
    }
    if (params.toolName) {
      clauses.push("entries.tool_name = @toolName");
      bindings.toolName = params.toolName;
    }
    if (params.role) {
      clauses.push("entries.role = @role");
      bindings.role = params.role;
    }
    if (params.since) {
      clauses.push("entries.timestamp >= @since");
      bindings.since = params.since;
    }
    if (params.until) {
      clauses.push("entries.timestamp <= @until");
      bindings.until = params.until;
    }
    const sql = `
      SELECT entries.*, bm25(entries_fts) AS score
      FROM entries_fts
      JOIN entries ON entries.source_id = entries_fts.source_id AND entries.entry_id = entries_fts.entry_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY score ASC, COALESCE(entries.timestamp, '') DESC, entries.byte_offset DESC
      LIMIT @limit OFFSET @offset
    `;
    return this.database.prepare(sql).all(bindings) as Array<EntryRow & { score: number }>;
  }

  reconcileSources(
    sources: HistorySourceDescriptor[],
    options?: { liveSourceIds?: Iterable<string> },
  ): { incomplete: boolean; warnings: string[] } {
    const warnings: string[] = [];
    let incomplete = false;
    let remainingBytes = MAX_INDEX_CATCHUP_TOTAL_BYTES;
    if (options?.liveSourceIds) {
      const liveIds = new Set(options.liveSourceIds);
      for (const row of this.listSourceIds.all() as Array<{ source_id: string }>) {
        if (!liveIds.has(row.source_id)) {
          this.purgeSource(row.source_id);
        }
      }
    }

    let processed = 0;
    for (const source of sources) {
      if (processed >= MAX_INDEX_CATCHUP_SOURCES || remainingBytes <= 0) {
        incomplete = true;
        warnings.push("History index catch-up was bounded; some sources were not fully scanned.");
        break;
      }
      const budget = Math.min(MAX_INDEX_CATCHUP_BYTES, remainingBytes);
      const result = this.ingestSource(source, budget);
      remainingBytes -= result.scannedBytes;
      // Already-current sources must not starve later sources on every query.
      if (result.scannedBytes > 0) processed += 1;
      if (result.incomplete) {
        incomplete = true;
      }
      warnings.push(...result.warnings);
    }
    return { incomplete, warnings: unique(warnings) };
  }

  purgeSession(sessionAgentId: string): void {
    const rows = this.database.prepare("SELECT source_id FROM sources WHERE session_agent_id = ?").all(sessionAgentId) as Array<{ source_id: string }>;
    for (const row of rows) {
      this.purgeSource(row.source_id);
    }
  }

  ingestSource(source: HistorySourceDescriptor, maxBytes: number): IndexedSourceState & { scannedBytes: number; warnings: string[] } {
    const warnings: string[] = [];
    const stat = readSourceStat(source.path);
    if (!stat) {
      this.purgeSource(source.sourceId);
      return {
        sourceId: source.sourceId,
        generation: "",
        indexedBytes: 0,
        sourceSize: 0,
        incomplete: false,
        scannedBytes: 0,
        warnings,
      };
    }
    const generation = readSourceGeneration(source.path, stat);
    const existing = this.getSource.get(source.sourceId) as SourceRow | undefined;
    const replaced = Boolean(existing && (
      existing.generation !== generation
      || existing.inode !== stat.ino
      || prefixReplaced(source.path, existing)
    ));
    const truncated = Boolean(existing && !replaced && stat.size < existing.indexed_bytes);
    if (replaced || truncated) {
      this.purgeSource(source.sourceId);
    }

    const current = (replaced || truncated ? undefined : existing);
    const startOffset = current?.indexed_bytes ?? 0;
    if (startOffset >= stat.size) {
      this.upsertSource(
        source,
        generation,
        stat,
        startOffset,
        current?.current_window_id ?? INITIAL_WINDOW_ID,
        current?.indexed_tail_hash ?? readPrefixTailHash(source.path, startOffset),
        current?.projector_json ?? serializeProjector(createProjectorState()),
        current?.oversized_state ?? 0,
      );
      if (current?.oversized_state) warnings.push(`Indexing of ${source.sessionLabel}/${source.actorLabel} skipped oversized JSONL rows.`);
      return {
        sourceId: source.sourceId,
        generation,
        indexedBytes: startOffset,
        sourceSize: stat.size,
        incomplete: Boolean(current?.oversized_state),
        scannedBytes: 0,
        warnings,
      };
    }

    const projector = current?.projector_json
      ? deserializeProjector(current.projector_json)
      : createProjectorState();
    const { lines, nextOffset, incomplete, scannedBytes, skippedOversized, skippingOversized } = readCompleteLines(
      source.path,
      startOffset,
      stat.size,
      maxBytes,
      { resumeSkippingOversized: current?.oversized_state === 1 },
    );
    const oversizedState = skippingOversized ? 1 : (skippedOversized || current?.oversized_state ? 2 : 0);
    const insertBatch = this.database.transaction((entries: ProjectedHistoryEntry[]) => {
      for (const entry of entries) {
        this.writeProjected(source.sourceId, entry);
      }
      this.upsertSource(
        source,
        generation,
        stat,
        nextOffset,
        projector.windowId,
        readPrefixTailHash(source.path, nextOffset),
        serializeProjector(projector),
        oversizedState,
      );
    });
    insertBatch(lines.flatMap((line) => {
      const projected = projectCanonicalLine(line.line, line.byteOffset, projector, "index");
      return projected ? [projected] : [];
    }));

    if (incomplete) {
      warnings.push(`Indexing of ${source.sessionLabel}/${source.actorLabel} is incomplete.`);
    }
    if (oversizedState) {
      warnings.push(`Indexing of ${source.sessionLabel}/${source.actorLabel} skipped oversized JSONL rows.`);
    }
    return {
      sourceId: source.sourceId,
      generation,
      indexedBytes: nextOffset,
      sourceSize: stat.size,
      incomplete: incomplete || oversizedState !== 0,
      scannedBytes,
      warnings,
    };
  }

  private writeProjected(sourceId: string, entry: ProjectedHistoryEntry): void {
    if (entry.replacesEntryId && entry.replacesEntryId !== entry.entryId) {
      this.deleteEntry.run(sourceId, entry.replacesEntryId);
      this.deleteFtsEntry.run(sourceId, entry.replacesEntryId);
    }
    this.deleteEntry.run(sourceId, entry.entryId);
    this.deleteFtsEntry.run(sourceId, entry.entryId);
    const row = {
      source_id: sourceId,
      entry_id: entry.entryId,
      kind: entry.kind,
      role: entry.role ?? null,
      tool_name: entry.toolName ?? null,
      timestamp: entry.timestamp ?? null,
      window_id: entry.windowId,
      origin: entry.origin,
      byte_offset: entry.byteOffset,
      parent_id: entry.parentId,
      content_key: entry.contentKey,
      text: entry.text,
      extra: entry.extra,
    };
    this.insertEntry.run(row);
    this.insertFts.run({
      text: ftsSafeText(entry.text),
      extra: ftsSafeText(entry.extra),
      source_id: sourceId,
      entry_id: entry.entryId,
    });
    if (entry.kind === "checkpoint" && entry.retainsFromEntryId) {
      const kept = this.getIndexedEntry(sourceId, entry.retainsFromEntryId);
      if (kept) {
        this.retagWindow.run(entry.windowId, sourceId, kept.byte_offset, entry.byteOffset);
      }
    }
  }

  private upsertSource(
    source: HistorySourceDescriptor,
    generation: string,
    stat: { size: number; ino: string },
    indexedBytes: number,
    currentWindowId: string,
    indexedTailHash: string,
    projectorJson: string,
    oversizedState: number,
  ): void {
    const row = {
      source_id: source.sourceId,
      profile_id: source.profileId,
      session_agent_id: source.sessionAgentId,
      actor_agent_id: source.actorAgentId,
      path: source.path,
      archived: source.archived ? 1 : 0,
      session_label: source.sessionLabel,
      actor_label: source.actorLabel,
      generation,
      inode: stat.ino,
      indexed_bytes: indexedBytes,
      source_size: stat.size,
      current_window_id: currentWindowId,
      indexed_tail_hash: indexedTailHash,
      projector_json: projectorJson,
      oversized_state: oversizedState,
      updated_at: new Date().toISOString(),
    };
    const existing = this.getSource.get(source.sourceId);
    if (existing) {
      this.updateSource.run(row);
      return;
    }
    this.insertSource.run(row);
  }

  private purgeSource(sourceId: string): void {
    const tx = this.database.transaction(() => {
      this.deleteFts.run(sourceId);
      this.deleteEntries.run(sourceId);
      this.deleteSource.run(sourceId);
    });
    tx();
  }
}

function ensureSourceColumns(database: Database.Database): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("oversized_state")) {
    database.exec("ALTER TABLE sources ADD COLUMN oversized_state INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("current_window_id")) {
    database.exec("ALTER TABLE sources ADD COLUMN current_window_id TEXT NOT NULL DEFAULT 'window:initial'");
  }
  if (!columns.has("indexed_tail_hash")) {
    database.exec("ALTER TABLE sources ADD COLUMN indexed_tail_hash TEXT NOT NULL DEFAULT ''");
  }
}

// The index is derived. Rebuild old projections once so previously omitted
// occurrences are recovered without changing canonical history or source refs.
function ensureIndexSchemaVersion(database: Database.Database): void {
  const version = database.prepare("SELECT value FROM meta WHERE key = 'projection_version'").get() as { value: string } | undefined;
  if (version?.value === "2") return;
  database.transaction(() => {
    database.exec("DELETE FROM entries_fts; DELETE FROM entries; DELETE FROM sources;");
    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('projection_version', '2')").run();
  })();
}

function prefixReplaced(path: string, existing: SourceRow): boolean {
  if (existing.indexed_bytes <= 0 || !existing.indexed_tail_hash) {
    return false;
  }
  const stat = readSourceStat(path);
  if (!stat || stat.size < existing.indexed_bytes) {
    return stat !== undefined && stat.size < existing.indexed_bytes;
  }
  return readPrefixTailHash(path, existing.indexed_bytes) !== existing.indexed_tail_hash;
}

function serializeProjector(state: ReturnType<typeof createProjectorState>): string {
  return JSON.stringify({
    windowId: state.windowId,
    pendingBoundaryId: state.pendingBoundaryId,
    seenContentKeys: [...state.seenContentKeys.entries()],
  });
}

function deserializeProjector(raw: string): ReturnType<typeof createProjectorState> {
  const state = createProjectorState();
  try {
    const parsed = JSON.parse(raw) as {
      windowId?: unknown;
      pendingBoundaryId?: unknown;
      seenContentKeys?: unknown;
    };
    if (typeof parsed.windowId === "string" && parsed.windowId) {
      state.windowId = parsed.windowId;
    }
    if (typeof parsed.pendingBoundaryId === "string" && parsed.pendingBoundaryId) {
      state.pendingBoundaryId = parsed.pendingBoundaryId;
    }
    if (Array.isArray(parsed.seenContentKeys)) {
      for (const entry of parsed.seenContentKeys) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isRecord(entry[1])) {
          continue;
        }
        const value = entry[1];
        if (typeof value.entryId !== "string" || typeof value.text !== "string" || typeof value.windowId !== "string"
          || (value.origin !== "forge_custom" && value.origin !== "native")) {
          continue;
        }
        state.seenContentKeys.set(entry[0], {
          entryId: value.entryId, origin: value.origin, text: value.text, windowId: value.windowId,
          timestamp: typeof value.timestamp === "string" ? value.timestamp : undefined,
        });
      }
    }
  } catch {
    return createProjectorState();
  }
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
