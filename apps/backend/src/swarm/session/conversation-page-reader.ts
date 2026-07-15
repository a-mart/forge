import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type {
  ConversationHistoryPageCompleteness,
  ConversationHistoryPageMetadata,
  ConversationHistoryPageSource,
} from "@forge/protocol";
import type { ConversationEntryEvent } from "../types.js";
import { CONVERSATION_ENTRY_TYPE } from "./conversation-timeline.js";
import { isConversationEntryEvent } from "./conversation-validators.js";
import {
  backfillConversationMessageEntryId,
  backfillConversationTimelineMetadata,
} from "./conversation-entry-id.js";
import { projectConversationEntryForBuilderWire } from "./conversation-wire-projection.js";

const CURSOR_VERSION = 2;
const READ_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_CONVERSATION_PAGE_ITEMS = 200;
export const MAX_CONVERSATION_PAGE_ITEMS = 500;
export const MAX_CONVERSATION_PAGE_BYTES = 256 * 1024;
export const MAX_CONVERSATION_PAGE_SCAN_BYTES = 4 * 1024 * 1024;

interface ConversationPageCursorV2 {
  version: typeof CURSOR_VERSION;
  source: "canonical";
  offset: number;
  snapshotSize: number;
  snapshotMtimeMs: number;
  snapshotTailHash: string;
  boundaryHash: string;
  sourceIdentity: string;
  sourceGeneration: string;
  projectionKey: string;
  /** End offset of a source row being crossed over multiple bounded scans. */
  oversizedRowEnd?: number;
  /** Active-memory seam: skip canonical rows through this already-delivered entry. */
  skipThroughTimelineEntryId?: string;
}

export interface ConversationHistoryPageReadMetadata extends ConversationHistoryPageMetadata {
  /** Backend-only source fingerprint used for diagnostics and cursor troubleshooting. */
  sourceRevision: string;
  /** Backend-only serialized payload measurement used to enforce the page budget. */
  pageBytes: number;
  /** Backend-only storage I/O measurement used by sidebar performance telemetry. */
  scanBytes: number;
}

export interface ConversationHistoryPageResult {
  messages: ConversationEntryEvent[];
  page: ConversationHistoryPageReadMetadata;
}

export interface ReadConversationHistoryPageOptions {
  sessionFile: string;
  agentId?: string;
  cursor?: string;
  limit?: number;
  projectionKey?: string;
  isVisible?: (entry: ConversationEntryEvent) => boolean;
  /** Internal cold-load seam: retain canonical payloads before the Builder wire boundary. */
  projectForWire?: boolean;
  /** Deprecated compatibility input. Canonical JSONL is always authoritative for paging. */
  preferCanonical?: boolean;
}

/**
 * Creates a canonical cursor at the current EOF for an active-memory head.
 * The next disk page skips through the oldest head entry, so the memory/file
 * seam is gap-free without placing a list of delivered IDs in the cursor.
 */
export function createConversationHistorySeamCursor(
  sessionFile: string,
  skipThroughTimelineEntryId?: string,
  projectionKey = "all",
): string | undefined {
  const fileStat = readSourceStat(sessionFile);
  if (!fileStat || fileStat.size === 0) return undefined;

  return encodeCursor({
    version: CURSOR_VERSION,
    source: "canonical",
    offset: fileStat.size,
    snapshotSize: fileStat.size,
    snapshotMtimeMs: fileStat.mtimeMs,
    snapshotTailHash: readSnapshotTailHash(sessionFile, fileStat.size),
    boundaryHash: readCursorBoundaryHash(sessionFile, fileStat.size, fileStat.size),
    sourceIdentity: buildSourceIdentity(fileStat),
    sourceGeneration: readSourceGeneration(sessionFile, fileStat.size),
    projectionKey,
    ...(skipThroughTimelineEntryId ? { skipThroughTimelineEntryId } : {}),
  });
}

export function readConversationHistoryPage(
  options: ReadConversationHistoryPageOptions,
): ConversationHistoryPageResult {
  const decodedCursor = decodeCursor(options.cursor);
  const projectionKey = options.projectionKey ?? "all";
  const source = "canonical" as const;
  const sourceFile = options.sessionFile;
  const fileStat = readSourceStat(sourceFile);
  const sourceRevision = fileStat ? buildSourceRevision(fileStat) : "missing";

  if (options.cursor !== undefined && !decodedCursor) {
    return emptyPage(source, sourceRevision, "source_changed", fileStat?.size ?? 0);
  }

  if (decodedCursor && !matchesCursorSnapshot(sourceFile, fileStat, decodedCursor)) {
    return emptyPage(source, sourceRevision, "source_changed", fileStat?.size ?? 0);
  }

  if (decodedCursor && decodedCursor.projectionKey !== projectionKey) {
    return emptyPage(source, sourceRevision, "source_changed", fileStat?.size ?? 0);
  }

  if (!fileStat || fileStat.size === 0) {
    return emptyPage(source, sourceRevision, "complete", 0);
  }

  const limit = normalizePageLimit(options.limit);
  const snapshot = decodedCursor ?? {
    version: CURSOR_VERSION,
    source,
    offset: fileStat.size,
    snapshotSize: fileStat.size,
    snapshotMtimeMs: fileStat.mtimeMs,
    snapshotTailHash: readSnapshotTailHash(sourceFile, fileStat.size),
    boundaryHash: readCursorBoundaryHash(sourceFile, fileStat.size, fileStat.size),
    sourceIdentity: buildSourceIdentity(fileStat),
    sourceGeneration: readSourceGeneration(sourceFile, fileStat.size),
    projectionKey,
  };
  const startOffset = Math.min(snapshot.offset, snapshot.snapshotSize);
  const parsed = readLinesBackward({
    file: sourceFile,
    source,
    startOffset,
    limit,
    agentId: options.agentId,
    continuationRowEnd: decodedCursor?.oversizedRowEnd,
    skipThroughTimelineEntryId: decodedCursor?.skipThroughTimelineEntryId,
    isVisible: options.isVisible,
    projectForWire: options.projectForWire,
  });
  if (parsed.seamBoundaryMissing) {
    return emptyPage(source, sourceRevision, "source_changed", fileStat.size);
  }
  const hasOlder = parsed.nextOffset > 0;
  const completeness: ConversationHistoryPageCompleteness =
    parsed.partialScan && hasOlder ? "partial_scan" : "complete";
  const nextCursor = hasOlder
    ? encodeCursor({
        ...snapshot,
        offset: parsed.nextOffset,
        boundaryHash: readCursorBoundaryHash(sourceFile, parsed.nextOffset, snapshot.snapshotSize),
        oversizedRowEnd: parsed.continuationRowEnd,
        skipThroughTimelineEntryId: parsed.skipThroughTimelineEntryId,
      })
    : undefined;

  return {
    messages: parsed.messages.reverse(),
    page: {
      ...(nextCursor ? { nextCursor } : {}),
      hasOlder,
      completeness,
      source,
      sourceRevision,
      pageBytes: parsed.pageBytes,
      scanBytes: parsed.scanBytes,
    },
  };
}

function readLinesBackward(options: {
  file: string;
  source: Exclude<ConversationHistoryPageSource, "memory">;
  startOffset: number;
  limit: number;
  agentId?: string;
  continuationRowEnd?: number;
  skipThroughTimelineEntryId?: string;
  isVisible?: (entry: ConversationEntryEvent) => boolean;
  projectForWire?: boolean;
}): {
  messages: ConversationEntryEvent[];
  nextOffset: number;
  pageBytes: number;
  scanBytes: number;
  partialScan: boolean;
  continuationRowEnd?: number;
  skipThroughTimelineEntryId?: string;
  seamBoundaryMissing: boolean;
} {
  const messages: ConversationEntryEvent[] = [];
  const activitySummaryIds = new Set<string>();
  let pageBytes = 0;
  let scanBytes = 0;
  let buffer = Buffer.alloc(0);
  let bufferStart = options.startOffset;
  let nextOffset = options.startOffset;
  let partialScan = false;
  let continuationRowEnd = options.continuationRowEnd;
  let skipThroughTimelineEntryId = options.skipThroughTimelineEntryId;
  const fileDescriptor = openSync(options.file, "r");

  try {
    while (bufferStart > 0 && messages.length < options.limit) {
      const readLength = Math.min(READ_CHUNK_BYTES, bufferStart);
      const readStart = bufferStart - readLength;
      const chunk = Buffer.allocUnsafe(readLength);
      const bytesRead = readSync(fileDescriptor, chunk, 0, readLength, readStart);
      if (bytesRead <= 0) break;

      const actualChunk = bytesRead === readLength ? chunk : chunk.subarray(0, bytesRead);
      buffer = Buffer.concat([actualChunk, buffer]);
      bufferStart = readStart;
      scanBytes += bytesRead;

      let right = buffer.length;
      if (right > 0 && buffer[right - 1] === 0x0a) right -= 1;

      while (right > 0 && messages.length < options.limit) {
        const newlineIndex = buffer.lastIndexOf(0x0a, right - 1);
        if (newlineIndex < 0 && bufferStart > 0) break;

        const lineStartIndex = newlineIndex < 0 ? 0 : newlineIndex + 1;
        const lineStartOffset = bufferStart + lineStartIndex;
        const line = buffer.subarray(lineStartIndex, right);
        const consumedOffset = lineStartOffset;
        const rejectedRowEndOffset = nextOffset;
        right = newlineIndex < 0 ? 0 : newlineIndex;
        nextOffset = consumedOffset;

        if (line.length === 0) continue;
        const entry = continuationRowEnd !== undefined
          ? buildOversizedRowPlaceholder(options.agentId, lineStartOffset, continuationRowEnd)
          : parseSourceLine(line.toString("utf8"), options.source, lineStartOffset);
        if (continuationRowEnd !== undefined) {
          continuationRowEnd = undefined;
          partialScan = true;
        }
        if (!entry) continue;

        if (skipThroughTimelineEntryId) {
          if (entry.timelineEntryId === skipThroughTimelineEntryId) {
            skipThroughTimelineEntryId = undefined;
          }
          continue;
        }

        const projectedEntry = options.projectForWire === false
          ? entry
          : projectConversationEntryForBuilderWire(entry);
        if (options.isVisible && !options.isVisible(projectedEntry)) continue;
        if (
          projectedEntry.type === "activity_summary" &&
          activitySummaryIds.has(projectedEntry.itemId)
        ) continue;
        if (projectedEntry.type === "activity_summary") activitySummaryIds.add(projectedEntry.itemId);
        const entryBytes = Buffer.byteLength(JSON.stringify(projectedEntry), "utf8");
        if (messages.length > 0 && pageBytes + entryBytes > MAX_CONVERSATION_PAGE_BYTES) {
          return {
            messages,
            // The row did not fit this page, so the continuation must end
            // after it. Starting at its beginning would skip it forever.
            nextOffset: rejectedRowEndOffset,
            pageBytes,
            scanBytes,
            partialScan,
            ...(continuationRowEnd !== undefined ? { continuationRowEnd } : {}),
            ...(skipThroughTimelineEntryId ? { skipThroughTimelineEntryId } : {}),
            seamBoundaryMissing: false,
          };
        }

        messages.push(projectedEntry);
        pageBytes += entryBytes;
      }

      buffer = buffer.subarray(0, right);
      nextOffset = bufferStart + buffer.length;

      if (scanBytes >= MAX_CONVERSATION_PAGE_SCAN_BYTES && messages.length < options.limit) {
        if (buffer.length > 0) {
          const partialRowEnd = bufferStart + buffer.length;
          const completedRowProgress = options.startOffset - partialRowEnd;
          if (continuationRowEnd === undefined && completedRowProgress >= READ_CHUNK_BYTES) {
            // The scan budget ended inside an otherwise ordinary row after
            // making source progress. Retry that complete row from its end on
            // the next page instead of misclassifying the fragment as an
            // oversized history item.
            nextOffset = partialRowEnd;
          } else {
            // No newline was crossed for a full scan budget. Move across the
            // genuinely oversized row in bounded segments and emit one
            // placeholder when its beginning is reached.
            continuationRowEnd ??= partialRowEnd;
            nextOffset = bufferStart;
          }
        } else {
          nextOffset = bufferStart;
        }
        partialScan = nextOffset > 0;
        break;
      }
    }

    if (bufferStart === 0 && buffer.length > 0 && messages.length < options.limit) {
      const oldestRowEndOffset = nextOffset;
      const entry = continuationRowEnd !== undefined
        ? buildOversizedRowPlaceholder(options.agentId, 0, continuationRowEnd)
        : parseSourceLine(buffer.toString("utf8"), options.source, 0);
      continuationRowEnd = undefined;
      if (entry) {
        if (skipThroughTimelineEntryId) {
          if (entry.timelineEntryId === skipThroughTimelineEntryId) {
            skipThroughTimelineEntryId = undefined;
          }
          nextOffset = 0;
        } else {
        const projectedEntry = options.projectForWire === false
          ? entry
          : projectConversationEntryForBuilderWire(entry);
        if (options.isVisible && !options.isVisible(projectedEntry)) {
          nextOffset = 0;
          return {
            messages,
            nextOffset,
            pageBytes,
            scanBytes,
            partialScan,
            seamBoundaryMissing: false,
          };
        }
        if (
          projectedEntry.type === "activity_summary" &&
          activitySummaryIds.has(projectedEntry.itemId)
        ) {
          nextOffset = 0;
          return {
            messages,
            nextOffset,
            pageBytes,
            scanBytes,
            partialScan,
            seamBoundaryMissing: false,
          };
        }
        const entryBytes = Buffer.byteLength(JSON.stringify(projectedEntry), "utf8");
        if (messages.length > 0 && pageBytes + entryBytes > MAX_CONVERSATION_PAGE_BYTES) {
          return {
            messages,
            nextOffset: oldestRowEndOffset,
            pageBytes,
            scanBytes,
            partialScan,
            seamBoundaryMissing: false,
          };
        }
        if (pageBytes + entryBytes <= MAX_CONVERSATION_PAGE_BYTES) {
          messages.push(projectedEntry);
          pageBytes += entryBytes;
        } else {
          partialScan = true;
        }
        }
      }
      nextOffset = 0;
    }

    return {
      messages,
      nextOffset,
      pageBytes,
      scanBytes,
      partialScan,
      ...(continuationRowEnd !== undefined ? { continuationRowEnd } : {}),
      ...(skipThroughTimelineEntryId ? { skipThroughTimelineEntryId } : {}),
      seamBoundaryMissing: nextOffset === 0 && skipThroughTimelineEntryId !== undefined,
    };
  } finally {
    closeSync(fileDescriptor);
  }
}

function buildOversizedRowPlaceholder(
  agentId: string | undefined,
  rowStart: number,
  rowEnd: number,
): ConversationEntryEvent {
  const id = `oversized-history-entry:${rowStart}:${rowEnd}`;
  return {
    type: "conversation_message",
    id,
    timelineEntryId: id,
    timelineSequence: rowStart,
    agentId: agentId?.trim() || "unknown",
    role: "system",
    text: `A ${formatByteCount(rowEnd - rowStart)} history item is too large to display inline. The full entry remains in canonical session history.`,
    timestamp: new Date(0).toISOString(),
    source: "system",
  };
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte` + (bytes === 1 ? "" : "s");
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function parseSourceLine(
  line: string,
  source: Exclude<ConversationHistoryPageSource, "memory">,
  timelineSequence: number,
): ConversationEntryEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (source === "legacy_cache") {
    return isConversationEntryEvent(parsed) ? parsed : undefined;
  }

  if (!parsed || typeof parsed !== "object") return undefined;
  const custom = parsed as { type?: unknown; customType?: unknown; data?: unknown; id?: unknown };
  if (custom.type !== "custom" || custom.customType !== CONVERSATION_ENTRY_TYPE) return undefined;
  if (!isConversationEntryEvent(custom.data)) return undefined;
  return backfillConversationTimelineMetadata(
    backfillConversationMessageEntryId(
      custom.data,
      typeof custom.id === "string" ? custom.id : undefined,
    ),
    custom.id,
    timelineSequence,
  );
}

function normalizePageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_CONVERSATION_PAGE_ITEMS;
  return Math.max(1, Math.min(MAX_CONVERSATION_PAGE_ITEMS, Math.floor(limit!)));
}

function readSourceStat(file: string): { size: number; mtimeMs: number; ino?: number } | undefined {
  try {
    const value = statSync(file);
    return { size: value.size, mtimeMs: value.mtimeMs, ino: typeof value.ino === "number" ? value.ino : undefined };
  } catch {
    return undefined;
  }
}

function buildSourceRevision(stat: { size: number; mtimeMs: number; ino?: number }): string {
  return `${stat.ino ?? 0}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

function buildSourceIdentity(stat: { ino?: number }): string {
  return String(stat.ino ?? 0);
}

function matchesCursorSnapshot(
  file: string,
  stat: { size: number; mtimeMs: number; ino?: number } | undefined,
  cursor: ConversationPageCursorV2,
): boolean {
  if (!stat || stat.size < cursor.snapshotSize) return false;
  if (buildSourceIdentity(stat) !== cursor.sourceIdentity) return false;
  if (readSourceGeneration(file, stat.size) !== cursor.sourceGeneration) return false;
  if (stat.size === cursor.snapshotSize && stat.mtimeMs !== cursor.snapshotMtimeMs) return false;
  if (readSnapshotTailHash(file, cursor.snapshotSize) !== cursor.snapshotTailHash) return false;
  return readCursorBoundaryHash(file, cursor.offset, cursor.snapshotSize) === cursor.boundaryHash;
}

function readSnapshotTailHash(file: string, snapshotSize: number): string {
  const length = Math.min(256, snapshotSize);
  if (length === 0) return createHash("sha256").update("").digest("base64url");

  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, snapshotSize - length);
    return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("base64url");
  } finally {
    closeSync(descriptor);
  }
}

function readSourceGeneration(file: string, sourceSize: number): string {
  const length = Math.min(64 * 1024, sourceSize);
  if (length === 0) return createHash("sha256").update("").digest("base64url");

  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, 0);
    const readable = buffer.subarray(0, bytesRead);
    const newlineIndex = readable.indexOf(0x0a);
    const generationBytes = newlineIndex >= 0 ? readable.subarray(0, newlineIndex) : readable;
    return createHash("sha256").update(generationBytes).digest("base64url");
  } finally {
    closeSync(descriptor);
  }
}

function readCursorBoundaryHash(file: string, offset: number, snapshotSize: number): string {
  const start = Math.max(0, offset - 256);
  const end = Math.min(snapshotSize, offset + 256);
  const length = Math.max(0, end - start);
  if (length === 0) return createHash("sha256").update("").digest("base64url");

  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, start);
    return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("base64url");
  } finally {
    closeSync(descriptor);
  }
}

function encodeCursor(cursor: ConversationPageCursorV2): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): ConversationPageCursorV2 | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ConversationPageCursorV2>;
    if (parsed.version !== CURSOR_VERSION) return undefined;
    if (parsed.source !== "canonical") return undefined;
    if (!Number.isSafeInteger(parsed.offset) || (parsed.offset ?? -1) < 0) return undefined;
    if (!Number.isSafeInteger(parsed.snapshotSize) || (parsed.snapshotSize ?? -1) < 0) return undefined;
    if (typeof parsed.snapshotMtimeMs !== "number" || !Number.isFinite(parsed.snapshotMtimeMs)) return undefined;
    if (typeof parsed.snapshotTailHash !== "string" || parsed.snapshotTailHash.length === 0) return undefined;
    if (typeof parsed.boundaryHash !== "string" || parsed.boundaryHash.length === 0) return undefined;
    if (typeof parsed.sourceIdentity !== "string" || parsed.sourceIdentity.length === 0) return undefined;
    if (typeof parsed.sourceGeneration !== "string" || parsed.sourceGeneration.length === 0) return undefined;
    if (typeof parsed.projectionKey !== "string" || parsed.projectionKey.length === 0 || parsed.projectionKey.length > 64) return undefined;
    if (
      parsed.oversizedRowEnd !== undefined &&
      (!Number.isSafeInteger(parsed.oversizedRowEnd) ||
        parsed.oversizedRowEnd <= (parsed.offset ?? -1) ||
        parsed.oversizedRowEnd > (parsed.snapshotSize ?? -1))
    ) return undefined;
    if (
      parsed.skipThroughTimelineEntryId !== undefined &&
      (typeof parsed.skipThroughTimelineEntryId !== "string" ||
        parsed.skipThroughTimelineEntryId.trim().length === 0 ||
        parsed.skipThroughTimelineEntryId.length > 256)
    ) return undefined;
    if ((parsed.offset ?? 0) > (parsed.snapshotSize ?? -1)) return undefined;
    return parsed as ConversationPageCursorV2;
  } catch {
    return undefined;
  }
}

function emptyPage(
  source: Exclude<ConversationHistoryPageSource, "memory">,
  sourceRevision: string,
  completeness: ConversationHistoryPageCompleteness,
  sourceSize: number,
): ConversationHistoryPageResult {
  return {
    messages: [],
    page: {
      hasOlder: completeness === "source_changed" && sourceSize > 0,
      completeness,
      source,
      sourceRevision,
      pageBytes: 0,
      scanBytes: 0,
    },
  };
}
