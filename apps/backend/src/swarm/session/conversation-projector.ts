import { randomUUID } from "node:crypto";
import {
  CONVERSATION_ENTRY_TYPE,
  ConversationTimeline,
  extractSessionEntryId
} from "./conversation-timeline.js";
import type { ServerEvent } from "@forge/protocol";
import {
  SIDEBAR_HISTORY_CACHE_STATE_METRIC,
  type HistoryCacheState,
  type HistorySource
} from "../../stats/sidebar-perf-metrics.js";
import type { SidebarConversationHistoryDiagnostics, SidebarPerfRecorder } from "../../stats/sidebar-perf-types.js";
import {
  HistoryCacheStore,
  type ValidatedConversationHistoryCanonicalProof
} from "./history-cache-store.js";
import {
  shouldPersistConversationEntry,
  trimConversationHistory
} from "./history-policy.js";
import { applyPinOverlay, setPinnedFlagInMemory } from "./pin-overlay.js";
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

const MAX_SAFE_JSON_BYTES = 32 * 1024;
const SAFE_JSON_TRUNCATED_SUFFIX = " [truncated]";
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
  private readonly timeline: ConversationTimeline;
  private readonly historyCacheStore: HistoryCacheStore;
  private readonly loadedFromDisk = new Set<string>();

  constructor(private readonly deps: ConversationProjectorDependencies) {
    this.timeline = new ConversationTimeline({
      now: deps.now,
      logDebug: deps.logDebug
    });
    this.historyCacheStore = new HistoryCacheStore({
      logDebug: deps.logDebug,
      readSessionFileCanonicalStat: (sessionFile) => this.readSessionFileCanonicalStat(sessionFile),
      readPersistedConversationEntrySummary: (sessionFile) => this.readPersistedConversationEntrySummary(sessionFile)
    });
  }

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

    setPinnedFlagInMemory(history, messageId, pinned);
  }

  resetConversationHistory(agentId: string, sessionFile?: string): void {
    this.deps.conversationEntriesByAgentId.set(agentId, []);
    this.loadedFromDisk.add(agentId);

    const resolvedSessionFile = sessionFile ?? this.deps.descriptors.get(agentId)?.sessionFile;
    if (!resolvedSessionFile) {
      return;
    }

    this.timeline.resetSession(resolvedSessionFile);
    this.historyCacheStore.resetSession(resolvedSessionFile);
    this.historyCacheStore.queueCacheSnapshotWrite(resolvedSessionFile, null);
  }

  deleteConversationHistory(agentId: string, sessionFile?: string): void {
    this.deps.conversationEntriesByAgentId.delete(agentId);
    this.loadedFromDisk.delete(agentId);

    const resolvedSessionFile = sessionFile ?? this.deps.descriptors.get(agentId)?.sessionFile;
    if (!resolvedSessionFile) {
      return;
    }

    this.timeline.resetSession(resolvedSessionFile);
    this.historyCacheStore.resetSession(resolvedSessionFile);
    this.historyCacheStore.queueCacheSnapshotWrite(resolvedSessionFile, null);
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
    this.timeline.clear();
    this.historyCacheStore.clear();
    this.loadedFromDisk.clear();

    // Seed leaf ids so fallback appends preserve parentId chains even before
    // the first full history load.
    for (const descriptor of this.deps.descriptors.values()) {
      if (descriptor.status !== "idle" && descriptor.status !== "streaming") {
        continue;
      }

      this.timeline.hydrateLeafEntryId(descriptor);
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
          this.timeline.trackLastSessionEntryId(descriptor.sessionFile, entryId);
          this.historyCacheStore.incrementPersistedEntryCount(descriptor.sessionFile);
        }
        this.queueConversationHistoryCacheWrite(event.agentId, history);
        return;
      }

      if (!descriptor) {
        this.assignConversationMessageIdIfMissing(event);
        this.queueConversationHistoryCacheWrite(event.agentId, history);
        return;
      }

      const { entryId } = this.timeline.appendConversationEntry(descriptor, event);
      this.assignConversationMessageIdIfMissing(event, entryId);
      this.historyCacheStore.incrementPersistedEntryCount(descriptor.sessionFile);
      this.queueConversationHistoryCacheWrite(event.agentId, history);
    } catch (error) {
      this.deps.logDebug("history:save:error", {
        message: error instanceof Error ? error.message : String(error)
      });
      this.assignConversationMessageIdIfMissing(event);
      this.queueConversationHistoryCacheWrite(event.agentId, history);
    }
  }

  private loadConversationHistoryForDescriptor(descriptor: AgentDescriptor): ConversationEntryEvent[] {
    return this.loadConversationHistoryForDescriptorWithDiagnostics(descriptor).history;
  }

  private loadConversationHistoryForDescriptorWithDiagnostics(
    descriptor: AgentDescriptor
  ): ConversationHistoryWithDiagnostics {
    const existingInMemoryEntries = this.deps.conversationEntriesByAgentId.get(descriptor.agentId) ?? [];
    const cacheHeaderLoad = this.historyCacheStore.loadConversationHistoryCacheHeader(descriptor.sessionFile);

    if (cacheHeaderLoad.metadata) {
      const validation = this.historyCacheStore.validateCachedConversationHistory(descriptor.sessionFile, cacheHeaderLoad.metadata);
      const totalCacheReadMs = sumOptionalNumbers(cacheHeaderLoad.cacheReadMs, validation.cacheReadMs);

      if (validation.ok) {
        const validatedCachedEntries = validation.entries ?? [];
        trimConversationHistory(validatedCachedEntries);
        const mergedEntries = this.mergeDiskAndInMemoryEntries(validatedCachedEntries, existingInMemoryEntries);
        this.applyPinnedState(descriptor.agentId, mergedEntries);
        this.historyCacheStore.trackPersistedEntryCount(descriptor.sessionFile, validation.persistedEntryCount);
        this.loadedFromDisk.add(descriptor.agentId);
        this.deps.conversationEntriesByAgentId.set(descriptor.agentId, mergedEntries);
        if (validation.rewriteCache) {
          this.queueConversationHistoryCacheWrite(
            descriptor.agentId,
            mergedEntries,
            validation.validatedCanonicalProof
          );
        }
        this.deps.logDebug("history:load:cache", {
          agentId: descriptor.agentId,
          messageCount: mergedEntries.length,
          fastPathUsed: validation.fastPathUsed
        });
        return {
          history: mergedEntries,
          diagnostics: createConversationHistoryDiagnostics({
            cacheState: "hit",
            historySource: "cache_hit",
            coldLoad: true,
            cacheFileBytes: cacheHeaderLoad.cacheFileBytes,
            persistedEntryCount: validation.persistedEntryCount,
            cachedEntryCount: validation.cachedEntryCount,
            sessionFileBytes: validation.sessionFileBytes,
            sessionSummaryBytesScanned: validation.sessionSummaryBytesScanned,
            cacheReadMs: totalCacheReadMs,
            sessionSummaryReadMs: validation.sessionSummaryReadMs,
            fsReadOps: cacheHeaderLoad.fsReadOps + validation.fsReadOps,
            fsReadBytes: cacheHeaderLoad.fsReadBytes + validation.fsReadBytes,
            detail: mergeDiagnosticDetails(cacheHeaderLoad.detail, validation.detail),
            fastPathUsed: validation.fastPathUsed
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
        cacheFileBytes: cacheHeaderLoad.cacheFileBytes,
        persistedEntryCount: validation.persistedEntryCount,
        cachedEntryCount: validation.cachedEntryCount,
        sessionFileBytes: validation.sessionFileBytes,
        sessionSummaryBytesScanned: validation.sessionSummaryBytesScanned,
        cacheReadMs: totalCacheReadMs,
        sessionSummaryReadMs: validation.sessionSummaryReadMs,
        fsReadOps: cacheHeaderLoad.fsReadOps + validation.fsReadOps,
        fsReadBytes: cacheHeaderLoad.fsReadBytes + validation.fsReadBytes,
        detail: mergeDiagnosticDetails(cacheHeaderLoad.detail, validation.detail),
        fastPathUsed: validation.fastPathUsed
      });
    }

    return this.loadConversationHistoryFromSessionFile(descriptor, existingInMemoryEntries, {
      cacheState:
        cacheHeaderLoad.cacheState === "absent"
          ? "absent"
          : cacheHeaderLoad.cacheState === "legacy_rebuild"
            ? "legacy_rebuild"
            : "cache_read_error",
      historySource: cacheHeaderLoad.cacheState === "absent" ? "full_parse" : "cache_rebuild",
      cacheFileBytes: cacheHeaderLoad.cacheFileBytes,
      cacheReadMs: cacheHeaderLoad.cacheReadMs,
      fsReadOps: cacheHeaderLoad.fsReadOps,
      fsReadBytes: cacheHeaderLoad.fsReadBytes,
      detail: cacheHeaderLoad.detail,
      fastPathUsed: false
    });
  }

  private loadConversationHistoryFromSessionFile(
    descriptor: AgentDescriptor,
    existingInMemoryEntries: ConversationEntryEvent[],
    diagnosticsSeed: Omit<SidebarConversationHistoryDiagnostics, "coldLoad">
  ): ConversationHistoryWithDiagnostics {
    const entriesForAgent: ConversationEntryEvent[] = [];
    let persistedEntryCount = 0;
    let lastSessionEntryId: string | undefined = this.timeline.getLastSessionEntryId(descriptor.sessionFile);
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
    this.timeline.trackLastSessionEntryId(descriptor.sessionFile, lastSessionEntryId);
    this.historyCacheStore.trackPersistedEntryCount(descriptor.sessionFile, persistedEntryCount);
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
        detail: diagnostics.detail ?? undefined,
        fastPathUsed: diagnostics.fastPathUsed ?? undefined
      }
    });
  }

  private applyPinnedState(agentId: string, entries: ConversationEntryEvent[]): void {
    applyPinOverlay(entries, this.deps.getPinnedMessageIds?.(agentId));
  }

  private readSessionFileCanonicalStat(sessionFile: string) {
    return this.historyCacheStore.readSessionFileCanonicalStat(sessionFile);
  }

  private readPersistedConversationEntrySummary(sessionFile: string) {
    return this.historyCacheStore.readPersistedConversationEntrySummary(sessionFile);
  }

  private queueConversationHistoryCacheWrite(
    agentId: string,
    history: ConversationEntryEvent[],
    validatedCanonicalProof?: ValidatedConversationHistoryCanonicalProof
  ): void {
    const descriptor = this.deps.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }

    const persistedEntryCount =
      validatedCanonicalProof?.persistedEntryCount ??
      this.historyCacheStore.getPersistedEntryCount(descriptor.sessionFile) ??
      0;
    const metadata = this.historyCacheStore.buildMetadata(
      history,
      persistedEntryCount,
      validatedCanonicalProof?.canonicalStat ?? this.historyCacheStore.readSessionFileCanonicalStat(descriptor.sessionFile)
    );
    if (validatedCanonicalProof) {
      metadata.lastPersistedEntryKey = validatedCanonicalProof.lastPersistedEntryKey;
    }
    this.historyCacheStore.queueCacheSnapshotWrite(descriptor.sessionFile, history.slice(), metadata);
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
    fastPathUsed: options.fastPathUsed ?? false,
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

function sumOptionalNumbers(...values: Array<number | undefined>): number | undefined {
  let total = 0;
  let foundValue = false;

  for (const value of values) {
    if (typeof value !== "number") {
      continue;
    }

    total += value;
    foundValue = true;
  }

  return foundValue ? total : undefined;
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
  if (entry.type !== "conversation_message") {
    return undefined;
  }

  if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
    return undefined;
  }

  return entry.id;
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
