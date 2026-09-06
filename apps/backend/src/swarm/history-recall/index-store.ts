import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import type { HistoryEntryKind, HistorySearchOrder } from "@forge/protocol";
import type { SqliteDatabaseConstructor } from "../types.js";
import {
  createProjectorState,
  isProvisionalWindowId,
  projectCanonicalRecord,
} from "./canonical-projector.js";
import { ftsSafeText, MAX_LINE_BYTES } from "./content-policy.js";
import {
  readCompleteLines,
  readPrefixTailHash,
  readSourceGeneration,
  readSourceStat,
  readTailLines,
} from "./jsonl-reader.js";
import {
  HISTORY_TOOL_NAME,
  INDEX_SCHEMA_VERSION,
  INITIAL_WINDOW_ID,
  MAX_INDEX_CATCHUP_BYTES,
  MAX_INDEX_CATCHUP_SOURCES,
  MAX_INDEX_CATCHUP_TOTAL_BYTES,
  SCAN_BATCH_BYTES,
  type HistorySourceDescriptor,
  type ProjectedHistoryEntry,
  type ProjectorState,
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
  last_activity_at TEXT,
  generation TEXT NOT NULL,
  inode TEXT NOT NULL,
  indexed_bytes INTEGER NOT NULL DEFAULT 0,
  source_size INTEGER NOT NULL DEFAULT 0,
  current_window_id TEXT NOT NULL DEFAULT 'window:initial',
  indexed_tail_hash TEXT NOT NULL DEFAULT '',
  oversized_state INTEGER NOT NULL DEFAULT 0,
  projector_json TEXT NOT NULL,
  prefix_bytes INTEGER NOT NULL DEFAULT 0,
  suffix_start INTEGER NOT NULL DEFAULT 0,
  suffix_end INTEGER NOT NULL DEFAULT 0,
  prefix_tail_hash TEXT NOT NULL DEFAULT '',
  suffix_head_hash TEXT NOT NULL DEFAULT '',
  suffix_tail_hash TEXT NOT NULL DEFAULT '',
  prefix_projector_json TEXT NOT NULL DEFAULT '{}',
  suffix_projector_json TEXT NOT NULL DEFAULT '{}',
  prefix_oversized INTEGER NOT NULL DEFAULT 0,
  suffix_oversized INTEGER NOT NULL DEFAULT 0,
  omitted_eligible_text INTEGER NOT NULL DEFAULT 0,
  suffix_ready INTEGER NOT NULL DEFAULT 0,
  replay_frontier INTEGER NOT NULL DEFAULT 0,
  unreadable INTEGER NOT NULL DEFAULT 0,
  catalog_revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  source_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  part_id TEXT NOT NULL DEFAULT '',
  chunk_index INTEGER NOT NULL DEFAULT 0,
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
  slice TEXT NOT NULL DEFAULT 'prefix',
  provisional INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, entry_id, part_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS entries_source_offset_idx ON entries(source_id, byte_offset, part_id, chunk_index);
CREATE INDEX IF NOT EXISTS entries_source_window_idx ON entries(source_id, window_id, byte_offset);
CREATE INDEX IF NOT EXISTS entries_parent_idx ON entries(source_id, parent_id, byte_offset);
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
  last_activity_at: string | null;
  generation: string;
  inode: string;
  indexed_bytes: number;
  source_size: number;
  current_window_id: string;
  indexed_tail_hash: string;
  oversized_state: number;
  projector_json: string;
  prefix_bytes: number;
  suffix_start: number;
  suffix_end: number;
  prefix_tail_hash: string;
  suffix_head_hash: string;
  suffix_tail_hash: string;
  prefix_projector_json: string;
  suffix_projector_json: string;
  prefix_oversized: number;
  suffix_oversized: number;
  omitted_eligible_text: number;
  suffix_ready: number;
  replay_frontier: number;
  unreadable: number;
  catalog_revision: number;
  updated_at: string;
}

export interface EntryRow {
  source_id: string;
  entry_id: string;
  part_id: string;
  chunk_index: number;
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
  slice: "prefix" | "suffix";
  provisional: number;
}

export interface IndexedSourceState {
  sourceId: string;
  generation: string;
  indexedBytes: number;
  sourceSize: number;
  incomplete: boolean;
  pending: boolean;
  omittedEligibleText: boolean;
  unreadable: boolean;
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
  private readonly deleteEntryParts: Database.Statement;
  private readonly deleteFtsEntryParts: Database.Statement;
  private readonly deleteSliceRange: Database.Statement;
  private readonly deleteFtsSliceRange: Database.Statement;
  private readonly getEntry: Database.Statement;
  private readonly listEntryParts: Database.Statement;
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
        session_label, actor_label, last_activity_at, generation, inode, indexed_bytes, source_size,
        current_window_id, indexed_tail_hash, oversized_state, projector_json,
        prefix_bytes, suffix_start, suffix_end, prefix_tail_hash, suffix_head_hash, suffix_tail_hash,
        prefix_projector_json, suffix_projector_json, prefix_oversized, suffix_oversized,
        omitted_eligible_text, suffix_ready, replay_frontier, unreadable, catalog_revision, updated_at
      ) VALUES (
        @source_id, @profile_id, @session_agent_id, @actor_agent_id, @path, @archived,
        @session_label, @actor_label, @last_activity_at, @generation, @inode, @indexed_bytes, @source_size,
        @current_window_id, @indexed_tail_hash, @oversized_state, @projector_json,
        @prefix_bytes, @suffix_start, @suffix_end, @prefix_tail_hash, @suffix_head_hash, @suffix_tail_hash,
        @prefix_projector_json, @suffix_projector_json, @prefix_oversized, @suffix_oversized,
        @omitted_eligible_text, @suffix_ready, @replay_frontier, @unreadable, @catalog_revision, @updated_at
      )
    `);
    this.updateSource = database.prepare(`
      UPDATE sources SET
        profile_id=@profile_id, session_agent_id=@session_agent_id, actor_agent_id=@actor_agent_id,
        path=@path, archived=@archived, session_label=@session_label, actor_label=@actor_label,
        last_activity_at=@last_activity_at, generation=@generation, inode=@inode,
        indexed_bytes=@indexed_bytes, source_size=@source_size,
        current_window_id=@current_window_id, indexed_tail_hash=@indexed_tail_hash,
        oversized_state=@oversized_state, projector_json=@projector_json,
        prefix_bytes=@prefix_bytes, suffix_start=@suffix_start, suffix_end=@suffix_end,
        prefix_tail_hash=@prefix_tail_hash, suffix_head_hash=@suffix_head_hash, suffix_tail_hash=@suffix_tail_hash,
        prefix_projector_json=@prefix_projector_json, suffix_projector_json=@suffix_projector_json,
        prefix_oversized=@prefix_oversized, suffix_oversized=@suffix_oversized,
        omitted_eligible_text=@omitted_eligible_text, suffix_ready=@suffix_ready,
        replay_frontier=@replay_frontier, unreadable=@unreadable, catalog_revision=@catalog_revision,
        updated_at=@updated_at
      WHERE source_id=@source_id
    `);
    this.getSource = database.prepare("SELECT * FROM sources WHERE source_id = ?");
    this.listSourceIds = database.prepare("SELECT source_id FROM sources");
    this.deleteSource = database.prepare("DELETE FROM sources WHERE source_id = ?");
    this.deleteEntries = database.prepare("DELETE FROM entries WHERE source_id = ?");
    this.deleteFts = database.prepare(`
      DELETE FROM entries_fts WHERE rowid IN (SELECT rowid FROM entries WHERE source_id = ?)
    `);
    this.insertEntry = database.prepare(`
      INSERT INTO entries (
        source_id, entry_id, part_id, chunk_index, kind, role, tool_name, timestamp, window_id, origin,
        byte_offset, parent_id, content_key, text, extra, slice, provisional
      ) VALUES (
        @source_id, @entry_id, @part_id, @chunk_index, @kind, @role, @tool_name, @timestamp, @window_id, @origin,
        @byte_offset, @parent_id, @content_key, @text, @extra, @slice, @provisional
      )
    `);
    this.insertFts = database.prepare(`
      INSERT INTO entries_fts (rowid, text, extra, source_id, entry_id)
      VALUES (@rowid, @text, @extra, @source_id, @entry_id)
    `);
    this.deleteEntry = database.prepare(`
      DELETE FROM entries WHERE source_id = ? AND entry_id = ? AND part_id = ? AND chunk_index = ?
    `);
    this.deleteFtsEntry = database.prepare(`
      DELETE FROM entries_fts WHERE rowid = (
        SELECT rowid FROM entries WHERE source_id = ? AND entry_id = ? AND part_id = ? AND chunk_index = ?
      )
    `);
    this.deleteEntryParts = database.prepare("DELETE FROM entries WHERE source_id = ? AND entry_id = ?");
    this.deleteFtsEntryParts = database.prepare(`
      DELETE FROM entries_fts WHERE rowid IN (SELECT rowid FROM entries WHERE source_id = ? AND entry_id = ?)
    `);
    this.deleteSliceRange = database.prepare(`
      DELETE FROM entries WHERE source_id = ? AND slice = ? AND byte_offset >= ? AND byte_offset < ?
    `);
    this.deleteFtsSliceRange = database.prepare(`
      DELETE FROM entries_fts WHERE rowid IN (
        SELECT rowid FROM entries WHERE source_id = ? AND slice = ? AND byte_offset >= ? AND byte_offset < ?
      )
    `);
    this.getEntry = database.prepare(`
      SELECT * FROM entries WHERE source_id = ? AND entry_id = ?
      ORDER BY byte_offset ASC, part_id ASC, chunk_index ASC LIMIT 1
    `);
    this.listEntryParts = database.prepare(`
      SELECT * FROM entries WHERE source_id = ? AND entry_id = ?
      ORDER BY byte_offset ASC, part_id ASC, chunk_index ASC
    `);
    this.neighborsBefore = database.prepare(`
      SELECT * FROM entries WHERE source_id = ? AND byte_offset < ? ORDER BY byte_offset DESC, part_id DESC, chunk_index DESC
    `);
    this.neighborsAfter = database.prepare(`
      SELECT * FROM entries WHERE source_id = ? AND byte_offset > ? ORDER BY byte_offset ASC, part_id ASC, chunk_index ASC
    `);
    this.retagWindow = database.prepare(`
      UPDATE entries SET window_id = ? WHERE source_id = ? AND byte_offset >= ? AND byte_offset <= ? AND provisional = 0
    `);
    this.distinctWindows = database.prepare(`
      SELECT DISTINCT window_id FROM entries WHERE source_id = ? AND window_id != ? AND provisional = 0
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
      ensureEntryColumns(database);
      ensureIndexSchemaVersion(database);
      ensureFtsRowIds(database);
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
    return normalizeSourceRow(this.getSource.get(sourceId) as SourceRow | undefined);
  }

  listIndexedSourceIds(): string[] {
    return (this.listSourceIds.all() as Array<{ source_id: string }>).map((row) => row.source_id);
  }

  getIndexedEntry(sourceId: string, entryId: string): EntryRow | undefined {
    return this.getEntry.get(sourceId, entryId) as EntryRow | undefined;
  }

  listIndexedParts(sourceId: string, entryId: string): EntryRow[] {
    return this.listEntryParts.all(sourceId, entryId) as EntryRow[];
  }

  getCurrentWindowId(sourceId: string): string {
    const row = this.getSourceRow(sourceId);
    return row?.current_window_id || INITIAL_WINDOW_ID;
  }

  listNonCurrentWindowIds(sourceId: string): string[] {
    const current = this.getCurrentWindowId(sourceId);
    return (this.distinctWindows.all(sourceId, current) as Array<{ window_id: string }>)
      .map((row) => row.window_id)
      .filter((windowId) => !isProvisionalWindowId(windowId));
  }

  coverageCounts(sourceIds: string[]): {
    pendingSourceCount: number;
    unreadableSourceCount: number;
    omittedEligibleText: boolean;
  } {
    if (sourceIds.length === 0) {
      return { pendingSourceCount: 0, unreadableSourceCount: 0, omittedEligibleText: false };
    }
    const bindings = { sourceIds: JSON.stringify(sourceIds) };
    const rows = this.database.prepare(`
      SELECT unreadable, omitted_eligible_text, prefix_bytes, suffix_start, suffix_end, suffix_ready,
             replay_frontier, source_size, oversized_state
      FROM sources WHERE source_id IN (SELECT value FROM json_each(@sourceIds))
    `).all(bindings) as Array<{
      unreadable: number;
      omitted_eligible_text: number;
      prefix_bytes: number;
      suffix_start: number;
      suffix_end: number;
      suffix_ready: number;
      replay_frontier: number;
      source_size: number;
      oversized_state: number;
    }>;
    let pendingSourceCount = 0;
    let unreadableSourceCount = 0;
    let omittedEligibleText = false;
    for (const row of rows) {
      if (row.unreadable) {
        unreadableSourceCount += 1;
      }
      if (row.omitted_eligible_text || row.oversized_state) {
        omittedEligibleText = true;
      }
      const gap = row.suffix_start > 0 && row.prefix_bytes < row.suffix_start;
      const replaying = row.suffix_start > 0 && row.suffix_ready === 0 && row.prefix_bytes >= row.suffix_start;
      const prefixLag = row.suffix_start === 0 && row.prefix_bytes < row.source_size && row.oversized_state !== 2;
      if (gap || replaying || prefixLag || row.oversized_state === 1) {
        pendingSourceCount += 1;
      }
    }
    pendingSourceCount += sourceIds.length - rows.length;
    return { pendingSourceCount, unreadableSourceCount, omittedEligibleText };
  }

  /** True only when scannable bytes or a replacement remain. Permanent omissions are degraded, not pending. */
  needsScan(source: HistorySourceDescriptor): boolean {
    let stat: ReturnType<typeof readSourceStat>;
    try {
      stat = readSourceStat(source.path);
    } catch {
      return false;
    }
    const row = this.getSourceRow(source.sourceId);
    if (!stat) {
      return Boolean(row);
    }
    if (!row || row.unreadable) {
      return true;
    }
    const generation = readSourceGeneration(source.path, stat);
    if (row.generation !== generation || row.inode !== stat.ino) {
      return true;
    }
    if (stat.size > Math.max(row.suffix_end, row.prefix_bytes, row.source_size, row.indexed_bytes)) {
      return true;
    }
    if (row.oversized_state === 1 || (row.suffix_start > 0 && row.prefix_bytes >= row.suffix_start && row.suffix_ready === 0)) {
      return true;
    }
    const frontier = row.suffix_start > 0 && row.prefix_bytes < row.suffix_start
      ? row.prefix_bytes
      : Math.max(row.suffix_end, row.prefix_bytes, row.indexed_bytes);
    if (frontier >= stat.size) {
      return false;
    }
    const ahead = readCompleteLines(source.path, frontier, stat.size, MAX_LINE_BYTES + 1, {
      resumeSkippingOversized: row.prefix_oversized === 1 || row.suffix_oversized === 1 || row.oversized_state === 1,
    });
    return ahead.lines.length > 0 || ahead.skippingOversized || ahead.nextOffset > frontier;
  }

  listNeighbors(sourceId: string, byteOffset: number, before: number, after: number, current?: EntryRow): { before: EntryRow[]; after: EntryRow[] } {
    const beforeRows = before > 0
      ? uniqueEntries(this.neighborsBefore.all(sourceId, byteOffset) as EntryRow[], 64)
        .filter((row) => !current || isBranchNeighbor(current, row))
        .slice(0, before)
        .reverse()
      : [];
    const afterRows = after > 0
      ? uniqueEntries(this.neighborsAfter.all(sourceId, byteOffset) as EntryRow[], 64)
        .filter((row) => !current || isBranchNeighbor(current, row))
        .slice(0, after)
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
    order?: HistorySearchOrder;
    includeHistoryArtifacts?: boolean;
    allowProvisional?: boolean;
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
      const pairs = params.sourceWindows.flatMap((source) => source.windowIds.map((windowId) => [source.sourceId, windowId]));
      if (pairs.length === 0) return [];
      bindings.sourceWindows = JSON.stringify(pairs);
      clauses.push("(entries.source_id, entries.window_id) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(@sourceWindows)) AND entries.provisional = 0");
    } else {
      if (params.sourceIds.length === 0) return [];
      clauses.push("entries.source_id IN (SELECT value FROM json_each(@sourceIds))");
      bindings.sourceIds = JSON.stringify(params.sourceIds);
      if (!params.allowProvisional) {
        clauses.push("(entries.provisional = 0 OR entries.slice = 'suffix')");
      }
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
    if (!params.includeHistoryArtifacts) {
      clauses.push("(entries.tool_name IS NULL OR entries.tool_name != @historyTool)");
      bindings.historyTool = HISTORY_TOOL_NAME;
    }
    const orderSql = params.order === "newest"
      ? "CASE WHEN entries.timestamp IS NULL OR entries.timestamp = '' THEN 1 ELSE 0 END ASC, entries.timestamp DESC, entries.byte_offset DESC"
      : "score ASC, COALESCE(entries.timestamp, '') DESC, entries.byte_offset DESC";
    const sql = `
      WITH selected AS MATERIALIZED (
        SELECT entries.rowid AS entry_rowid, ${params.order === "newest" ? "0" : "bm25(entries_fts)"} AS score,
               entries.timestamp, entries.byte_offset
        FROM entries_fts
        CROSS JOIN entries ON entries.rowid = entries_fts.rowid
        WHERE ${clauses.join(" AND ")}
        ORDER BY ${orderSql}
        LIMIT @limit OFFSET @offset
      )
      SELECT entries.*, selected.score FROM selected
      JOIN entries ON entries.rowid = selected.entry_rowid
      ORDER BY ${params.order === "newest" ? "CASE WHEN selected.timestamp IS NULL OR selected.timestamp = '' THEN 1 ELSE 0 END ASC, selected.timestamp DESC, selected.byte_offset DESC" : "selected.score ASC, COALESCE(selected.timestamp, '') DESC, selected.byte_offset DESC"}
    `;
    return this.database.prepare(sql).all(bindings) as Array<EntryRow & { score: number }>;
  }

  reconcileSources(
    sources: HistorySourceDescriptor[],
    options?: {
      liveSourceIds?: Iterable<string>;
      purgeMissing?: boolean;
      preferRecent?: boolean;
      maxSources?: number;
      maxBytes?: number;
      perSourceBytes?: number;
    },
  ): { incomplete: boolean; warnings: string[]; pendingSourceCount: number } {
    const warnings: string[] = [];
    let incomplete = false;
    let remainingBytes = options?.maxBytes ?? MAX_INDEX_CATCHUP_TOTAL_BYTES;
    if (options?.purgeMissing && options.liveSourceIds) {
      const liveIds = new Set(options.liveSourceIds);
      for (const row of this.listSourceIds.all() as Array<{ source_id: string }>) {
        if (!liveIds.has(row.source_id)) {
          this.purgeSource(row.source_id);
        }
      }
    }

    const ordered = options?.preferRecent ? prioritizeRecent(sources, this) : sources;
    const maxSources = options?.maxSources ?? MAX_INDEX_CATCHUP_SOURCES;
    let processed = 0;
    for (const source of ordered) {
      if (processed >= maxSources || remainingBytes <= 0) {
        incomplete = true;
        warnings.push("History index catch-up was bounded; some sources were not fully scanned.");
        break;
      }
      const budget = Math.min(options?.perSourceBytes ?? MAX_INDEX_CATCHUP_BYTES, remainingBytes);
      const result = this.ingestSource(source, budget);
      remainingBytes -= result.scannedBytes;
      if (result.scannedBytes > 0) processed += 1;
      if (result.incomplete || result.pending) {
        incomplete = true;
      }
      warnings.push(...result.warnings);
    }
    const pendingSourceCount = ordered.filter((source) => this.needsScan(source)).length;
    return { incomplete, warnings: unique(warnings), pendingSourceCount };
  }

  purgeSession(sessionAgentId: string): void {
    const rows = this.database.prepare("SELECT source_id FROM sources WHERE session_agent_id = ?").all(sessionAgentId) as Array<{ source_id: string }>;
    for (const row of rows) {
      this.purgeSource(row.source_id);
    }
  }

  purgeSource(sourceId: string): void {
    const tx = this.database.transaction(() => {
      this.deleteFts.run(sourceId);
      this.deleteEntries.run(sourceId);
      this.deleteSource.run(sourceId);
    });
    tx();
  }

  ingestSource(source: HistorySourceDescriptor, maxBytes: number): IndexedSourceState & { scannedBytes: number; warnings: string[] } {
    const warnings: string[] = [];
    let stat: ReturnType<typeof readSourceStat>;
    try {
      stat = readSourceStat(source.path);
    } catch {
      this.markUnreadable(source, "permission or IO error");
      return {
        sourceId: source.sourceId,
        generation: "",
        indexedBytes: 0,
        sourceSize: 0,
        incomplete: true,
        pending: true,
        omittedEligibleText: false,
        unreadable: true,
        scannedBytes: 0,
        warnings: [`History source ${source.sessionLabel}/${source.actorLabel} is unreadable.`],
      };
    }
    if (!stat) {
      this.purgeSource(source.sourceId);
      return {
        sourceId: source.sourceId,
        generation: "",
        indexedBytes: 0,
        sourceSize: 0,
        incomplete: false,
        pending: false,
        omittedEligibleText: false,
        unreadable: false,
        scannedBytes: 0,
        warnings,
      };
    }
    const generation = readSourceGeneration(source.path, stat);
    const existing = this.getSourceRow(source.sourceId);
    const replaced = Boolean(existing && (
      existing.generation !== generation
      || existing.inode !== stat.ino
      || prefixReplaced(source.path, existing)
    ));
    const truncated = Boolean(existing && !replaced && stat.size < Math.max(existing.prefix_bytes, existing.suffix_end, existing.indexed_bytes));
    if (replaced || truncated) {
      this.purgeSource(source.sourceId);
    }
    const current = (replaced || truncated ? undefined : existing);
    if (!current) {
      if (stat.size > SCAN_BATCH_BYTES) {
        const prepared = this.prepareTail(source, generation, stat, Math.min(maxBytes, SCAN_BATCH_BYTES), warnings);
        const remaining = Math.max(0, maxBytes - prepared.scannedBytes);
        if (remaining <= 0) {
          return prepared;
        }
        const prefixed = this.ingestPrefix(
          source,
          generation,
          stat,
          this.getSourceRow(source.sourceId),
          remaining,
          warnings,
        );
        return {
          ...prefixed,
          scannedBytes: prepared.scannedBytes + prefixed.scannedBytes,
          warnings: unique([...prepared.warnings, ...prefixed.warnings]),
        };
      }
      return this.ingestPrefix(source, generation, stat, undefined, maxBytes, warnings);
    }
    let remaining = maxBytes;
    let scannedBytes = 0;
    if (current.suffix_start > 0 && stat.size > current.suffix_end) {
      const appended = this.ingestSuffixAppend(source, generation, stat, current, remaining, warnings);
      scannedBytes += appended.scannedBytes;
      remaining -= appended.scannedBytes;
      if (appended.incomplete && remaining <= 0) {
        return this.finishIngest(source, generation, this.getSourceRow(source.sourceId), scannedBytes, warnings);
      }
    }
    const latest = this.getSourceRow(source.sourceId) ?? current;
    if (latest.suffix_start > 0 && latest.prefix_bytes >= latest.suffix_start && latest.suffix_ready === 0) {
      const replayed = this.replaySuffix(source, generation, stat, latest, Math.min(remaining, SCAN_BATCH_BYTES), warnings);
      scannedBytes += replayed.scannedBytes;
      remaining -= replayed.scannedBytes;
      if (remaining <= 0 || replayed.pending) {
        return this.finishIngest(source, generation, this.getSourceRow(source.sourceId), scannedBytes, warnings);
      }
    }
    if (remaining > 0) {
      const prefixed = this.ingestPrefix(source, generation, stat, this.getSourceRow(source.sourceId), remaining, warnings);
      scannedBytes += prefixed.scannedBytes;
      return this.finishIngest(source, generation, this.getSourceRow(source.sourceId), scannedBytes, [
        ...warnings,
        ...prefixed.warnings,
      ]);
    }
    return this.finishIngest(source, generation, this.getSourceRow(source.sourceId), scannedBytes, warnings);
  }

  private prepareTail(
    source: HistorySourceDescriptor,
    generation: string,
    stat: { size: number; ino: string },
    maxBytes: number,
    warnings: string[],
  ): IndexedSourceState & { scannedBytes: number; warnings: string[] } {
    const tail = readTailLines(source.path, stat.size, Math.min(maxBytes, SCAN_BATCH_BYTES));
    const projector = createProjectorState({ provisional: true });
    const oversizedState = tail.skippedOversized || tail.skippingOversized ? (tail.skippingOversized ? 1 : 2) : 0;
    const insertBatch = this.database.transaction((entries: ProjectedHistoryEntry[]) => {
      for (const entry of entries) {
        this.writeProjected(source.sourceId, entry, "suffix");
      }
      this.upsertSource(source, generation, stat, {
        prefixBytes: 0,
        suffixStart: tail.startOffset,
        suffixEnd: tail.nextOffset,
        currentWindowId: INITIAL_WINDOW_ID,
        prefixTailHash: "",
        suffixHeadHash: tail.startOffset > 0 ? readPrefixTailHash(source.path, tail.startOffset) : "",
        suffixTailHash: readPrefixTailHash(source.path, tail.nextOffset),
        prefixProjector: createProjectorState(),
        suffixProjector: projector,
        prefixOversized: 0,
        suffixOversized: oversizedState,
        omittedEligibleText: oversizedState !== 0,
        suffixReady: 0,
        replayFrontier: 0,
        unreadable: 0,
      });
    });
    insertBatch(projectLines(tail.lines, projector, true));
    if (oversizedState) {
      warnings.push(`Indexing of ${source.sessionLabel}/${source.actorLabel} skipped oversized JSONL rows.`);
    }
    return {
      sourceId: source.sourceId,
      generation,
      indexedBytes: 0,
      sourceSize: stat.size,
      incomplete: true,
      pending: true,
      omittedEligibleText: oversizedState !== 0,
      unreadable: false,
      scannedBytes: tail.scannedBytes,
      warnings,
    };
  }

  private ingestPrefix(
    source: HistorySourceDescriptor,
    generation: string,
    stat: { size: number; ino: string },
    current: SourceRow | undefined,
    maxBytes: number,
    warnings: string[],
  ): IndexedSourceState & { scannedBytes: number; warnings: string[] } {
    const endOffset = current && current.suffix_start > 0 ? current.suffix_start : stat.size;
    const startOffset = current?.prefix_bytes ?? current?.indexed_bytes ?? 0;
    if (startOffset >= endOffset) {
      this.upsertSource(source, generation, stat, sourceStateFromRow(current, startOffset));
      if (current && current.suffix_start > 0 && startOffset >= current.suffix_start && current.suffix_ready === 0) {
        return this.replaySuffix(source, generation, stat, this.getSourceRow(source.sourceId) ?? current, maxBytes, warnings);
      }
      if (current?.oversized_state || current?.omitted_eligible_text) {
        warnings.push(`Indexing of ${source.sessionLabel}/${source.actorLabel} skipped oversized JSONL rows.`);
      }
      const incompleteEof = startOffset < stat.size && !(current && current.suffix_start > 0);
      return {
        sourceId: source.sourceId,
        generation,
        indexedBytes: startOffset,
        sourceSize: stat.size,
        incomplete: incompleteEof || Boolean(current?.oversized_state || current?.omitted_eligible_text),
        pending: Boolean(current && sourceHasRemainingScan({ ...current, prefix_bytes: startOffset })),
        omittedEligibleText: Boolean(current?.omitted_eligible_text || current?.oversized_state),
        unreadable: false,
        scannedBytes: 0,
        warnings,
      };
    }
    const projector = current
      ? deserializeProjector(current.prefix_projector_json || current.projector_json)
      : createProjectorState();
    const { lines, nextOffset, incomplete, scannedBytes, skippedOversized, skippingOversized } = readCompleteLines(
      source.path,
      startOffset,
      endOffset,
      Math.min(maxBytes, SCAN_BATCH_BYTES),
      { resumeSkippingOversized: (current?.prefix_oversized ?? current?.oversized_state) === 1 },
    );
    const prefixOversized = skippingOversized ? 1 : (skippedOversized || current?.prefix_oversized || current?.oversized_state ? 2 : 0);
    const insertBatch = this.database.transaction((entries: ProjectedHistoryEntry[]) => {
      for (const entry of entries) {
        this.writeProjected(source.sourceId, entry, "prefix");
      }
      this.upsertSource(source, generation, stat, {
        prefixBytes: nextOffset,
        suffixStart: current?.suffix_start ?? 0,
        suffixEnd: current?.suffix_end ?? 0,
        currentWindowId: projector.windowId,
        prefixTailHash: readPrefixTailHash(source.path, nextOffset),
        suffixHeadHash: current?.suffix_head_hash ?? "",
        suffixTailHash: current?.suffix_tail_hash ?? "",
        prefixProjector: projector,
        suffixProjector: current ? deserializeProjector(current.suffix_projector_json || "{}") : createProjectorState({ provisional: true }),
        prefixOversized,
        suffixOversized: current?.suffix_oversized ?? 0,
        omittedEligibleText: Boolean(current?.omitted_eligible_text) || prefixOversized !== 0,
        suffixReady: current?.suffix_ready ?? 0,
        replayFrontier: current?.replay_frontier ?? 0,
        unreadable: 0,
      });
    });
    insertBatch(projectLines(lines, projector, false));
    if (incomplete && nextOffset < endOffset) {
      warnings.push(`Indexing of ${source.sessionLabel}/${source.actorLabel} is incomplete.`);
    }
    if (prefixOversized) {
      warnings.push(`Indexing of ${source.sessionLabel}/${source.actorLabel} skipped oversized JSONL rows.`);
    }
    const latest = this.getSourceRow(source.sourceId);
    if (latest && latest.suffix_start > 0 && latest.prefix_bytes >= latest.suffix_start && latest.suffix_ready === 0) {
      const leftover = Math.max(0, maxBytes - scannedBytes);
      if (leftover > 0) {
        const replayed = this.replaySuffix(source, generation, stat, latest, leftover, warnings);
        return {
          ...replayed,
          scannedBytes: scannedBytes + replayed.scannedBytes,
          warnings: unique([...warnings, ...replayed.warnings]),
        };
      }
    }
    return {
      sourceId: source.sourceId,
      generation,
      indexedBytes: nextOffset,
      sourceSize: stat.size,
      incomplete: incomplete || prefixOversized !== 0 || Boolean(latest && sourceHasRemainingScan(latest)),
      pending: Boolean(latest && sourceHasRemainingScan(latest)),
      omittedEligibleText: prefixOversized !== 0 || Boolean(current?.omitted_eligible_text),
      unreadable: false,
      scannedBytes,
      warnings,
    };
  }

  private ingestSuffixAppend(
    source: HistorySourceDescriptor,
    generation: string,
    stat: { size: number; ino: string },
    current: SourceRow,
    maxBytes: number,
    warnings: string[],
  ): IndexedSourceState & { scannedBytes: number; warnings: string[] } {
    const projector = deserializeProjector(current.suffix_projector_json || "{}", { provisional: true });
    projector.provisional = true;
    const { lines, nextOffset, incomplete, scannedBytes, skippedOversized, skippingOversized } = readCompleteLines(
      source.path,
      current.suffix_end,
      stat.size,
      Math.min(maxBytes, SCAN_BATCH_BYTES),
      { resumeSkippingOversized: current.suffix_oversized === 1 },
    );
    const suffixOversized = skippingOversized ? 1 : (skippedOversized || current.suffix_oversized ? 2 : 0);
    const insertBatch = this.database.transaction((entries: ProjectedHistoryEntry[]) => {
      for (const entry of entries) {
        this.writeProjected(source.sourceId, entry, "suffix");
      }
      this.upsertSource(source, generation, stat, {
        prefixBytes: current.prefix_bytes,
        suffixStart: current.suffix_start,
        suffixEnd: nextOffset,
        currentWindowId: current.current_window_id,
        prefixTailHash: current.prefix_tail_hash || current.indexed_tail_hash,
        suffixHeadHash: current.suffix_head_hash,
        suffixTailHash: readPrefixTailHash(source.path, nextOffset),
        prefixProjector: deserializeProjector(current.prefix_projector_json || current.projector_json),
        suffixProjector: projector,
        prefixOversized: current.prefix_oversized,
        suffixOversized,
        omittedEligibleText: current.omitted_eligible_text === 1 || suffixOversized !== 0,
        suffixReady: 0,
        replayFrontier: current.replay_frontier,
        unreadable: 0,
      });
    });
    insertBatch(projectLines(lines, projector, true));
    if (incomplete) {
      warnings.push(`Indexing of ${source.sessionLabel}/${source.actorLabel} is incomplete.`);
    }
    return {
      sourceId: source.sourceId,
      generation,
      indexedBytes: current.prefix_bytes,
      sourceSize: stat.size,
      incomplete: true,
      pending: true,
      omittedEligibleText: current.omitted_eligible_text === 1 || suffixOversized !== 0,
      unreadable: false,
      scannedBytes,
      warnings,
    };
  }

  private replaySuffix(
    source: HistorySourceDescriptor,
    generation: string,
    stat: { size: number; ino: string },
    current: SourceRow,
    maxBytes: number,
    warnings: string[],
  ): IndexedSourceState & { scannedBytes: number; warnings: string[] } {
    const start = Math.max(current.suffix_start, current.replay_frontier || current.suffix_start);
    const projector = deserializeProjector(current.prefix_projector_json || current.projector_json);
    projector.provisional = false;
    const { lines, nextOffset, incomplete, scannedBytes, skippedOversized, skippingOversized } = readCompleteLines(
      source.path,
      start,
      current.suffix_end || stat.size,
      Math.min(maxBytes, SCAN_BATCH_BYTES),
      { resumeSkippingOversized: current.suffix_oversized === 1 },
    );
    const prefixOversized = skippingOversized ? 1 : (skippedOversized || current.prefix_oversized ? 2 : 0);
    const insertBatch = this.database.transaction((entries: ProjectedHistoryEntry[]) => {
      this.deleteFtsSliceRange.run(source.sourceId, "suffix", start, nextOffset);
      this.deleteSliceRange.run(source.sourceId, "suffix", start, nextOffset);
      for (const entry of entries) {
        this.writeProjected(source.sourceId, entry, "prefix");
      }
      const caughtUp = nextOffset >= (current.suffix_end || stat.size) && !skippingOversized;
      this.upsertSource(source, generation, stat, {
        prefixBytes: caughtUp ? nextOffset : current.prefix_bytes,
        suffixStart: caughtUp ? 0 : current.suffix_start,
        suffixEnd: caughtUp ? 0 : current.suffix_end,
        currentWindowId: projector.windowId,
        prefixTailHash: readPrefixTailHash(source.path, caughtUp ? nextOffset : current.prefix_bytes),
        suffixHeadHash: caughtUp ? "" : current.suffix_head_hash,
        suffixTailHash: caughtUp ? "" : current.suffix_tail_hash,
        prefixProjector: projector,
        suffixProjector: caughtUp ? createProjectorState() : deserializeProjector(current.suffix_projector_json || "{}", { provisional: true }),
        prefixOversized,
        suffixOversized: caughtUp ? 0 : current.suffix_oversized,
        omittedEligibleText: current.omitted_eligible_text === 1 || prefixOversized !== 0,
        suffixReady: caughtUp ? 1 : 0,
        replayFrontier: caughtUp ? 0 : nextOffset,
        unreadable: 0,
      });
    });
    insertBatch(projectLines(lines, projector, false));
    const latest = this.getSourceRow(source.sourceId);
    if (incomplete && latest && latest.suffix_ready === 0) {
      warnings.push(`Indexing of ${source.sessionLabel}/${source.actorLabel} is incomplete.`);
    }
    return this.finishIngest(source, generation, latest, scannedBytes, warnings);
  }

  private finishIngest(
    source: HistorySourceDescriptor,
    generation: string,
    current: SourceRow | undefined,
    scannedBytes: number,
    warnings: string[],
  ): IndexedSourceState & { scannedBytes: number; warnings: string[] } {
    const pending = Boolean(current && sourceHasRemainingScan(current));
    const omitted = Boolean(current && (current.omitted_eligible_text || current.oversized_state || current.prefix_oversized || current.suffix_oversized));
    if (omitted) {
      warnings.push(`Indexing of ${source.sessionLabel}/${source.actorLabel} skipped oversized JSONL rows.`);
    }
    return {
      sourceId: source.sourceId,
      generation,
      indexedBytes: current?.prefix_bytes ?? 0,
      sourceSize: current?.source_size ?? 0,
      incomplete: pending || omitted || Boolean(current && current.prefix_bytes < current.source_size && current.suffix_start === 0),
      pending,
      omittedEligibleText: omitted,
      unreadable: Boolean(current?.unreadable),
      scannedBytes,
      warnings: unique(warnings),
    };
  }

  private writeProjected(sourceId: string, entry: ProjectedHistoryEntry, slice: "prefix" | "suffix"): void {
    if (entry.replacesEntryId && entry.replacesEntryId !== entry.entryId && slice === "prefix" && !entry.provisional) {
      this.deleteFtsEntryParts.run(sourceId, entry.replacesEntryId);
      this.deleteEntryParts.run(sourceId, entry.replacesEntryId);
    }
    this.deleteFtsEntry.run(sourceId, entry.entryId, entry.partId, entry.chunkIndex);
    this.deleteEntry.run(sourceId, entry.entryId, entry.partId, entry.chunkIndex);
    const row = {
      source_id: sourceId,
      entry_id: entry.entryId,
      part_id: entry.partId,
      chunk_index: entry.chunkIndex,
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
      slice,
      provisional: entry.provisional ? 1 : 0,
    };
    const { lastInsertRowid } = this.insertEntry.run(row);
    this.insertFts.run({
      rowid: lastInsertRowid,
      text: ftsSafeText(entry.text),
      extra: ftsSafeText(entry.extra),
      source_id: sourceId,
      entry_id: entry.entryId,
    });
    if (entry.kind === "checkpoint" && entry.retainsFromEntryId && slice === "prefix" && !entry.provisional) {
      const kept = this.getIndexedEntry(sourceId, entry.retainsFromEntryId);
      if (kept) {
        this.retagWindow.run(entry.windowId, sourceId, kept.byte_offset, entry.byteOffset);
      }
    }
  }

  private markUnreadable(source: HistorySourceDescriptor, _reason: string): void {
    const existing = this.getSourceRow(source.sourceId);
    const projector = existing
      ? deserializeProjector(existing.prefix_projector_json || existing.projector_json)
      : createProjectorState();
    this.upsertSource(source, existing?.generation ?? "", { size: existing?.source_size ?? 0, ino: existing?.inode ?? "" }, {
      prefixBytes: existing?.prefix_bytes ?? 0,
      suffixStart: existing?.suffix_start ?? 0,
      suffixEnd: existing?.suffix_end ?? 0,
      currentWindowId: existing?.current_window_id ?? INITIAL_WINDOW_ID,
      prefixTailHash: existing?.prefix_tail_hash ?? "",
      suffixHeadHash: existing?.suffix_head_hash ?? "",
      suffixTailHash: existing?.suffix_tail_hash ?? "",
      prefixProjector: projector,
      suffixProjector: existing ? deserializeProjector(existing.suffix_projector_json || "{}", { provisional: true }) : createProjectorState({ provisional: true }),
      prefixOversized: existing?.prefix_oversized ?? 0,
      suffixOversized: existing?.suffix_oversized ?? 0,
      omittedEligibleText: Boolean(existing?.omitted_eligible_text),
      suffixReady: existing?.suffix_ready ?? 0,
      replayFrontier: existing?.replay_frontier ?? 0,
      unreadable: 1,
    });
  }

  private upsertSource(
    source: HistorySourceDescriptor,
    generation: string,
    stat: { size: number; ino: string },
    state: {
      prefixBytes: number;
      suffixStart: number;
      suffixEnd: number;
      currentWindowId: string;
      prefixTailHash: string;
      suffixHeadHash: string;
      suffixTailHash: string;
      prefixProjector: ProjectorState;
      suffixProjector: ProjectorState;
      prefixOversized: number;
      suffixOversized: number;
      omittedEligibleText: boolean;
      suffixReady: number;
      replayFrontier: number;
      unreadable: number;
    },
  ): void {
    const prefixJson = serializeProjector(state.prefixProjector);
    const suffixJson = serializeProjector(state.suffixProjector);
    const oversized = state.prefixOversized || state.suffixOversized;
    const row = {
      source_id: source.sourceId,
      profile_id: source.profileId,
      session_agent_id: source.sessionAgentId,
      actor_agent_id: source.actorAgentId,
      path: source.path,
      archived: source.archived ? 1 : 0,
      session_label: source.sessionLabel,
      actor_label: source.actorLabel,
      last_activity_at: source.lastActivityAt ?? null,
      generation,
      inode: stat.ino,
      indexed_bytes: state.prefixBytes,
      source_size: stat.size,
      current_window_id: state.currentWindowId,
      indexed_tail_hash: state.prefixTailHash,
      oversized_state: oversized,
      projector_json: prefixJson,
      prefix_bytes: state.prefixBytes,
      suffix_start: state.suffixStart,
      suffix_end: state.suffixEnd,
      prefix_tail_hash: state.prefixTailHash,
      suffix_head_hash: state.suffixHeadHash,
      suffix_tail_hash: state.suffixTailHash,
      prefix_projector_json: prefixJson,
      suffix_projector_json: suffixJson,
      prefix_oversized: state.prefixOversized,
      suffix_oversized: state.suffixOversized,
      omitted_eligible_text: state.omittedEligibleText ? 1 : 0,
      suffix_ready: state.suffixReady,
      replay_frontier: state.replayFrontier,
      unreadable: state.unreadable,
      catalog_revision: 0,
      updated_at: new Date().toISOString(),
    };
    const existing = this.getSource.get(source.sourceId);
    if (existing) {
      this.updateSource.run(row);
      return;
    }
    this.insertSource.run(row);
  }
}

function projectLines(lines: Array<{ line: string; byteOffset: number }>, projector: ProjectorState, provisional: boolean): ProjectedHistoryEntry[] {
  const entries: ProjectedHistoryEntry[] = [];
  projector.provisional = provisional || undefined;
  for (const line of lines) {
    const record = projectCanonicalRecord(line.line, line.byteOffset, projector, "index");
    if (!record) {
      continue;
    }
    for (const part of record.parts) {
      entries.push({ ...part, provisional: provisional || undefined });
    }
  }
  return entries;
}

function sourceHasRemainingScan(row: Pick<SourceRow, "prefix_bytes" | "suffix_start" | "suffix_end" | "suffix_ready" | "source_size" | "replay_frontier" | "unreadable">): boolean {
  if (row.unreadable) {
    return false;
  }
  if (row.suffix_start > 0 && (row.suffix_ready === 0 || row.prefix_bytes < row.suffix_start || row.replay_frontier > 0)) {
    return true;
  }
  return row.suffix_start === 0 && row.prefix_bytes < row.source_size;
}

function sourceStateFromRow(
  current: SourceRow | undefined,
  prefixBytes: number,
) {
  return {
    prefixBytes,
    suffixStart: current?.suffix_start ?? 0,
    suffixEnd: current?.suffix_end ?? 0,
    currentWindowId: current?.current_window_id ?? INITIAL_WINDOW_ID,
    prefixTailHash: current?.prefix_tail_hash || current?.indexed_tail_hash || "",
    suffixHeadHash: current?.suffix_head_hash ?? "",
    suffixTailHash: current?.suffix_tail_hash ?? "",
    prefixProjector: current ? deserializeProjector(current.prefix_projector_json || current.projector_json) : createProjectorState(),
    suffixProjector: current ? deserializeProjector(current.suffix_projector_json || "{}", { provisional: true }) : createProjectorState({ provisional: true }),
    prefixOversized: current?.prefix_oversized ?? 0,
    suffixOversized: current?.suffix_oversized ?? 0,
    omittedEligibleText: Boolean(current?.omitted_eligible_text || current?.oversized_state),
    suffixReady: current?.suffix_ready ?? 0,
    replayFrontier: current?.replay_frontier ?? 0,
    unreadable: current?.unreadable ?? 0,
  };
}

function prioritizeRecent(sources: HistorySourceDescriptor[], store: HistoryRecallIndexStore): HistorySourceDescriptor[] {
  return [...sources].sort((left, right) => {
    const leftRow = store.getSourceRow(left.sourceId);
    const rightRow = store.getSourceRow(right.sourceId);
    const leftPending = !leftRow || sourceHasRemainingScan(leftRow) ? 0 : 1;
    const rightPending = !rightRow || sourceHasRemainingScan(rightRow) ? 0 : 1;
    if (leftPending !== rightPending) {
      return leftPending - rightPending;
    }
    const leftActivity = left.lastActivityAt ?? "";
    const rightActivity = right.lastActivityAt ?? "";
    if (leftActivity !== rightActivity) {
      return rightActivity.localeCompare(leftActivity);
    }
    return left.sourceId.localeCompare(right.sourceId);
  });
}

function isBranchNeighbor(current: EntryRow, candidate: EntryRow): boolean {
  if (candidate.entry_id === current.entry_id) {
    return false;
  }
  if (candidate.parent_id === current.entry_id || current.parent_id === candidate.entry_id) {
    return true;
  }
  if (current.parent_id && candidate.parent_id && current.parent_id !== candidate.parent_id) {
    return false;
  }
  if (current.parent_id && candidate.parent_id && current.parent_id === candidate.parent_id) {
    return false;
  }
  return true;
}

function uniqueEntries(rows: EntryRow[], limit: number): EntryRow[] {
  const seen = new Set<string>();
  const uniqueRows: EntryRow[] = [];
  for (const row of rows) {
    if (seen.has(row.entry_id)) {
      continue;
    }
    seen.add(row.entry_id);
    uniqueRows.push(row);
    if (uniqueRows.length >= limit) {
      break;
    }
  }
  return uniqueRows;
}

function ensureSourceColumns(database: Database.Database): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  const add = (name: string, ddl: string): void => {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE sources ADD COLUMN ${ddl}`);
    }
  };
  add("oversized_state", "oversized_state INTEGER NOT NULL DEFAULT 0");
  add("current_window_id", "current_window_id TEXT NOT NULL DEFAULT 'window:initial'");
  add("indexed_tail_hash", "indexed_tail_hash TEXT NOT NULL DEFAULT ''");
  add("last_activity_at", "last_activity_at TEXT");
  add("prefix_bytes", "prefix_bytes INTEGER NOT NULL DEFAULT 0");
  add("suffix_start", "suffix_start INTEGER NOT NULL DEFAULT 0");
  add("suffix_end", "suffix_end INTEGER NOT NULL DEFAULT 0");
  add("prefix_tail_hash", "prefix_tail_hash TEXT NOT NULL DEFAULT ''");
  add("suffix_head_hash", "suffix_head_hash TEXT NOT NULL DEFAULT ''");
  add("suffix_tail_hash", "suffix_tail_hash TEXT NOT NULL DEFAULT ''");
  add("prefix_projector_json", "prefix_projector_json TEXT NOT NULL DEFAULT '{}'");
  add("suffix_projector_json", "suffix_projector_json TEXT NOT NULL DEFAULT '{}'");
  add("prefix_oversized", "prefix_oversized INTEGER NOT NULL DEFAULT 0");
  add("suffix_oversized", "suffix_oversized INTEGER NOT NULL DEFAULT 0");
  add("omitted_eligible_text", "omitted_eligible_text INTEGER NOT NULL DEFAULT 0");
  add("suffix_ready", "suffix_ready INTEGER NOT NULL DEFAULT 0");
  add("replay_frontier", "replay_frontier INTEGER NOT NULL DEFAULT 0");
  add("unreadable", "unreadable INTEGER NOT NULL DEFAULT 0");
  add("catalog_revision", "catalog_revision INTEGER NOT NULL DEFAULT 0");
}

function ensureEntryColumns(database: Database.Database): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("part_id")) {
    database.exec("ALTER TABLE entries ADD COLUMN part_id TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("chunk_index")) {
    database.exec("ALTER TABLE entries ADD COLUMN chunk_index INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("slice")) {
    database.exec("ALTER TABLE entries ADD COLUMN slice TEXT NOT NULL DEFAULT 'prefix'");
  }
  if (!columns.has("provisional")) {
    database.exec("ALTER TABLE entries ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0");
  }
}

function ensureIndexSchemaVersion(database: Database.Database): void {
  const version = database.prepare("SELECT value FROM meta WHERE key = 'projection_version'").get() as { value: string } | undefined;
  if (version?.value === INDEX_SCHEMA_VERSION) return;
  database.transaction(() => {
    database.exec(`
      DROP TABLE IF EXISTS entries_fts;
      DROP TABLE IF EXISTS entries;
      DELETE FROM sources;
      CREATE TABLE entries (
        source_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        part_id TEXT NOT NULL DEFAULT '',
        chunk_index INTEGER NOT NULL DEFAULT 0,
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
        slice TEXT NOT NULL DEFAULT 'prefix',
        provisional INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, entry_id, part_id, chunk_index)
      );
      CREATE INDEX entries_source_offset_idx ON entries(source_id, byte_offset, part_id, chunk_index);
      CREATE INDEX entries_source_window_idx ON entries(source_id, window_id, byte_offset);
      CREATE INDEX entries_parent_idx ON entries(source_id, parent_id, byte_offset);
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        text, extra, source_id UNINDEXED, entry_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('projection_version', ?)").run(INDEX_SCHEMA_VERSION);
    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_rowid_version', '1')").run();
  })();
}

function ensureFtsRowIds(database: Database.Database): void {
  const version = database.prepare("SELECT value FROM meta WHERE key = 'fts_rowid_version'").get() as { value: string } | undefined;
  if (version?.value === "1") return;
  database.transaction(() => {
    database.exec(`
      CREATE VIRTUAL TABLE entries_fts_rekey USING fts5(
        text, extra, source_id UNINDEXED, entry_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO entries_fts_rekey (rowid, text, extra, source_id, entry_id)
      SELECT rowid, text, extra, source_id, entry_id FROM entries;
      DROP TABLE entries_fts;
      ALTER TABLE entries_fts_rekey RENAME TO entries_fts;
    `);
    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_rowid_version', '1')").run();
  })();
}

function prefixReplaced(path: string, existing: SourceRow): boolean {
  const prefixBytes = existing.prefix_bytes || existing.indexed_bytes;
  const hash = existing.prefix_tail_hash || existing.indexed_tail_hash;
  if (prefixBytes <= 0 || !hash) {
    return false;
  }
  const stat = readSourceStat(path);
  if (!stat || stat.size < prefixBytes) {
    return stat !== undefined && stat.size < prefixBytes;
  }
  return readPrefixTailHash(path, prefixBytes) !== hash;
}

function serializeProjector(state: ProjectorState): string {
  return JSON.stringify({
    windowId: state.windowId,
    pendingBoundaryId: state.pendingBoundaryId,
    seenContentKeys: [...state.seenContentKeys.entries()],
    provisional: state.provisional || undefined,
  });
}

function deserializeProjector(raw: string, options?: { provisional?: boolean }): ProjectorState {
  const state = createProjectorState({ provisional: options?.provisional });
  try {
    const parsed = JSON.parse(raw) as {
      windowId?: unknown;
      pendingBoundaryId?: unknown;
      seenContentKeys?: unknown;
      provisional?: unknown;
    };
    if (typeof parsed.windowId === "string" && parsed.windowId) {
      state.windowId = parsed.windowId;
    }
    if (typeof parsed.pendingBoundaryId === "string" && parsed.pendingBoundaryId) {
      state.pendingBoundaryId = parsed.pendingBoundaryId;
    }
    if (parsed.provisional === true) {
      state.provisional = true;
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
    return createProjectorState({ provisional: options?.provisional });
  }
  return state;
}

function normalizeSourceRow(row: SourceRow | undefined): SourceRow | undefined {
  if (!row) {
    return undefined;
  }
  return {
    ...row,
    prefix_bytes: row.prefix_bytes || row.indexed_bytes || 0,
    prefix_tail_hash: row.prefix_tail_hash || row.indexed_tail_hash || "",
    prefix_projector_json: row.prefix_projector_json && row.prefix_projector_json !== "{}"
      ? row.prefix_projector_json
      : row.projector_json,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
