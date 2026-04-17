import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname } from "node:path";
import type { ServerEvent } from "@forge/protocol";
import {
  SIDEBAR_HISTORY_CACHE_STATE_METRIC,
  type HistoryCacheState,
  type HistorySource
} from "../../stats/sidebar-perf-metrics.js";
import type { SidebarConversationHistoryDiagnostics, SidebarPerfRecorder } from "../../stats/sidebar-perf-types.js";
import { getConversationHistoryCacheFilePath } from "./conversation-history-cache.js";
import { isConversationEntryEvent } from "./conversation-validators.js";
import { openSessionManagerWithSizeGuard } from "./session-file-guard.js";
import {
  extractMessageErrorMessage,
  extractMessageImageAttachments,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  hasMessageErrorMessageField,
  isStrictContextOverflowMessage,
  normalizeProviderErrorMessage
} from "./message-utils.js";
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "../runtime-contracts.js";
import type {
  AgentDescriptor,
  AgentMessageEvent,
  AgentToolCallEvent,
  ChoiceRequestEvent,
  ConversationEntryEvent,
  ConversationLogEvent,
  ConversationMessageEvent
} from "../types.js";

const MAX_CONVERSATION_HISTORY = 2000;
const MAX_SAFE_JSON_BYTES = 32 * 1024;
const SAFE_JSON_TRUNCATED_SUFFIX = " [truncated]";
const CONVERSATION_ENTRY_TYPE = "swarm_conversation_entry";
const CONVERSATION_CACHE_META_TYPE = "swarm_conversation_cache_meta";
const CONVERSATION_CACHE_VERSION = 1;
const SESSION_HEADER_VERSION = 3;
const MANAGER_ERROR_CONTEXT_HINT = "Try compacting the conversation to free up context space.";
const MANAGER_ERROR_GENERIC_HINT = "Please retry. If this persists, check provider auth and rate limits.";
const WORKER_ERROR_CONTEXT_HINT = "The manager may need to compact the task context before retrying.";
const WORKER_ERROR_GENERIC_HINT = "The manager may need to retry after checking provider auth, quotas, or rate limits.";

type ConversationEventName =
  | "conversation_message"
  | "conversation_log"
  | "agent_message"
  | "agent_tool_call"
  | "conversation_reset"
  | "choice_request";

interface ConversationHistoryCacheMetadata {
  type: typeof CONVERSATION_CACHE_META_TYPE;
  version: typeof CONVERSATION_CACHE_VERSION;
  persistedEntryCount: number;
  cachedPersistedEntryCount: number;
  firstPersistedEntryKey: string | null;
  lastPersistedEntryKey: string | null;
}

interface LoadedConversationHistoryCache {
  entries: ConversationEntryEvent[];
  metadata: ConversationHistoryCacheMetadata | null;
}

interface LoadedConversationHistoryCacheResult {
  cacheState: "loaded" | "absent" | "cache_read_error";
  cachedHistory: LoadedConversationHistoryCache | null;
  cacheFileBytes?: number;
  cacheReadMs?: number;
  fsReadOps: number;
  fsReadBytes: number;
  detail?: string | null;
}

interface ValidatedConversationHistoryCacheResult {
  ok: boolean;
  entries?: ConversationEntryEvent[];
  cacheState?: Exclude<HistoryCacheState, "memory" | "hit" | "absent" | "cache_read_error" | "size_guard_skip">;
  persistedEntryCount: number;
  cachedEntryCount: number;
  sessionFileBytes?: number;
  sessionSummaryBytesScanned?: number;
  sessionSummaryReadMs?: number;
  fsReadOps: number;
  fsReadBytes: number;
  detail?: string | null;
}

interface QueuedConversationHistoryCacheSnapshot {
  sessionFile: string;
  history: ConversationEntryEvent[] | null;
  metadata: ConversationHistoryCacheMetadata | null;
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

interface ConversationHistoryWithDiagnostics {
  history: ConversationEntryEvent[];
  diagnostics: SidebarConversationHistoryDiagnostics;
}

interface ConversationProjectorDependencies {
  descriptors: Map<string, AgentDescriptor>;
  runtimes: Map<string, SwarmAgentRuntime>;
  conversationEntriesByAgentId: Map<string, ConversationEntryEvent[]>;
  now: () => string;
  emitServerEvent: (eventName: ConversationEventName, payload: ServerEvent) => void;
  logDebug: (message: string, details?: unknown) => void;
  perf?: SidebarPerfRecorder;
  getPinnedMessageIds?: (agentId: string) => ReadonlySet<string> | undefined;
}

export class ConversationProjector {
  private readonly lastSessionEntryIdBySessionFile = new Map<string, string>();
  private readonly persistedEntryCountBySessionFile = new Map<string, number>();
  private readonly loadedFromDisk = new Set<string>();
  private readonly pendingCacheWrites = new Map<string, Promise<void>>();
  private readonly queuedCacheSnapshots = new Map<string, QueuedConversationHistoryCacheSnapshot>();

  constructor(private readonly deps: ConversationProjectorDependencies) {}

  getConversationHistory(agentId: string): ConversationEntryEvent[] {
    return this.getConversationHistoryWithDiagnostics(agentId).history;
  }

  getConversationHistoryWithDiagnostics(agentId: string): ConversationHistoryWithDiagnostics {
    if (this.loadedFromDisk.has(agentId)) {
      const history = this.deps.conversationEntriesByAgentId.get(agentId) ?? [];
      const diagnostics = createConversationHistoryDiagnostics({
        cacheState: "memory",
        historySource: "memory",
        coldLoad: false
      });
      this.recordHistoryDiagnostics(agentId, diagnostics);
      return { history, diagnostics };
    }

    const descriptor = this.deps.descriptors.get(agentId);
    if (descriptor) {
      const result = this.loadConversationHistoryForDescriptorWithDiagnostics(descriptor);
      this.recordHistoryDiagnostics(agentId, result.diagnostics);
      return result;
    }

    const history = this.deps.conversationEntriesByAgentId.get(agentId) ?? [];
    const diagnostics = createConversationHistoryDiagnostics({
      cacheState: "memory",
      historySource: "memory",
      coldLoad: false,
      detail: "missing_descriptor"
    });
    this.recordHistoryDiagnostics(agentId, diagnostics);
    return { history, diagnostics };
  }

  setConversationMessagePinned(agentId: string, messageId: string, pinned: boolean): void {
    const history = this.deps.conversationEntriesByAgentId.get(agentId);
    if (!history) {
      return;
    }

    for (const entry of history) {
      if (entry.type !== "conversation_message" || entry.id !== messageId) {
        continue;
      }

      if (pinned) {
        entry.pinned = true;
      } else {
        delete entry.pinned;
      }
    }
  }

  resetConversationHistory(agentId: string, sessionFile?: string): void {
    this.deps.conversationEntriesByAgentId.set(agentId, []);
    this.loadedFromDisk.add(agentId);

    const resolvedSessionFile = sessionFile ?? this.deps.descriptors.get(agentId)?.sessionFile;
    if (!resolvedSessionFile) {
      return;
    }

    this.lastSessionEntryIdBySessionFile.delete(resolvedSessionFile);
    this.persistedEntryCountBySessionFile.delete(resolvedSessionFile);
    this.queueCacheSnapshotWrite(resolvedSessionFile, null);
  }

  deleteConversationHistory(agentId: string, sessionFile?: string): void {
    this.deps.conversationEntriesByAgentId.delete(agentId);
    this.loadedFromDisk.delete(agentId);

    const resolvedSessionFile = sessionFile ?? this.deps.descriptors.get(agentId)?.sessionFile;
    if (!resolvedSessionFile) {
      return;
    }

    this.lastSessionEntryIdBySessionFile.delete(resolvedSessionFile);
    this.persistedEntryCountBySessionFile.delete(resolvedSessionFile);
    this.queueCacheSnapshotWrite(resolvedSessionFile, null);
  }

  emitConversationMessage(event: ConversationMessageEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("conversation_message", event satisfies ServerEvent);
  }

  emitConversationLog(event: ConversationLogEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("conversation_log", event satisfies ServerEvent);
  }

  emitAgentMessage(event: AgentMessageEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("agent_message", event satisfies ServerEvent);
  }

  emitChoiceRequest(event: ChoiceRequestEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("choice_request", event satisfies ServerEvent);
  }

  emitAgentToolCall(event: AgentToolCallEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("agent_tool_call", event satisfies ServerEvent);
  }

  emitConversationReset(agentId: string, reason: "user_new_command" | "api_reset"): void {
    this.deps.emitServerEvent(
      "conversation_reset",
      {
        type: "conversation_reset",
        agentId,
        timestamp: this.deps.now(),
        reason
      } satisfies ServerEvent
    );
  }

  loadConversationHistoriesFromStore(): void {
    // Histories are lazy-loaded on first access per agent.
    this.deps.conversationEntriesByAgentId.clear();
    this.lastSessionEntryIdBySessionFile.clear();
    this.persistedEntryCountBySessionFile.clear();
    this.loadedFromDisk.clear();

    // Seed leaf ids so fallback appends preserve parentId chains even before
    // the first full history load.
    for (const descriptor of this.deps.descriptors.values()) {
      if (descriptor.status !== "idle" && descriptor.status !== "streaming") {
        continue;
      }

      this.hydrateLeafEntryId(descriptor);
    }
  }

  captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent): void {
    const descriptor = this.deps.descriptors.get(agentId);
    const timestamp = this.deps.now();
    if (descriptor) {
      const managerContextId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
      this.captureToolCallActivityFromRuntime(managerContextId, agentId, event, timestamp);
    }

    if (descriptor?.role === "manager") {
      this.captureManagerRuntimeErrorConversationEvent(agentId, event);
      return;
    }

    switch (event.type) {
      case "message_start": {
        const role = extractRole(event.message);
        if (role !== "user" && role !== "assistant" && role !== "system") {
          return;
        }

        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "message_start",
          role,
          text: extractMessageText(event.message) ?? "(non-text message)"
        });
        return;
      }

      case "message_end": {
        const role = extractRole(event.message);
        if (role !== "user" && role !== "assistant" && role !== "system") {
          return;
        }

        const extractedText = extractMessageText(event.message);
        const text = extractedText ?? "(non-text message)";
        const attachments = extractMessageImageAttachments(event.message);

        if ((role === "assistant" || role === "system") && (extractedText || attachments.length > 0)) {
          this.emitConversationMessage({
            type: "conversation_message",
            agentId,
            role,
            text: extractedText ?? "",
            attachments: attachments.length > 0 ? attachments : undefined,
            timestamp,
            source: "system"
          });
        }

        if (role === "assistant") {
          const stopReason = extractMessageStopReason(event.message);
          const hasStructuredErrorMessage = hasMessageErrorMessageField(event.message);
          if (stopReason === "error" || hasStructuredErrorMessage) {
            const normalizedErrorMessage = normalizeProviderErrorMessage(
              extractMessageErrorMessage(event.message) ?? extractedText
            );
            const isContextOverflow = isStrictContextOverflowMessage(normalizedErrorMessage);

            this.emitConversationMessage({
              type: "conversation_message",
              agentId,
              role: "system",
              text: buildWorkerErrorConversationText({
                errorMessage: normalizedErrorMessage,
                isContextOverflow
              }),
              timestamp,
              source: "system"
            });
          }
        }

        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "message_end",
          role,
          text
        });
        return;
      }

      case "tool_execution_start":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.args)
        });
        return;

      case "tool_execution_update":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_update",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.partialResult)
        });
        return;

      case "tool_execution_end":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_end",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.result),
          isError: event.isError
        });
        break;

      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        break;
    }
  }

  private emitConversationEntry(event: ConversationEntryEvent): void {
    const descriptor = this.deps.descriptors.get(event.agentId);
    const history =
      descriptor && !this.loadedFromDisk.has(event.agentId)
        ? this.loadConversationHistoryForDescriptor(descriptor)
        : (this.deps.conversationEntriesByAgentId.get(event.agentId) ?? []);

    history.push(event);
    trimConversationHistory(history);
    this.deps.conversationEntriesByAgentId.set(event.agentId, history);

    // Runtime logs are valuable for the live in-memory transcript and cache, but
    // they are high-volume JSONL noise during replay/fork/recovery. Forks may omit
    // prior conversation_log entries as a tradeoff to keep the canonical session file
    // focused on durable transcript/tool entries instead of transient runtime chatter.
    if (!shouldPersistConversationEntry(event)) {
      this.assignConversationMessageIdIfMissing(event);
      this.queueConversationHistoryCacheWrite(event.agentId, history);
      return;
    }

    const runtime = this.deps.runtimes.get(event.agentId);

    try {
      if (runtime) {
        const entryId = runtime.appendCustomEntry(CONVERSATION_ENTRY_TYPE, event);
        this.assignConversationMessageIdIfMissing(event, entryId);
        if (descriptor) {
          this.trackLastSessionEntryId(descriptor.sessionFile, entryId);
          this.incrementPersistedEntryCount(descriptor.sessionFile);
        }
        this.queueConversationHistoryCacheWrite(event.agentId, history);
        return;
      }

      if (!descriptor) {
        this.assignConversationMessageIdIfMissing(event);
        this.queueConversationHistoryCacheWrite(event.agentId, history);
        return;
      }

      const entryId = this.appendConversationEntryToSessionFile(descriptor, event);
      this.assignConversationMessageIdIfMissing(event, entryId);
      this.incrementPersistedEntryCount(descriptor.sessionFile);
      this.queueConversationHistoryCacheWrite(event.agentId, history);
    } catch (error) {
      this.deps.logDebug("history:save:error", {
        message: error instanceof Error ? error.message : String(error)
      });
      this.assignConversationMessageIdIfMissing(event);
      this.queueConversationHistoryCacheWrite(event.agentId, history);
    }
  }

  private appendConversationEntryToSessionFile(
    descriptor: AgentDescriptor,
    event: ConversationEntryEvent
  ): string {
    // Avoid SessionManager.open() here: opening re-reads the whole JSONL file,
    // which is unsafe for very large transcripts. Appending a well-formed JSONL
    // entry keeps this path O(1) with no full-file reads.
    this.ensureSessionFileHeader(descriptor);

    const parentId = this.lastSessionEntryIdBySessionFile.get(descriptor.sessionFile) ?? null;
    const entryId = randomUUID().slice(0, 8);

    this.assignConversationMessageIdIfMissing(event, entryId);

    appendFileSync(
      descriptor.sessionFile,
      `${JSON.stringify({
        type: "custom",
        customType: CONVERSATION_ENTRY_TYPE,
        data: event,
        id: entryId,
        parentId,
        timestamp: this.deps.now()
      })}\n`,
      "utf8"
    );

    this.trackLastSessionEntryId(descriptor.sessionFile, entryId);
    return entryId;
  }

  private ensureSessionFileHeader(descriptor: AgentDescriptor): void {
    if (hasValidSessionHeader(descriptor.sessionFile)) {
      return;
    }

    const headerLine = `${JSON.stringify({
      type: "session",
      version: SESSION_HEADER_VERSION,
      id: randomUUID(),
      timestamp: this.deps.now(),
      cwd: descriptor.cwd
    })}\n`;

    if (isMissingOrEmptySessionFile(descriptor.sessionFile)) {
      appendFileSync(descriptor.sessionFile, headerLine, "utf8");
      this.lastSessionEntryIdBySessionFile.delete(descriptor.sessionFile);
      return;
    }

    // Existing files with invalid headers cannot be reopened by SessionManager.
    // Replace with a fresh header so subsequent appends stay recoverable.
    writeFileSync(descriptor.sessionFile, headerLine, "utf8");
    this.lastSessionEntryIdBySessionFile.delete(descriptor.sessionFile);
  }

  private hydrateLeafEntryId(descriptor: AgentDescriptor): void {
    const sessionFile = descriptor.sessionFile;
    let fileDescriptor: number | undefined;

    try {
      const fileSize = statSync(sessionFile).size;
      if (fileSize <= 0) {
        this.lastSessionEntryIdBySessionFile.delete(sessionFile);
        return;
      }

      const tailBytes = 8192;
      const readLength = Math.min(fileSize, tailBytes);
      const readOffset = Math.max(0, fileSize - readLength);

      fileDescriptor = openSync(sessionFile, "r");
      const buffer = Buffer.alloc(readLength);
      const bytesRead = readSync(fileDescriptor, buffer, 0, readLength, readOffset);
      if (bytesRead <= 0) {
        this.lastSessionEntryIdBySessionFile.delete(sessionFile);
        return;
      }

      const tail = buffer.toString("utf8", 0, bytesRead);
      const lines = tail.split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        try {
          const entryId = extractSessionEntryId(JSON.parse(line));
          if (entryId) {
            this.trackLastSessionEntryId(sessionFile, entryId);
            return;
          }
        } catch {
          // read window may start/end mid-line; skip parse failures
        }
      }

      this.trackLastSessionEntryId(sessionFile, undefined);
    } catch (error) {
      if (isEnoentError(error)) {
        this.lastSessionEntryIdBySessionFile.delete(sessionFile);
        return;
      }

      this.deps.logDebug("history:hydrate_leaf:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      if (fileDescriptor !== undefined) {
        closeSync(fileDescriptor);
      }
    }
  }

  private loadConversationHistoryForDescriptor(descriptor: AgentDescriptor): ConversationEntryEvent[] {
    return this.loadConversationHistoryForDescriptorWithDiagnostics(descriptor).history;
  }

  private loadConversationHistoryForDescriptorWithDiagnostics(
    descriptor: AgentDescriptor
  ): ConversationHistoryWithDiagnostics {
    const existingInMemoryEntries = this.deps.conversationEntriesByAgentId.get(descriptor.agentId) ?? [];
    const cacheLoad = this.loadConversationHistoryFromCache(descriptor.sessionFile);

    if (cacheLoad.cachedHistory) {
      const validation = this.validateCachedConversationHistory(descriptor.sessionFile, cacheLoad.cachedHistory);
      if (validation.ok) {
        const validatedCachedEntries = validation.entries ?? [];
        trimConversationHistory(validatedCachedEntries);
        const mergedEntries = this.mergeDiskAndInMemoryEntries(validatedCachedEntries, existingInMemoryEntries);
        this.applyPinnedState(descriptor.agentId, mergedEntries);
        this.trackPersistedEntryCount(descriptor.sessionFile, cacheLoad.cachedHistory.metadata?.persistedEntryCount ?? 0);
        this.loadedFromDisk.add(descriptor.agentId);
        this.deps.conversationEntriesByAgentId.set(descriptor.agentId, mergedEntries);
        this.queueConversationHistoryCacheWrite(descriptor.agentId, mergedEntries);
        this.deps.logDebug("history:load:cache", {
          agentId: descriptor.agentId,
          messageCount: mergedEntries.length
        });
        return {
          history: mergedEntries,
          diagnostics: createConversationHistoryDiagnostics({
            cacheState: "hit",
            historySource: "cache_hit",
            coldLoad: true,
            cacheFileBytes: cacheLoad.cacheFileBytes,
            persistedEntryCount: validation.persistedEntryCount,
            cachedEntryCount: validation.cachedEntryCount,
            sessionFileBytes: validation.sessionFileBytes,
            sessionSummaryBytesScanned: validation.sessionSummaryBytesScanned,
            cacheReadMs: cacheLoad.cacheReadMs,
            sessionSummaryReadMs: validation.sessionSummaryReadMs,
            fsReadOps: cacheLoad.fsReadOps + validation.fsReadOps,
            fsReadBytes: cacheLoad.fsReadBytes + validation.fsReadBytes,
            detail: mergeDiagnosticDetails(cacheLoad.detail, validation.detail)
          })
        };
      }

      this.deps.logDebug("history:load:cache:stale", {
        agentId: descriptor.agentId,
        sessionFile: descriptor.sessionFile,
        reason: validation.cacheState
      });

      return this.loadConversationHistoryFromSessionFile(descriptor, existingInMemoryEntries, {
        cacheState: validation.cacheState ?? "cache_read_error",
        historySource: "cache_rebuild",
        cacheFileBytes: cacheLoad.cacheFileBytes,
        persistedEntryCount: validation.persistedEntryCount,
        cachedEntryCount: validation.cachedEntryCount,
        sessionFileBytes: validation.sessionFileBytes,
        sessionSummaryBytesScanned: validation.sessionSummaryBytesScanned,
        cacheReadMs: cacheLoad.cacheReadMs,
        sessionSummaryReadMs: validation.sessionSummaryReadMs,
        fsReadOps: cacheLoad.fsReadOps + validation.fsReadOps,
        fsReadBytes: cacheLoad.fsReadBytes + validation.fsReadBytes,
        detail: mergeDiagnosticDetails(cacheLoad.detail, validation.detail)
      });
    }

    return this.loadConversationHistoryFromSessionFile(descriptor, existingInMemoryEntries, {
      cacheState: cacheLoad.cacheState === "absent" ? "absent" : "cache_read_error",
      historySource: cacheLoad.cacheState === "absent" ? "full_parse" : "cache_rebuild",
      cacheFileBytes: cacheLoad.cacheFileBytes,
      cacheReadMs: cacheLoad.cacheReadMs,
      fsReadOps: cacheLoad.fsReadOps,
      fsReadBytes: cacheLoad.fsReadBytes,
      detail: cacheLoad.detail
    });
  }

  private loadConversationHistoryFromSessionFile(
    descriptor: AgentDescriptor,
    existingInMemoryEntries: ConversationEntryEvent[],
    diagnosticsSeed: Omit<SidebarConversationHistoryDiagnostics, "coldLoad">
  ): ConversationHistoryWithDiagnostics {
    const entriesForAgent: ConversationEntryEvent[] = [];
    let persistedEntryCount = 0;
    let lastSessionEntryId: string | undefined = this.lastSessionEntryIdBySessionFile.get(descriptor.sessionFile);
    const diagnostics = createConversationHistoryDiagnostics({
      ...diagnosticsSeed,
      coldLoad: true
    });

    try {
      const sessionManager = openSessionManagerWithSizeGuard(descriptor.sessionFile, {
        context: `history:load:${descriptor.agentId}`
      });

      if (!sessionManager) {
        diagnostics.cacheState = "size_guard_skip";
        diagnostics.historySource = "size_guard_skip";
        diagnostics.detail = mergeDiagnosticDetails(diagnostics.detail, "session_size_guard_skip");
        this.deps.logDebug("history:load:skipped", {
          agentId: descriptor.agentId,
          sessionFile: descriptor.sessionFile
        });
      } else {
        const entries = sessionManager.getEntries();
        lastSessionEntryId = extractSessionEntryId(entries.at(-1));

        for (const entry of entries) {
          if (entry.type !== "custom") {
            continue;
          }

          if (entry.customType !== CONVERSATION_ENTRY_TYPE) {
            continue;
          }
          if (!isConversationEntryEvent(entry.data)) {
            continue;
          }

          const hydratedEntry = this.backfillConversationMessageEntryId(entry.data, extractSessionEntryId(entry));
          entriesForAgent.push(hydratedEntry);
          if (shouldPersistConversationEntry(hydratedEntry)) {
            persistedEntryCount += 1;
          }
        }

        trimConversationHistory(entriesForAgent);

        this.deps.logDebug("history:load:ready", {
          agentId: descriptor.agentId,
          messageCount: entriesForAgent.length
        });
      }
    } catch (error) {
      diagnostics.cacheState = "replay_error";
      diagnostics.historySource = "replay_error";
      diagnostics.detail = mergeDiagnosticDetails(
        diagnostics.detail,
        error instanceof Error ? error.message : String(error)
      );
      this.deps.logDebug("history:load:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const mergedEntries = this.mergeDiskAndInMemoryEntries(entriesForAgent, existingInMemoryEntries);
    this.applyPinnedState(descriptor.agentId, mergedEntries);
    this.trackLastSessionEntryId(descriptor.sessionFile, lastSessionEntryId);
    this.trackPersistedEntryCount(descriptor.sessionFile, persistedEntryCount);
    this.loadedFromDisk.add(descriptor.agentId);
    this.deps.conversationEntriesByAgentId.set(descriptor.agentId, mergedEntries);
    this.queueConversationHistoryCacheWrite(descriptor.agentId, mergedEntries);
    diagnostics.persistedEntryCount = persistedEntryCount;
    return { history: mergedEntries, diagnostics };
  }

  private recordHistoryDiagnostics(agentId: string, diagnostics: SidebarConversationHistoryDiagnostics): void {
    this.deps.perf?.increment(SIDEBAR_HISTORY_CACHE_STATE_METRIC, {
      labels: {
        cacheState: diagnostics.cacheState,
        historySource: diagnostics.historySource
      },
      fields: {
        agentId,
        coldLoad: diagnostics.coldLoad,
        fsReadOps: diagnostics.fsReadOps,
        fsReadBytes: diagnostics.fsReadBytes,
        sessionFileBytes: diagnostics.sessionFileBytes,
        cacheFileBytes: diagnostics.cacheFileBytes,
        persistedEntryCount: diagnostics.persistedEntryCount,
        cachedEntryCount: diagnostics.cachedEntryCount,
        sessionSummaryBytesScanned: diagnostics.sessionSummaryBytesScanned,
        cacheReadMs: diagnostics.cacheReadMs,
        sessionSummaryReadMs: diagnostics.sessionSummaryReadMs,
        detail: diagnostics.detail ?? undefined
      }
    });
  }

  private applyPinnedState(agentId: string, entries: ConversationEntryEvent[]): void {
    const pinnedMessageIds = this.deps.getPinnedMessageIds?.(agentId);
    if (!pinnedMessageIds || pinnedMessageIds.size === 0) {
      for (const entry of entries) {
        if (entry.type === "conversation_message") {
          delete entry.pinned;
        }
      }
      return;
    }

    for (const entry of entries) {
      if (entry.type !== "conversation_message") {
        continue;
      }

      if (entry.id && pinnedMessageIds.has(entry.id)) {
        entry.pinned = true;
      } else {
        delete entry.pinned;
      }
    }
  }

  private loadConversationHistoryFromCache(sessionFile: string): LoadedConversationHistoryCacheResult {
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
          cacheState: "loaded",
          cachedHistory: {
            entries: [],
            metadata: null
          },
          cacheFileBytes,
          cacheReadMs: performance.now() - startedAtMs,
          fsReadOps: 1,
          fsReadBytes: cacheFileBytes
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

        if (isConversationEntryEvent(parsed)) {
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
      this.deps.logDebug("history:load:cache:error", {
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

  private validateCachedConversationHistory(
    sessionFile: string,
    cachedHistory: LoadedConversationHistoryCache
  ): ValidatedConversationHistoryCacheResult {
    const cacheSummary = summarizePersistedConversationEntries(cachedHistory.entries);
    const sessionSummaryResult = this.readPersistedConversationEntrySummary(sessionFile);
    const sessionSummary = sessionSummaryResult.summary;

    if (!cachedHistory.metadata) {
      if (cacheSummary.count === 0 && sessionSummary.count === 0) {
        return {
          ok: true,
          entries: cachedHistory.entries,
          persistedEntryCount: sessionSummary.count,
          cachedEntryCount: cacheSummary.count,
          sessionFileBytes: sessionSummaryResult.sessionFileBytes,
          sessionSummaryBytesScanned: sessionSummaryResult.sessionSummaryBytesScanned,
          sessionSummaryReadMs: sessionSummaryResult.sessionSummaryReadMs,
          fsReadOps: sessionSummaryResult.fsReadOps,
          fsReadBytes: sessionSummaryResult.fsReadBytes,
          detail: sessionSummaryResult.detail
        };
      }

      this.deps.logDebug("history:load:cache:validate:legacy_rebuild", {
        sessionFile,
        cachePersistedEntryCount: cacheSummary.count,
        sessionPersistedEntryCount: sessionSummary.count
      });
      return {
        ok: false,
        cacheState: "legacy_rebuild",
        persistedEntryCount: sessionSummary.count,
        cachedEntryCount: cacheSummary.count,
        sessionFileBytes: sessionSummaryResult.sessionFileBytes,
        sessionSummaryBytesScanned: sessionSummaryResult.sessionSummaryBytesScanned,
        sessionSummaryReadMs: sessionSummaryResult.sessionSummaryReadMs,
        fsReadOps: sessionSummaryResult.fsReadOps,
        fsReadBytes: sessionSummaryResult.fsReadBytes,
        detail: sessionSummaryResult.detail
      };
    }

    if (!doesConversationHistoryCacheMetadataMatchEntries(cachedHistory.metadata, cacheSummary)) {
      this.deps.logDebug("history:load:cache:validate:reject", {
        sessionFile,
        reason: "metadata_entries_mismatch"
      });
      return {
        ok: false,
        cacheState: "metadata_entries_mismatch",
        persistedEntryCount: sessionSummary.count,
        cachedEntryCount: cacheSummary.count,
        sessionFileBytes: sessionSummaryResult.sessionFileBytes,
        sessionSummaryBytesScanned: sessionSummaryResult.sessionSummaryBytesScanned,
        sessionSummaryReadMs: sessionSummaryResult.sessionSummaryReadMs,
        fsReadOps: sessionSummaryResult.fsReadOps,
        fsReadBytes: sessionSummaryResult.fsReadBytes,
        detail: sessionSummaryResult.detail
      };
    }

    if (sessionSummary.count === 0 && hasValidSessionHeader(sessionFile)) {
      return {
        ok: true,
        entries: cachedHistory.entries,
        persistedEntryCount: sessionSummary.count,
        cachedEntryCount: cacheSummary.count,
        sessionFileBytes: sessionSummaryResult.sessionFileBytes,
        sessionSummaryBytesScanned: sessionSummaryResult.sessionSummaryBytesScanned,
        sessionSummaryReadMs: sessionSummaryResult.sessionSummaryReadMs,
        fsReadOps: sessionSummaryResult.fsReadOps,
        fsReadBytes: sessionSummaryResult.fsReadBytes,
        detail: sessionSummaryResult.detail
      };
    }

    if (
      cachedHistory.entries.length < MAX_CONVERSATION_HISTORY &&
      cachedHistory.metadata.cachedPersistedEntryCount < cachedHistory.metadata.persistedEntryCount
    ) {
      this.deps.logDebug("history:load:cache:validate:reject", {
        sessionFile,
        reason: "cache_missing_persisted_prefix"
      });
      return {
        ok: false,
        cacheState: "cache_missing_persisted_prefix",
        persistedEntryCount: sessionSummary.count,
        cachedEntryCount: cacheSummary.count,
        sessionFileBytes: sessionSummaryResult.sessionFileBytes,
        sessionSummaryBytesScanned: sessionSummaryResult.sessionSummaryBytesScanned,
        sessionSummaryReadMs: sessionSummaryResult.sessionSummaryReadMs,
        fsReadOps: sessionSummaryResult.fsReadOps,
        fsReadBytes: sessionSummaryResult.fsReadBytes,
        detail: sessionSummaryResult.detail
      };
    }

    if (cachedHistory.metadata.persistedEntryCount !== sessionSummary.count) {
      this.deps.logDebug("history:load:cache:validate:reject", {
        sessionFile,
        reason: "persisted_entry_count_mismatch",
        expected: cachedHistory.metadata.persistedEntryCount,
        actual: sessionSummary.count
      });
      return {
        ok: false,
        cacheState: "persisted_entry_count_mismatch",
        persistedEntryCount: sessionSummary.count,
        cachedEntryCount: cacheSummary.count,
        sessionFileBytes: sessionSummaryResult.sessionFileBytes,
        sessionSummaryBytesScanned: sessionSummaryResult.sessionSummaryBytesScanned,
        sessionSummaryReadMs: sessionSummaryResult.sessionSummaryReadMs,
        fsReadOps: sessionSummaryResult.fsReadOps,
        fsReadBytes: sessionSummaryResult.fsReadBytes,
        detail: mergeDiagnosticDetails(
          sessionSummaryResult.detail,
          `expected=${cachedHistory.metadata.persistedEntryCount},actual=${sessionSummary.count}`
        )
      };
    }

    const sessionLastPersistedEntryKey = sessionSummary.last?.key ?? null;
    if (cachedHistory.metadata.lastPersistedEntryKey !== sessionLastPersistedEntryKey) {
      this.deps.logDebug("history:load:cache:validate:reject", {
        sessionFile,
        reason: "last_persisted_entry_mismatch"
      });
      return {
        ok: false,
        cacheState: "last_persisted_entry_mismatch",
        persistedEntryCount: sessionSummary.count,
        cachedEntryCount: cacheSummary.count,
        sessionFileBytes: sessionSummaryResult.sessionFileBytes,
        sessionSummaryBytesScanned: sessionSummaryResult.sessionSummaryBytesScanned,
        sessionSummaryReadMs: sessionSummaryResult.sessionSummaryReadMs,
        fsReadOps: sessionSummaryResult.fsReadOps,
        fsReadBytes: sessionSummaryResult.fsReadBytes,
        detail: sessionSummaryResult.detail
      };
    }

    return {
      ok: true,
      entries: cachedHistory.entries,
      persistedEntryCount: sessionSummary.count,
      cachedEntryCount: cacheSummary.count,
      sessionFileBytes: sessionSummaryResult.sessionFileBytes,
      sessionSummaryBytesScanned: sessionSummaryResult.sessionSummaryBytesScanned,
      sessionSummaryReadMs: sessionSummaryResult.sessionSummaryReadMs,
      fsReadOps: sessionSummaryResult.fsReadOps,
      fsReadBytes: sessionSummaryResult.fsReadBytes,
      detail: sessionSummaryResult.detail
    };
  }

  private readPersistedConversationEntrySummary(sessionFile: string): PersistedConversationEntrySummaryResult {
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

      this.deps.logDebug("history:load:cache:validate:error", {
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

  private queueConversationHistoryCacheWrite(agentId: string, history: ConversationEntryEvent[]): void {
    const descriptor = this.deps.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }

    const persistedEntryCount = this.persistedEntryCountBySessionFile.get(descriptor.sessionFile) ?? 0;
    const metadata = buildConversationHistoryCacheMetadata(history, persistedEntryCount);
    this.queueCacheSnapshotWrite(descriptor.sessionFile, history.slice(), metadata);
  }

  private queueCacheSnapshotWrite(
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
        this.deps.logDebug("history:cache:write:error", {
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
      const serializedHistory = `${[
        JSON.stringify(metadata ?? buildConversationHistoryCacheMetadata(history, 0)),
        ...history.map((entry) => JSON.stringify(entry))
      ].join("\n")}\n`;
      await writeFile(cacheFile, serializedHistory, "utf8");
    }
  }

  private mergeDiskAndInMemoryEntries(
    diskEntries: ConversationEntryEvent[],
    inMemoryEntries: ConversationEntryEvent[]
  ): ConversationEntryEvent[] {
    if (inMemoryEntries.length === 0) {
      return diskEntries;
    }

    const inMemoryEntryIdCounts = new Map<string, number>();
    // Non-message entries can be missing stable ids, so we dedupe with a serialized fingerprint.
    // This assumes those entry fields stay stable between in-memory capture and disk round-trip.
    const inMemoryEntryFingerprintCounts = new Map<string, number>();

    for (const inMemoryEntry of inMemoryEntries) {
      const entryId = extractConversationEntryEventId(inMemoryEntry);
      if (entryId) {
        inMemoryEntryIdCounts.set(entryId, (inMemoryEntryIdCounts.get(entryId) ?? 0) + 1);
        continue;
      }

      const fingerprint = safeJson(inMemoryEntry);
      inMemoryEntryFingerprintCounts.set(fingerprint, (inMemoryEntryFingerprintCounts.get(fingerprint) ?? 0) + 1);
    }

    const mergedEntries: ConversationEntryEvent[] = [];
    for (const diskEntry of diskEntries) {
      const entryId = extractConversationEntryEventId(diskEntry);
      if (entryId) {
        if (decrementCounter(inMemoryEntryIdCounts, entryId)) {
          continue;
        }

        mergedEntries.push(diskEntry);
        continue;
      }

      const fingerprint = safeJson(diskEntry);
      if (decrementCounter(inMemoryEntryFingerprintCounts, fingerprint)) {
        continue;
      }

      mergedEntries.push(diskEntry);
    }

    mergedEntries.push(...inMemoryEntries);
    trimConversationHistory(mergedEntries);
    return mergedEntries;
  }

  private assignConversationMessageIdIfMissing(event: ConversationEntryEvent, preferredId?: string): void {
    if (event.type !== "conversation_message") {
      return;
    }

    if (typeof event.id === "string" && event.id.trim().length > 0) {
      return;
    }

    event.id = preferredId && preferredId.trim().length > 0 ? preferredId : randomUUID().slice(0, 8);
  }

  private backfillConversationMessageEntryId(
    entry: ConversationEntryEvent,
    wrapperEntryId: string | undefined
  ): ConversationEntryEvent {
    if (entry.type !== "conversation_message") {
      return entry;
    }

    if (typeof entry.id === "string" && entry.id.trim().length > 0) {
      return entry;
    }

    if (typeof wrapperEntryId !== "string" || wrapperEntryId.trim().length === 0) {
      return entry;
    }

    return {
      ...entry,
      id: wrapperEntryId
    };
  }

  private trackLastSessionEntryId(sessionFile: string, entryId: string | undefined): void {
    if (typeof entryId !== "string" || entryId.trim().length === 0) {
      this.lastSessionEntryIdBySessionFile.delete(sessionFile);
      return;
    }

    this.lastSessionEntryIdBySessionFile.set(sessionFile, entryId);
  }

  private trackPersistedEntryCount(sessionFile: string, count: number): void {
    this.persistedEntryCountBySessionFile.set(sessionFile, Math.max(0, Math.trunc(count)));
  }

  private incrementPersistedEntryCount(sessionFile: string): void {
    this.trackPersistedEntryCount(sessionFile, (this.persistedEntryCountBySessionFile.get(sessionFile) ?? 0) + 1);
  }

  private captureManagerRuntimeErrorConversationEvent(agentId: string, event: RuntimeSessionEvent): void {
    if (event.type !== "message_end") {
      return;
    }

    const role = extractRole(event.message);
    if (role !== "assistant") {
      return;
    }

    const stopReason = extractMessageStopReason(event.message);
    const hasStructuredErrorMessage = hasMessageErrorMessageField(event.message);
    if (stopReason !== "error" && !hasStructuredErrorMessage) {
      return;
    }

    const messageText = extractMessageText(event.message);
    const normalizedErrorMessage = normalizeProviderErrorMessage(extractMessageErrorMessage(event.message) ?? messageText);
    const isContextOverflow = isStrictContextOverflowMessage(normalizedErrorMessage);

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: buildManagerErrorConversationText({
        errorMessage: normalizedErrorMessage,
        isContextOverflow
      }),
      timestamp: this.deps.now(),
      source: "system"
    });
  }

  private captureToolCallActivityFromRuntime(
    managerContextId: string,
    actorAgentId: string,
    event: RuntimeSessionEvent,
    timestamp: string
  ): void {
    switch (event.type) {
      case "tool_execution_start":
        this.emitAgentToolCall({
          type: "agent_tool_call",
          agentId: managerContextId,
          actorAgentId,
          timestamp,
          kind: "tool_execution_start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.args)
        });
        return;

      case "tool_execution_update":
        this.emitAgentToolCall({
          type: "agent_tool_call",
          agentId: managerContextId,
          actorAgentId,
          timestamp,
          kind: "tool_execution_update",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.partialResult)
        });
        return;

      case "tool_execution_end":
        this.emitAgentToolCall({
          type: "agent_tool_call",
          agentId: managerContextId,
          actorAgentId,
          timestamp,
          kind: "tool_execution_end",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.result),
          isError: event.isError
        });
        break;

      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_update":
      case "message_end":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        break;
    }
  }
}

function createConversationHistoryDiagnostics(
  options: Partial<SidebarConversationHistoryDiagnostics> & {
    cacheState: HistoryCacheState;
    historySource: HistorySource;
    coldLoad: boolean;
  }
): SidebarConversationHistoryDiagnostics {
  return {
    cacheState: options.cacheState,
    historySource: options.historySource,
    coldLoad: options.coldLoad,
    fsReadOps: options.fsReadOps ?? 0,
    fsReadBytes: options.fsReadBytes ?? 0,
    sessionFileBytes: options.sessionFileBytes,
    cacheFileBytes: options.cacheFileBytes,
    persistedEntryCount: options.persistedEntryCount,
    cachedEntryCount: options.cachedEntryCount,
    sessionSummaryBytesScanned: options.sessionSummaryBytesScanned,
    cacheReadMs: options.cacheReadMs,
    sessionSummaryReadMs: options.sessionSummaryReadMs,
    detail: options.detail ?? null
  };
}

function mergeDiagnosticDetails(...details: Array<string | null | undefined>): string | null {
  const normalized = details
    .flatMap((detail) => (typeof detail === "string" ? detail.split("; ") : []))
    .map((detail) => detail.trim())
    .filter((detail) => detail.length > 0);

  if (normalized.length === 0) {
    return null;
  }

  return Array.from(new Set(normalized)).join("; ");
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

function extractSessionEntryId(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || !("id" in entry)) {
    return undefined;
  }

  const entryId = (entry as { id?: unknown }).id;
  if (typeof entryId !== "string" || entryId.trim().length === 0) {
    return undefined;
  }

  return entryId;
}

type PersistedConversationEntryIdentity = {
  key: string;
};

function extractConversationEntryEventId(entry: ConversationEntryEvent): string | undefined {
  if (entry.type !== "conversation_message") {
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
    return { key: `conversation_message:${entryId}` };
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
  persistedEntryCount: number
): ConversationHistoryCacheMetadata {
  const summary = summarizePersistedConversationEntries(history);

  return {
    type: CONVERSATION_CACHE_META_TYPE,
    version: CONVERSATION_CACHE_VERSION,
    persistedEntryCount: Math.max(0, Math.trunc(persistedEntryCount)),
    cachedPersistedEntryCount: summary.count,
    firstPersistedEntryKey: summary.first?.key ?? null,
    lastPersistedEntryKey: summary.last?.key ?? null
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

  return {
    type: CONVERSATION_CACHE_META_TYPE,
    version: CONVERSATION_CACHE_VERSION,
    persistedEntryCount: Math.max(0, Math.trunc(persistedEntryCount)),
    cachedPersistedEntryCount: Math.max(0, Math.trunc(cachedPersistedEntryCount)),
    firstPersistedEntryKey,
    lastPersistedEntryKey
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

function decrementCounter(counter: Map<string, number>, key: string): boolean {
  const current = counter.get(key);
  if (!current) {
    return false;
  }

  if (current <= 1) {
    counter.delete(key);
  } else {
    counter.set(key, current - 1);
  }

  return true;
}

function buildManagerErrorConversationText(options: {
  errorMessage?: string;
  isContextOverflow: boolean;
}): string {
  if (options.isContextOverflow) {
    if (options.errorMessage) {
      return `⚠️ Manager reply failed because the prompt exceeded the model context window (${options.errorMessage}). ${MANAGER_ERROR_CONTEXT_HINT}`;
    }

    return `⚠️ Manager reply failed because the prompt exceeded the model context window. ${MANAGER_ERROR_CONTEXT_HINT}`;
  }

  if (options.errorMessage) {
    return `⚠️ Manager reply failed: ${formatManagerErrorMessage(options.errorMessage)} ${MANAGER_ERROR_GENERIC_HINT}`;
  }

  return `⚠️ Manager reply failed. ${MANAGER_ERROR_GENERIC_HINT}`;
}

function buildWorkerErrorConversationText(options: {
  errorMessage?: string;
  isContextOverflow: boolean;
}): string {
  if (options.isContextOverflow) {
    if (options.errorMessage) {
      return `⚠️ Worker reply failed because the prompt exceeded the model context window (${options.errorMessage}). ${WORKER_ERROR_CONTEXT_HINT}`;
    }

    return `⚠️ Worker reply failed because the prompt exceeded the model context window. ${WORKER_ERROR_CONTEXT_HINT}`;
  }

  if (options.errorMessage) {
    return `⚠️ Worker reply failed: ${formatManagerErrorMessage(options.errorMessage)} ${WORKER_ERROR_GENERIC_HINT}`;
  }

  return `⚠️ Worker reply failed. ${WORKER_ERROR_GENERIC_HINT}`;
}

function formatManagerErrorMessage(errorMessage: string): string {
  const trimmed = errorMessage.trim();
  if (trimmed.length === 0) {
    return "Unknown error.";
  }

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function shouldPersistConversationEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type === "conversation_log") {
    return false;
  }

  if (entry.type === "agent_tool_call") {
    return entry.kind !== "tool_execution_update";
  }

  return true;
}

function hasValidSessionHeader(sessionFile: string): boolean {
  if (!existsSync(sessionFile)) {
    return false;
  }

  let fileDescriptor: number | undefined;

  try {
    fileDescriptor = openSync(sessionFile, "r");
    const buffer = Buffer.alloc(512);
    const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return false;
    }

    const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0]?.trim();
    if (!firstLine) {
      return false;
    }

    const header = JSON.parse(firstLine) as { type?: string; id?: unknown };
    return header.type === "session" && typeof header.id === "string" && header.id.trim().length > 0;
  } catch {
    return false;
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
  }
}

function isMissingOrEmptySessionFile(sessionFile: string): boolean {
  try {
    return statSync(sessionFile).size === 0;
  } catch (error) {
    if (isEnoentError(error)) {
      return true;
    }

    throw error;
  }
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isPreservedWebTranscriptEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type !== "conversation_message") {
    return false;
  }

  if (entry.source === "project_agent_input") {
    return true;
  }

  if (entry.source !== "user_input" && entry.source !== "speak_to_user") {
    return false;
  }

  return (entry.sourceContext?.channel ?? "web") === "web";
}

function trimConversationHistory(entries: ConversationEntryEvent[]): void {
  const overflow = entries.length - MAX_CONVERSATION_HISTORY;
  if (overflow <= 0) {
    return;
  }

  const removableIndexes: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (removableIndexes.length >= overflow) {
      break;
    }

    if (!isPreservedWebTranscriptEntry(entries[index])) {
      removableIndexes.push(index);
    }
  }

  if (removableIndexes.length === 0) {
    return;
  }

  for (let index = removableIndexes.length - 1; index >= 0; index -= 1) {
    entries.splice(removableIndexes[index], 1);
  }
}
