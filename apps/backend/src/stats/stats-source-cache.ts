import { writeFileAtomic } from "../utils/atomic-files.js";
import { createHash } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getSharedStatsSourcesDir } from "../swarm/storage/data-paths.js";
import { projectStatsEntry } from "./stats-entry-projection.js";

export interface StatsSourceRow { byteOffset: number; entry: Record<string, unknown> }
interface SourceCache {
  version: 1;
  source: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  offset: number;
  boundary: string;
  rows: StatsSourceRow[];
}
export interface StatsSourceDiagnostics { bytesRead: number; cacheHits: number; rebuilds: number }

/** Shared by all stats readers. The cache is derived, disposable and contains only projections. */
export class StatsSourceCache {
  private readonly entries = new Map<string, SourceCache>();
  private readonly pending = new Map<string, Promise<StatsSourceRow[]>>();
  readonly diagnostics: StatsSourceDiagnostics = { bytesRead: 0, cacheHits: 0, rebuilds: 0 };

  constructor(private readonly dataDir: string) {}

  read(path: string): Promise<StatsSourceRow[]> {
    path = resolve(path);
    const pending = this.pending.get(path);
    if (pending) return pending;
    const promise = this.readSource(path).catch((error) => {
      if (isMissing(error)) return [];
      throw error;
    }).finally(() => this.pending.delete(path));
    this.pending.set(path, promise);
    return promise;
  }

  private async readSource(path: string): Promise<StatsSourceRow[]> {
    const cacheDir = getSharedStatsSourcesDir(this.dataDir);
    const cachePath = join(cacheDir, `${createHash("sha256").update(path).digest("hex")}.json`);
    let info;
    try { info = await stat(path); } catch (error) {
      if (!isMissing(error)) throw error;
      this.entries.delete(path);
      await rm(cachePath, { force: true }).catch(() => undefined);
      return [];
    }
    let cached = this.entries.get(path);
    if (!cached) {
      try {
        const candidate = JSON.parse(await readFile(cachePath, "utf8")) as SourceCache;
        if (candidate.version === 1 && candidate.source === path && Array.isArray(candidate.rows)
          && Number.isSafeInteger(candidate.offset) && candidate.offset >= 0 && candidate.offset <= candidate.size
          && candidate.rows.every((row) => Number.isSafeInteger(row.byteOffset) && row.byteOffset >= 0
            && row.byteOffset < candidate.offset && row.entry && typeof row.entry === "object")) {
          let valid = true;
          for (const row of candidate.rows) {
            const projected = projectStatsEntry(row.entry, true);
            if (!projected) { valid = false; break; }
            row.entry = projected;
          }
          if (valid) cached = candidate;
        }
      } catch { /* Missing or corrupt derived cache: rebuild only this source. */ }
    }
    const sameFile = cached && cached.dev === info.dev && cached.ino === info.ino && cached.birthtimeMs === info.birthtimeMs;
    if (cached && sameFile && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs
      && cached.offset === info.size) {
      this.remember(path, cached);
      this.diagnostics.cacheHits++;
      return cached.rows;
    }

    const file = await open(path, "r");
    try {
      // Pin reads to one descriptor. A concurrent rotation cannot combine two files.
      const opened = await file.stat();
      const sameOpenedFile = cached && cached.dev === opened.dev && cached.ino === opened.ino && cached.birthtimeMs === opened.birthtimeMs;
      const unchanged = cached && sameOpenedFile && cached.size === opened.size && cached.mtimeMs === opened.mtimeMs && cached.ctimeMs === opened.ctimeMs;
      const append = cached && sameOpenedFile && opened.size > cached.size
        && cached.boundary === await this.boundary(file, cached.offset);
      const resume = unchanged || append;
      const offset = resume && cached ? cached.offset : 0;
      const rows = resume && cached ? [...cached.rows] : [];
      if (!resume) this.diagnostics.rebuilds++;
      const scanned = await this.readRows(file, offset, opened.size, rows);
      const entry: SourceCache = {
        version: 1, source: path, dev: opened.dev, ino: opened.ino, birthtimeMs: opened.birthtimeMs,
        mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs, size: opened.size, offset: scanned.offset,
        boundary: await this.boundary(file, scanned.offset), rows,
      };
      const after = await file.stat();
      if (after.size > opened.size || (after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs)) {
        this.remember(path, entry);
        await writeFileAtomic(cachePath, serializeSource(entry), { mode: 0o600 }).catch(() => undefined);
      }
      // A complete final row without LF is visible, but never checkpointed until LF arrives.
      return scanned.provisional ? [...rows, scanned.provisional] : rows;
    } finally { await file.close(); }
  }

  private remember(path: string, entry: SourceCache): void {
    this.entries.delete(path);
    this.entries.set(path, entry);
    // Keep memory bounded by recently used sources; disk retains every source.
    while (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
  }

  private async boundary(file: FileHandle, offset: number): Promise<string> {
    const hash = createHash("sha256");
    for (const position of [0, Math.max(0, offset - 256)]) {
      const buffer = Buffer.alloc(Math.min(256, offset - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      this.diagnostics.bytesRead += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  }

  private async readRows(file: FileHandle, start: number, end: number, rows: StatsSourceRow[]): Promise<{ offset: number; provisional?: StatsSourceRow }> {
    let position = start;
    let lineStart = start;
    let parts: Buffer[] = [];
    // Never repeatedly concatenate a growing JSONL row (large tool/image rows were quadratic).
    while (position < end) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      this.diagnostics.bytesRead += bytesRead;
      if (!bytesRead) break;
      let from = 0;
      for (let newline = buffer.indexOf(10); newline >= 0 && newline < bytesRead; newline = buffer.indexOf(10, from)) {
        parts.push(buffer.subarray(from, newline));
        const row = parseRow(parts, lineStart);
        if (row) rows.push(row);
        parts = [];
        from = newline + 1;
        lineStart = position + from;
      }
      if (from < bytesRead) parts.push(buffer.subarray(from, bytesRead));
      position += bytesRead;
    }
    return { offset: lineStart, provisional: parts.length ? parseRow(parts, lineStart) : undefined };
  }
}

async function* serializeSource(source: SourceCache): AsyncGenerator<string> {
  const { rows, ...header } = source;
  yield `${JSON.stringify(header).slice(0, -1)},"rows":[`;
  for (let index = 0; index < rows.length; index += 256) {
    const chunk = rows.slice(index, index + 256);
    yield `${index ? "," : ""}${chunk.map((row) => JSON.stringify(row)).join(",")}`;
  }
  yield "]}";
}

function parseRow(parts: Buffer[], byteOffset: number): StatsSourceRow | undefined {
  try {
    const entry = projectStatsEntry(JSON.parse(Buffer.concat(parts).toString("utf8")));
    return entry ? { byteOffset, entry } : undefined;
  } catch { return undefined; }
}
function isMissing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }

const caches = new Map<string, StatsSourceCache>();
export function getStatsSourceCache(dataDir: string): StatsSourceCache {
  const key = resolve(dataDir);
  let cache = caches.get(key);
  if (!cache) { cache = new StatsSourceCache(key); caches.set(key, cache); }
  return cache;
}
