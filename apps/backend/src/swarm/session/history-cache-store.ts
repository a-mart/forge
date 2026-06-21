import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dirname } from "node:path";
import type { HistoryCacheState } from "../../stats/sidebar-perf-metrics.js";
import type { ConversationEntryEvent } from "../types.js";
import { mergeDiagnosticDetails } from "./conversation-diagnostics.js";
import { getConversationHistoryCacheFilePath } from "./conversation-history-cache.js";
import { CONVERSATION_ENTRY_TYPE, extractSessionEntryId, hasValidSessionHeader } from "./conversation-timeline.js";
import { isConversationEntryEvent } from "./conversation-validators.js";
import {
  MAX_CONVERSATION_HISTORY,
  shouldPersistConversationEntry,
  shouldWriteConversationHistoryCacheEntry
} from "./history-policy.js";

const MAX_SAFE_JSON_BYTES = 32 * 1024;
const SAFE_JSON_TRUNCATED_SUFFIX = " [truncated]";
const CONVERSATION_CACHE_META_TYPE = "swarm_conversation_cache_meta";
const CONVERSATION_CACHE_VERSION = 4;

interface HistoryCacheStoreOptions {
  logDebug: (message: string, details?: unknown) => void;
  readSessionFileCanonicalStat?: (sessionFile: string) => ConversationHistoryCacheCanonicalStat | null;
  readPersistedConversationEntrySummary?: (sessionFile: string) => PersistedConversationEntrySummaryResult;
}

export interface ConversationHistoryCacheCanonicalStat {
  size: number;
  mtimeMs: number;
}

export interface ConversationHistoryCacheMetadata {
  type: typeof CONVERSATION_CACHE_META_TYPE;
  version: typeof CONVERSATION_CACHE_VERSION;
  persistedEntryCount: number;
  cachedPersistedEntryCount: number;
  firstPersistedEntryKey: string | null;
  lastPersistedEntryKey: string | null;
  canonicalStat: ConversationHistoryCacheCanonicalStat;
}

interface LoadedConversationHistoryCache {
  entries: ConversationEntryEvent[];
  metadata: ConversationHistoryCacheMetadata | null;
}

export interface LoadedConversationHistoryCacheResult {
  cacheState: "loaded" | "absent" | "cache_read_error";
  cachedHistory: LoadedConversationHistoryCache | null;
  cacheFileBytes?: number;
  cacheReadMs?: number;
  fsReadOps: number;
  fsReadBytes: number;
  detail?: string | null;
}

export interface LoadedConversationHistoryCacheHeaderResult {
  cacheState: "loaded" | "absent" | "cache_read_error" | "legacy_rebuild";
  metadata: ConversationHistoryCacheMetadata | null;
  cacheFileBytes?: number;
  cacheReadMs?: number;
  fsReadOps: number;
  fsReadBytes: number;
  detail?: string | null;
}

export interface ValidatedConversationHistoryCanonicalProof {
  persistedEntryCount: number;
  lastPersistedEntryKey: string | null;
  canonicalStat: ConversationHistoryCacheCanonicalStat | null;
}

export interface ValidatedConversationHistoryCacheResult {
  ok: boolean;
  entries?: ConversationEntryEvent[];
  cacheState?: Exclude<HistoryCacheState, "memory" | "hit" | "absent" | "size_guard_skip">;
  persistedEntryCount: number;
  cachedEntryCount: number;
  sessionFileBytes?: number;
  sessionSummaryBytesScanned?: number;
  sessionSummaryReadMs?: number;
  cacheReadMs?: number;
  fsReadOps: number;
  fsReadBytes: number;
  detail?: string | null;
  fastPathUsed: boolean;
  rewriteCache: boolean;
  validatedCanonicalProof?: ValidatedConversationHistoryCanonicalProof;
}

interface QueuedConversationHistoryCacheSnapshot {
  sessionFile: string;
  history: ConversationEntryEvent[] | null;
  metadata: ConversationHistoryCacheMetadata | null;
}

interface PersistedConversationEntryIdentity {
  key: string;
}

interface PersistedConversationEntrySummary {
  count: number;
  first: PersistedConversationEntryIdentity | null;
  last: PersistedConversationEntryIdentity | null;
}

interface PersistedConversationEntrySummaryResult {
  summary: PersistedConversationEntrySummary;
  sessionFileBytes?: number;
  sessionSummaryBytesScanned?: number;
  sessionSummaryReadMs?: number;
  fsReadOps: number;
  fsReadBytes: number;
  detail?: string | null;
}

export class HistoryCacheStore {
  private readonly pendingCacheWrites = new Map<string, Promise<void>>();
  private readonly queuedCacheSnapshots = new Map<string, QueuedConversationHistoryCacheSnapshot>();
  private readonly persistedEntryCountBySessionFile = new Map<string, number>();

  constructor(private readonly options: HistoryCacheStoreOptions) {}

  clear(): void {
    this.persistedEntryCountBySessionFile.clear();
  }

  resetSession(sessionFile: string): void {
    this.persistedEntryCountBySessionFile.delete(sessionFile);
  }

  getPersistedEntryCount(sessionFile: string): number | undefined {
    return this.persistedEntryCountBySessionFile.get(sessionFile);
  }

  trackPersistedEntryCount(sessionFile: string, count: number): void {
    this.persistedEntryCountBySessionFile.set(sessionFile, Math.max(0, Math.trunc(count)));
  }

  incrementPersistedEntryCount(sessionFile: string): void {
    this.trackPersistedEntryCount(sessionFile, (this.persistedEntryCountBySessionFile.get(sessionFile) ?? 0) + 1);
  }

  loadConversationHistoryCacheHeader(sessionFile: string): LoadedConversationHistoryCacheHeaderResult {
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    if (!existsSync(cacheFile)) {
      return {
        cacheState: "absent",
        metadata: null,
        fsReadOps: 0,
        fsReadBytes: 0
      };
    }

    const startedAtMs = performance.now();
    let fileDescriptor: number | undefined;

    try {
      const cacheFileBytes = statSync(cacheFile).size;
      if (cacheFileBytes <= 0) {
        return {
          cacheState: "legacy_rebuild",
          metadata: null,
          cacheFileBytes,
          cacheReadMs: performance.now() - startedAtMs,
          fsReadOps: 0,
          fsReadBytes: 0,
          detail: "missing_cache_metadata"
        };
      }

      fileDescriptor = openSync(cacheFile, "r");
      const chunkSize = 4096;
      let headerLine = "";
      let position = 0;
      let fsReadOps = 0;
      let fsReadBytes = 0;

      while (position < cacheFileBytes) {
        const readLength = Math.min(chunkSize, cacheFileBytes - position);
        const buffer = Buffer.alloc(readLength);
        const bytesRead = readSync(fileDescriptor, buffer, 0, readLength, position);
        if (bytesRead <= 0) {
          break;
        }

        fsReadOps += 1;
        fsReadBytes += bytesRead;
        position += bytesRead;
        headerLine += buffer.toString("utf8", 0, bytesRead);

        const newlineIndex = headerLine.indexOf("\n");
        if (newlineIndex >= 0) {
          headerLine = headerLine.slice(0, newlineIndex);
          break;
        }
      }

      const trimmedHeaderLine = headerLine.trim();
      if (trimmedHeaderLine.length === 0) {
        return {
          cacheState: "legacy_rebuild",
          metadata: null,
          cacheFileBytes,
          cacheReadMs: performance.now() - startedAtMs,
          fsReadOps,
          fsReadBytes,
          detail: "missing_cache_metadata"
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedHeaderLine);
      } catch {
        return {
          cacheState: "cache_read_error",
          metadata: null,
          cacheFileBytes,
          cacheReadMs: performance.now() - startedAtMs,
          fsReadOps,
          fsReadBytes,
          detail: "invalid_cache_payload"
        };
      }

      const metadata = parseConversationHistoryCacheMetadata(parsed);
      if (metadata) {
        return {
          cacheState: "loaded",
          metadata,
          cacheFileBytes,
          cacheReadMs: performance.now() - startedAtMs,
          fsReadOps,
          fsReadBytes
        };
      }

      if (isConversationHistoryCacheMetadataRecord(parsed) || isConversationEntryEvent(parsed)) {
        return {
          cacheState: "legacy_rebuild",
          metadata: null,
          cacheFileBytes,
          cacheReadMs: performance.now() - startedAtMs,
          fsReadOps,
          fsReadBytes,
          detail: "missing_cache_metadata"
        };
      }

      return {
        cacheState: "cache_read_error",
        metadata: null,
        cacheFileBytes,
        cacheReadMs: performance.now() - startedAtMs,
        fsReadOps,
        fsReadBytes,
        detail: "invalid_cache_payload"
      };
    } catch (error) {
      this.options.logDebug("history:load:cache:error", {
        cacheFile,
        message: error instanceof Error ? error.message : String(error)
      });
      return {
        cacheState: "cache_read_error",
        metadata: null,
        cacheReadMs: performance.now() - startedAtMs,
        fsReadOps: 0,
        fsReadBytes: 0,
        detail: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (fileDescriptor !== undefined) {
        closeSync(fileDescriptor);
      }
    }
  }

  loadConversationHistoryFromCache(sessionFile: string): LoadedConversationHistoryCacheResult {
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    if (!existsSync(cacheFile)) {
      return {
        cacheState: "absent",
        cachedHistory: null,
        fsReadOps: 0,
        fsReadBytes: 0
      };
    }

    const startedAtMs = performance.now();

    try {
      const raw = readFileSync(cacheFile, "utf8");
      const cacheFileBytes = Buffer.byteLength(raw, "utf8");
      if (raw.trim().length === 0) {
        return {
          cacheState: "cache_read_error",
          cachedHistory: null,
          cacheFileBytes,
          cacheReadMs: performance.now() - startedAtMs,
          fsReadOps: 1,
          fsReadBytes: cacheFileBytes,
          detail: "missing_cache_metadata"
        };
      }

      const entries: ConversationEntryEvent[] = [];
      let metadata: ConversationHistoryCacheMetadata | null = null;
      for (const line of raw.split("\n")) {
        if (!line.trim()) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const parsedMetadata = parseConversationHistoryCacheMetadata(parsed);
        if (parsedMetadata) {
          metadata = parsedMetadata;
          continue;
        }

        if (isConversationEntryEvent(parsed) && shouldWriteConversationHistoryCacheEntry(parsed)) {
          entries.push(parsed);
        }
      }

      if (!metadata && entries.length === 0 && raw.trim().length > 0) {
        return {
          cacheState: "cache_read_error",
          cachedHistory: null,
          cacheFileBytes,
          cacheReadMs: performance.now() - startedAtMs,
          fsReadOps: 1,
          fsReadBytes: cacheFileBytes,
          detail: "invalid_cache_payload"
        };
      }

      return {
        cacheState: "loaded",
        cachedHistory: {
          entries,
          metadata
        },
        cacheFileBytes,
        cacheReadMs: performance.now() - startedAtMs,
        fsReadOps: 1,
        fsReadBytes: cacheFileBytes
      };
    } catch (error) {
      this.options.logDebug("history:load:cache:error", {
        cacheFile,
        message: error instanceof Error ? error.message : String(error)
      });
      return {
        cacheState: "cache_read_error",
        cachedHistory: null,
        cacheReadMs: performance.now() - startedAtMs,
        fsReadOps: 0,
        fsReadBytes: 0,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  validateCachedConversationHistory(
    sessionFile: string,
    metadata: ConversationHistoryCacheMetadata
  ): ValidatedConversationHistoryCacheResult {
    let canonicalStat = this.readSessionFileCanonicalStatForValidation(sessionFile);
    let persistedEntryCount = metadata.persistedEntryCount;
    let lastPersistedEntryKey = metadata.lastPersistedEntryKey;
    let sessionFileBytes = canonicalStat?.size;
    let sessionSummaryBytesScanned: number | undefined;
    let sessionSummaryReadMs: number | undefined;
    let summaryFsReadOps = 0;
    let summaryFsReadBytes = 0;
    let detail: string | null = null;
    let fastPathUsed = false;
    let rewriteCache = false;
    let canonicalProofStable = true;

    const refreshCanonicalProofFromSummary = (): void => {
      rewriteCache = true;
      fastPathUsed = false;
      canonicalProofStable = false;

      const maxSummaryProofAttempts = 2;
      for (let attempt = 0; attempt < maxSummaryProofAttempts; attempt += 1) {
        const preSummaryStat = this.readSessionFileCanonicalStatForValidation(sessionFile);
        const sessionSummaryResult = this.readPersistedConversationEntrySummaryForValidation(sessionFile);
        persistedEntryCount = sessionSummaryResult.summary.count;
        lastPersistedEntryKey = sessionSummaryResult.summary.last?.key ?? null;
        sessionFileBytes = sessionSummaryResult.sessionFileBytes;
        sessionSummaryBytesScanned = sessionSummaryResult.sessionSummaryBytesScanned;
        sessionSummaryReadMs = sessionSummaryResult.sessionSummaryReadMs;
        summaryFsReadOps += sessionSummaryResult.fsReadOps;
        summaryFsReadBytes += sessionSummaryResult.fsReadBytes;
        detail = mergeDiagnosticDetails(detail, sessionSummaryResult.detail);
        const postSummaryStat = this.readSessionFileCanonicalStatForValidation(sessionFile);
        canonicalStat = postSummaryStat;

        if (
          (preSummaryStat &&
            postSummaryStat &&
            doesConversationHistoryCacheCanonicalStatMatch(preSummaryStat, postSummaryStat)) ||
          (!preSummaryStat && !postSummaryStat)
        ) {
          canonicalProofStable = true;
          return;
        }

        detail = mergeDiagnosticDetails(detail, "canonical_changed_during_summary_scan");
      }
    };

    if (!canonicalStat || !doesConversationHistoryCacheCanonicalStatMatch(metadata.canonicalStat, canonicalStat)) {
      refreshCanonicalProofFromSummary();
    } else {
      fastPathUsed = true;
    }

    const cacheLoad = this.loadConversationHistoryFromCache(sessionFile);
    const cacheReadMs = cacheLoad.cacheReadMs;
    const getTotalFsReadOps = (): number => summaryFsReadOps + cacheLoad.fsReadOps;
    const getTotalFsReadBytes = (): number => summaryFsReadBytes + cacheLoad.fsReadBytes;
    const buildFailure = (
      cacheState: Exclude<HistoryCacheState, "memory" | "hit" | "absent" | "size_guard_skip">,
      failureDetail?: string | null
    ): ValidatedConversationHistoryCacheResult => ({
      ok: false,
      cacheState,
      persistedEntryCount,
      cachedEntryCount: 0,
      sessionFileBytes,
      sessionSummaryBytesScanned,
      sessionSummaryReadMs,
      cacheReadMs,
      fsReadOps: getTotalFsReadOps(),
      fsReadBytes: getTotalFsReadBytes(),
      detail: mergeDiagnosticDetails(detail, cacheLoad.detail, failureDetail),
      fastPathUsed: false,
      rewriteCache: false
    });

    if (!cacheLoad.cachedHistory) {
      return buildFailure("cache_read_error");
    }

    if (!canonicalProofStable) {
      return buildFailure("cache_read_error");
    }

    const cachedHistory = cacheLoad.cachedHistory;
    const cacheSummary = summarizePersistedConversationEntries(cachedHistory.entries);
    const buildMismatchResult = (
      cacheState: Exclude<HistoryCacheState, "memory" | "hit" | "absent" | "size_guard_skip">,
      mismatchDetail?: string | null
    ): ValidatedConversationHistoryCacheResult => ({
      ok: false,
      cacheState,
      persistedEntryCount,
      cachedEntryCount: cacheSummary.count,
      sessionFileBytes,
      sessionSummaryBytesScanned,
      sessionSummaryReadMs,
      cacheReadMs,
      fsReadOps: getTotalFsReadOps(),
      fsReadBytes: getTotalFsReadBytes(),
      detail: mergeDiagnosticDetails(detail, cacheLoad.detail, mismatchDetail),
      fastPathUsed,
      rewriteCache: false
    });
    const buildSuccess = (
      validatedCanonicalStat: ConversationHistoryCacheCanonicalStat
    ): ValidatedConversationHistoryCacheResult => ({
      ok: true,
      entries: cachedHistory.entries,
      persistedEntryCount,
      cachedEntryCount: cacheSummary.count,
      sessionFileBytes,
      sessionSummaryBytesScanned,
      sessionSummaryReadMs,
      cacheReadMs,
      fsReadOps: getTotalFsReadOps(),
      fsReadBytes: getTotalFsReadBytes(),
      detail: mergeDiagnosticDetails(detail, cacheLoad.detail),
      fastPathUsed,
      rewriteCache,
      validatedCanonicalProof: {
        persistedEntryCount,
        lastPersistedEntryKey,
        canonicalStat: validatedCanonicalStat
      }
    });

    if (
      !cachedHistory.metadata ||
      !doesConversationHistoryCacheMetadataMatchEntries(cachedHistory.metadata, cacheSummary) ||
      !doesConversationHistoryCacheMetadataMatchFingerprint(cachedHistory.metadata, metadata)
    ) {
      this.options.logDebug("history:load:cache:validate:reject", {
        sessionFile,
        reason: "metadata_entries_mismatch"
      });
      return {
        ...buildMismatchResult("metadata_entries_mismatch"),
        fastPathUsed: false
      };
    }

    const maxCanonicalValidationAttempts = 2;
    for (let attempt = 0; attempt < maxCanonicalValidationAttempts; attempt += 1) {
      if (!(cacheSummary.count === 0 && persistedEntryCount === 0 && hasValidSessionHeader(sessionFile))) {
        if (
          cachedHistory.entries.length < MAX_CONVERSATION_HISTORY &&
          cachedHistory.metadata.cachedPersistedEntryCount < persistedEntryCount
        ) {
          this.options.logDebug("history:load:cache:validate:reject", {
            sessionFile,
            reason: "cache_missing_persisted_prefix"
          });
          return buildMismatchResult("cache_missing_persisted_prefix");
        }

        if (cachedHistory.metadata.persistedEntryCount !== persistedEntryCount) {
          this.options.logDebug("history:load:cache:validate:reject", {
            sessionFile,
            reason: "persisted_entry_count_mismatch",
            expected: cachedHistory.metadata.persistedEntryCount,
            actual: persistedEntryCount
          });
          return buildMismatchResult(
            "persisted_entry_count_mismatch",
            `expected=${cachedHistory.metadata.persistedEntryCount},actual=${persistedEntryCount}`
          );
        }

        if (cachedHistory.metadata.lastPersistedEntryKey !== lastPersistedEntryKey) {
          this.options.logDebug("history:load:cache:validate:reject", {
            sessionFile,
            reason: "last_persisted_entry_mismatch"
          });
          return buildMismatchResult("last_persisted_entry_mismatch");
        }
      }

      const postValidationStat = this.readSessionFileCanonicalStatForValidation(sessionFile);
      if (
        canonicalStat &&
        postValidationStat &&
        doesConversationHistoryCacheCanonicalStatMatch(canonicalStat, postValidationStat)
      ) {
        return buildSuccess(postValidationStat);
      }

      detail = mergeDiagnosticDetails(detail, "canonical_changed_during_validation");
      if (attempt === maxCanonicalValidationAttempts - 1) {
        this.options.logDebug("history:load:cache:validate:reject", {
          sessionFile,
          reason: "canonical_changed_during_validation"
        });
        return buildMismatchResult("cache_read_error");
      }

      refreshCanonicalProofFromSummary();
      if (!canonicalProofStable) {
        this.options.logDebug("history:load:cache:validate:reject", {
          sessionFile,
          reason: "canonical_changed_during_summary_scan"
        });
        return buildMismatchResult("cache_read_error");
      }
    }

    return buildMismatchResult("cache_read_error");
  }

  readSessionFileCanonicalStat(sessionFile: string): ConversationHistoryCacheCanonicalStat | null {
    try {
      const fileStat = statSync(sessionFile);
      return {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      };
    } catch (error) {
      if (isEnoentError(error)) {
        return null;
      }

      throw error;
    }
  }

  buildMetadata(
    history: ConversationEntryEvent[],
    persistedEntryCount: number,
    canonicalStat: ConversationHistoryCacheCanonicalStat | null
  ): ConversationHistoryCacheMetadata {
    return buildConversationHistoryCacheMetadata(history, persistedEntryCount, canonicalStat);
  }

  queueCacheSnapshotWrite(
    sessionFile: string,
    history: ConversationEntryEvent[] | null,
    metadata: ConversationHistoryCacheMetadata | null = null
  ): void {
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    this.queuedCacheSnapshots.set(cacheFile, {
      sessionFile,
      history,
      metadata
    });

    if (this.pendingCacheWrites.has(cacheFile)) {
      return;
    }

    const writePromise = this.flushQueuedCacheSnapshot(cacheFile)
      .catch((error) => {
        this.options.logDebug("history:cache:write:error", {
          cacheFile,
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        this.pendingCacheWrites.delete(cacheFile);
        const queuedSnapshot = this.queuedCacheSnapshots.get(cacheFile);
        if (queuedSnapshot) {
          this.queueCacheSnapshotWrite(queuedSnapshot.sessionFile, queuedSnapshot.history, queuedSnapshot.metadata);
        }
      });

    this.pendingCacheWrites.set(cacheFile, writePromise);
  }

  async flushPendingWrites(): Promise<void> {
    while (this.pendingCacheWrites.size > 0) {
      await Promise.all(this.pendingCacheWrites.values());
    }
  }

  readPersistedConversationEntrySummary(sessionFile: string): PersistedConversationEntrySummaryResult {
    let fileDescriptor: number | undefined;
    const startedAtMs = performance.now();

    try {
      const fileSize = statSync(sessionFile).size;
      if (fileSize <= 0) {
        return {
          summary: { count: 0, first: null, last: null },
          sessionFileBytes: fileSize,
          sessionSummaryBytesScanned: 0,
          sessionSummaryReadMs: performance.now() - startedAtMs,
          fsReadOps: 0,
          fsReadBytes: 0
        };
      }

      const chunkSize = 8192;
      let position = 0;
      let remainder = "";
      let count = 0;
      let first: PersistedConversationEntryIdentity | null = null;
      let last: PersistedConversationEntryIdentity | null = null;
      let fsReadOps = 0;
      let fsReadBytes = 0;

      fileDescriptor = openSync(sessionFile, "r");

      while (position < fileSize) {
        const readLength = Math.min(chunkSize, fileSize - position);
        const buffer = Buffer.alloc(readLength);
        const bytesRead = readSync(fileDescriptor, buffer, 0, readLength, position);
        if (bytesRead <= 0) {
          break;
        }

        fsReadOps += 1;
        fsReadBytes += bytesRead;
        const chunk = buffer.toString("utf8", 0, bytesRead);
        const combined = `${remainder}${chunk}`;
        const lines = combined.split("\n");
        remainder = lines.pop() ?? "";

        for (const line of lines) {
          const identity = parsePersistedConversationEntryIdentity(line);
          if (!identity) {
            continue;
          }

          if (!first) {
            first = identity;
          }
          last = identity;
          count += 1;
        }

        position += bytesRead;
      }

      const finalIdentity = parsePersistedConversationEntryIdentity(remainder);
      if (finalIdentity) {
        if (!first) {
          first = finalIdentity;
        }
        last = finalIdentity;
        count += 1;
      }

      return {
        summary: { count, first, last },
        sessionFileBytes: fileSize,
        sessionSummaryBytesScanned: fsReadBytes,
        sessionSummaryReadMs: performance.now() - startedAtMs,
        fsReadOps,
        fsReadBytes
      };
    } catch (error) {
      if (isEnoentError(error)) {
        return {
          summary: { count: 0, first: null, last: null },
          sessionSummaryBytesScanned: 0,
          sessionSummaryReadMs: performance.now() - startedAtMs,
          fsReadOps: 0,
          fsReadBytes: 0,
          detail: "session_file_missing"
        };
      }

      this.options.logDebug("history:load:cache:validate:error", {
        sessionFile,
        message: error instanceof Error ? error.message : String(error)
      });
      return {
        summary: { count: 0, first: null, last: null },
        sessionSummaryBytesScanned: 0,
        sessionSummaryReadMs: performance.now() - startedAtMs,
        fsReadOps: 0,
        fsReadBytes: 0,
        detail: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (fileDescriptor !== undefined) {
        closeSync(fileDescriptor);
      }
    }
  }

  private readSessionFileCanonicalStatForValidation(sessionFile: string): ConversationHistoryCacheCanonicalStat | null {
    return this.options.readSessionFileCanonicalStat?.(sessionFile) ?? this.readSessionFileCanonicalStat(sessionFile);
  }

  private readPersistedConversationEntrySummaryForValidation(sessionFile: string): PersistedConversationEntrySummaryResult {
    return this.options.readPersistedConversationEntrySummary?.(sessionFile) ?? this.readPersistedConversationEntrySummary(sessionFile);
  }

  private async flushQueuedCacheSnapshot(cacheFile: string): Promise<void> {
    while (this.queuedCacheSnapshots.has(cacheFile)) {
      const queuedSnapshot = this.queuedCacheSnapshots.get(cacheFile);
      this.queuedCacheSnapshots.delete(cacheFile);

      if (!queuedSnapshot) {
        continue;
      }

      const { history, metadata } = queuedSnapshot;
      if (history === null) {
        await rm(cacheFile, { force: true });
        continue;
      }

      await mkdir(dirname(cacheFile), { recursive: true });
      const resolvedMetadata =
        metadata ?? buildConversationHistoryCacheMetadata(history, 0, this.readSessionFileCanonicalStat(queuedSnapshot.sessionFile));
      const cacheEntries = history.filter(shouldWriteConversationHistoryCacheEntry);
      const serializedHistory = `${[
        JSON.stringify(resolvedMetadata),
        ...cacheEntries.map((entry) => JSON.stringify(entry))
      ].join("\n")}\n`;
      const tempCacheFile = `${cacheFile}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
      await writeFile(tempCacheFile, serializedHistory, "utf8");
      await rename(tempCacheFile, cacheFile);
    }
  }
}

function safeJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }

  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes <= MAX_SAFE_JSON_BYTES) {
    return serialized;
  }

  const suffixBytes = Buffer.byteLength(SAFE_JSON_TRUNCATED_SUFFIX, "utf8");
  if (MAX_SAFE_JSON_BYTES <= suffixBytes) {
    return SAFE_JSON_TRUNCATED_SUFFIX;
  }

  const previewByteCount = MAX_SAFE_JSON_BYTES - suffixBytes;
  const preview = Buffer.from(serialized, "utf8").subarray(0, previewByteCount).toString("utf8");
  return `${preview}${SAFE_JSON_TRUNCATED_SUFFIX}`;
}

function extractConversationEntryEventId(entry: ConversationEntryEvent): string | undefined {
  if (entry.type === "choice_request") {
    return entry.choiceId.trim().length > 0 ? entry.choiceId : undefined;
  }

  if (
    entry.type !== "conversation_message" &&
    entry.type !== "work_plan_created" &&
    entry.type !== "model_cache_observation"
  ) {
    return undefined;
  }

  if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
    return undefined;
  }

  return entry.id;
}

function extractPersistedConversationEntryIdentity(
  entry: ConversationEntryEvent | undefined
): PersistedConversationEntryIdentity | null {
  if (!entry || !shouldPersistConversationEntry(entry)) {
    return null;
  }

  const entryId = extractConversationEntryEventId(entry);
  if (entryId) {
    return { key: `${entry.type}:${entryId}` };
  }

  return { key: `entry:${safeJson(entry)}` };
}

function summarizePersistedConversationEntries(
  history: ConversationEntryEvent[]
): PersistedConversationEntrySummary {
  let count = 0;
  let first: PersistedConversationEntryIdentity | null = null;
  let last: PersistedConversationEntryIdentity | null = null;

  for (const entry of history) {
    const identity = extractPersistedConversationEntryIdentity(entry);
    if (!identity) {
      continue;
    }

    if (!first) {
      first = identity;
    }

    last = identity;
    count += 1;
  }

  return { count, first, last };
}

function buildConversationHistoryCacheMetadata(
  history: ConversationEntryEvent[],
  persistedEntryCount: number,
  canonicalStat: ConversationHistoryCacheCanonicalStat | null
): ConversationHistoryCacheMetadata {
  const summary = summarizePersistedConversationEntries(history);

  return {
    type: CONVERSATION_CACHE_META_TYPE,
    version: CONVERSATION_CACHE_VERSION,
    persistedEntryCount: Math.max(0, Math.trunc(persistedEntryCount)),
    cachedPersistedEntryCount: summary.count,
    firstPersistedEntryKey: summary.first?.key ?? null,
    lastPersistedEntryKey: summary.last?.key ?? null,
    canonicalStat: normalizeConversationHistoryCacheCanonicalStat(canonicalStat)
  };
}

function doesConversationHistoryCacheMetadataMatchEntries(
  metadata: ConversationHistoryCacheMetadata,
  summary: PersistedConversationEntrySummary
): boolean {
  return (
    metadata.cachedPersistedEntryCount === summary.count &&
    metadata.firstPersistedEntryKey === (summary.first?.key ?? null) &&
    metadata.lastPersistedEntryKey === (summary.last?.key ?? null)
  );
}

function doesConversationHistoryCacheMetadataMatchFingerprint(
  metadata: ConversationHistoryCacheMetadata,
  expected: ConversationHistoryCacheMetadata
): boolean {
  return doesConversationHistoryCacheCanonicalStatMatch(metadata.canonicalStat, expected.canonicalStat);
}

function doesConversationHistoryCacheCanonicalStatMatch(
  left: ConversationHistoryCacheCanonicalStat,
  right: ConversationHistoryCacheCanonicalStat
): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function normalizeConversationHistoryCacheCanonicalStat(
  value: ConversationHistoryCacheCanonicalStat | null | undefined
): ConversationHistoryCacheCanonicalStat {
  return {
    size: Math.max(0, Math.trunc(value?.size ?? 0)),
    mtimeMs: typeof value?.mtimeMs === "number" && Number.isFinite(value.mtimeMs) ? value.mtimeMs : 0
  };
}

function isConversationHistoryCacheMetadataRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === CONVERSATION_CACHE_META_TYPE
  );
}

function parseConversationHistoryCacheMetadata(value: unknown): ConversationHistoryCacheMetadata | null {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { type?: unknown }).type !== CONVERSATION_CACHE_META_TYPE ||
    (value as { version?: unknown }).version !== CONVERSATION_CACHE_VERSION
  ) {
    return null;
  }

  const persistedEntryCount = (value as { persistedEntryCount?: unknown }).persistedEntryCount;
  const cachedPersistedEntryCount = (value as { cachedPersistedEntryCount?: unknown }).cachedPersistedEntryCount;
  const firstPersistedEntryKey = (value as { firstPersistedEntryKey?: unknown }).firstPersistedEntryKey;
  const lastPersistedEntryKey = (value as { lastPersistedEntryKey?: unknown }).lastPersistedEntryKey;
  const canonicalStat = (value as { canonicalStat?: unknown }).canonicalStat;

  if (typeof persistedEntryCount !== "number" || !Number.isFinite(persistedEntryCount) || persistedEntryCount < 0) {
    return null;
  }

  if (
    typeof cachedPersistedEntryCount !== "number" ||
    !Number.isFinite(cachedPersistedEntryCount) ||
    cachedPersistedEntryCount < 0
  ) {
    return null;
  }

  if (firstPersistedEntryKey !== null && typeof firstPersistedEntryKey !== "string") {
    return null;
  }

  if (lastPersistedEntryKey !== null && typeof lastPersistedEntryKey !== "string") {
    return null;
  }

  if (typeof canonicalStat !== "object" || canonicalStat === null) {
    return null;
  }

  const canonicalSize = (canonicalStat as { size?: unknown }).size;
  const canonicalMtimeMs = (canonicalStat as { mtimeMs?: unknown }).mtimeMs;
  if (typeof canonicalSize !== "number" || !Number.isFinite(canonicalSize) || canonicalSize < 0) {
    return null;
  }

  if (typeof canonicalMtimeMs !== "number" || !Number.isFinite(canonicalMtimeMs) || canonicalMtimeMs < 0) {
    return null;
  }

  return {
    type: CONVERSATION_CACHE_META_TYPE,
    version: CONVERSATION_CACHE_VERSION,
    persistedEntryCount: Math.max(0, Math.trunc(persistedEntryCount)),
    cachedPersistedEntryCount: Math.max(0, Math.trunc(cachedPersistedEntryCount)),
    firstPersistedEntryKey,
    lastPersistedEntryKey,
    canonicalStat: normalizeConversationHistoryCacheCanonicalStat({
      size: canonicalSize,
      mtimeMs: canonicalMtimeMs
    })
  };
}

function parsePersistedConversationEntryIdentity(line: string | undefined): PersistedConversationEntryIdentity | null {
  const trimmedLine = line?.trim();
  if (!trimmedLine) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedLine);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { type?: unknown }).type !== "custom" ||
    (parsed as { customType?: unknown }).customType !== CONVERSATION_ENTRY_TYPE
  ) {
    return null;
  }

  const data = (parsed as { data?: unknown }).data;
  if (!isConversationEntryEvent(data) || !shouldPersistConversationEntry(data)) {
    return null;
  }

  const wrapperEntryId = extractSessionEntryId(parsed);
  const hydratedEntry =
    data.type === "conversation_message" && wrapperEntryId
      ? {
          ...data,
          id:
            typeof data.id === "string" && data.id.trim().length > 0
              ? data.id
              : wrapperEntryId
        }
      : data;

  return extractPersistedConversationEntryIdentity(hydratedEntry);
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
