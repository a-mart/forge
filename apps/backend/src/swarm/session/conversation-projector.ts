import { randomUUID } from "node:crypto";
import {
  CONVERSATION_ENTRY_TYPE,
  ConversationTimeline,
  extractSessionEntryId
} from "./conversation-timeline.js";
import type { ServerEvent, WorkPlanCreatedEvent } from "@forge/protocol";
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
  createConversationHistoryDiagnostics,
  mergeDiagnosticDetails,
  recordConversationHistoryDiagnostics,
  sumOptionalNumbers
} from "./conversation-diagnostics.js";
import { RuntimeConversationEventMapper, safeJson } from "./runtime-conversation-event-mapper.js";
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

type ConversationEventName =
  | "conversation_message"
  | "conversation_log"
  | "agent_message"
  | "agent_tool_call"
  | "conversation_reset"
  | "choice_request"
  | "work_plan_created";

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
  private readonly runtimeConversationEventMapper = new RuntimeConversationEventMapper();
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

  emitWorkPlanCreated(event: WorkPlanCreatedEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("work_plan_created", event satisfies ServerEvent);
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
    const projections = this.runtimeConversationEventMapper.mapRuntimeEvent({
      agentId,
      event,
      timestamp: this.deps.now(),
      descriptor: this.deps.descriptors.get(agentId)
    });

    for (const projection of projections) {
      switch (projection.type) {
        case "conversation_message":
          this.emitConversationMessage(projection);
          break;
        case "conversation_log":
          this.emitConversationLog(projection);
          break;
        case "agent_tool_call":
          this.emitAgentToolCall(projection);
          break;
      }
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
    recordConversationHistoryDiagnostics(this.deps.perf, agentId, diagnostics);
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

    const inMemoryEntryStableKeyCounts = new Map<string, number>();
    // Entries without stable keys are deduped with a serialized fingerprint.
    // This assumes those entry fields stay stable between in-memory capture and disk round-trip.
    const inMemoryEntryFingerprintCounts = new Map<string, number>();

    for (const inMemoryEntry of inMemoryEntries) {
      const stableKey = extractConversationEntryStableDedupeKey(inMemoryEntry);
      if (stableKey) {
        inMemoryEntryStableKeyCounts.set(stableKey, (inMemoryEntryStableKeyCounts.get(stableKey) ?? 0) + 1);
        continue;
      }

      const fingerprint = safeJson(inMemoryEntry);
      inMemoryEntryFingerprintCounts.set(fingerprint, (inMemoryEntryFingerprintCounts.get(fingerprint) ?? 0) + 1);
    }

    const mergedEntries: ConversationEntryEvent[] = [];
    for (const diskEntry of diskEntries) {
      const stableKey = extractConversationEntryStableDedupeKey(diskEntry);
      if (stableKey) {
        if (decrementCounter(inMemoryEntryStableKeyCounts, stableKey)) {
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
}

function extractConversationEntryStableDedupeKey(entry: ConversationEntryEvent): string | undefined {
  if (entry.type !== "conversation_message" && entry.type !== "work_plan_created") {
    return undefined;
  }

  if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
    return undefined;
  }

  return `${entry.type}:${entry.id}`;
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
