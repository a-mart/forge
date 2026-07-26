import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import {
  CONVERSATION_ENTRY_TYPE,
  ConversationTimeline,
} from "./conversation-timeline.js";
import {
  collectKnownWorkerIds,
  createBuilderTimelineVisibilityPredicate,
  isWorkerQuickLookActivity,
  type BuilderTimelineChannelView,
  type ModelCacheObservationEvent,
  type PlanSummaryEvent,
  type ServerEvent,
} from "@forge/protocol";
import type { SidebarConversationHistoryDiagnostics, SidebarPerfRecorder } from "../../stats/sidebar-perf-types.js";
import {
  HistoryCacheStore,
  type ValidatedConversationHistoryCanonicalProof
} from "./history-cache-store.js";
import {
  MAX_CONVERSATION_HISTORY,
  shouldPersistConversationEntry,
  trimConversationHistory
} from "./history-policy.js";
import {
  appendMessageRoutingReceipt,
  type MessageRoutingReceiptRecord
} from "./message-routing-receipts.js";
import { applyPinOverlay, setPinnedFlagInMemory } from "./pin-overlay.js";
import {
  createConversationHistoryDiagnostics,
  mergeDiagnosticDetails,
  recordConversationHistoryDiagnostics,
  sumOptionalNumbers
} from "./conversation-diagnostics.js";
import { RuntimeConversationEventMapper, safeJson } from "./runtime-conversation-event-mapper.js";
import { buildActivitySummary } from "./activity-summary.js";
import {
  createConversationHistorySeamCursor,
  DEFAULT_CONVERSATION_PAGE_ITEMS,
  MAX_CONVERSATION_PAGE_BYTES,
  MAX_CONVERSATION_PAGE_ITEMS,
  readConversationHistoryPage,
  type ConversationHistoryPageResult,
} from "./conversation-page-reader.js";
import { projectConversationEntryForBuilderWire } from "./conversation-wire-projection.js";
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "../runtime-contracts.js";
import type {
  ActivitySummaryEvent,
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
  | "activity_summary"
  | "agent_message"
  | "agent_tool_call"
  | "conversation_reset"
  | "choice_request"
  | "plan_summary"
  | "model_cache_observation";

interface ConversationHistoryWithDiagnostics {
  history: ConversationEntryEvent[];
  diagnostics: SidebarConversationHistoryDiagnostics;
}

const MEMORY_PAGE_CURSOR_VERSION = 1;

interface MemoryPageCursor {
  version: typeof MEMORY_PAGE_CURSOR_VERSION;
  source: "memory";
  agentId: string;
  beforeTimelineEntryId: string;
  view: BuilderTimelineChannelView;
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

function resolveManagerContextId(descriptor: AgentDescriptor | undefined, fallbackAgentId: string): string {
  if (!descriptor) {
    return fallbackAgentId;
  }

  return descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
}

function resolveHistoryAgentId(
  event: ConversationEntryEvent,
  historyAgentId?: string,
): string {
  const normalizedHistoryAgentId = historyAgentId?.trim();
  if (normalizedHistoryAgentId && normalizedHistoryAgentId.length > 0) {
    return normalizedHistoryAgentId;
  }

  return event.agentId;
}

export class ConversationProjector {
  private readonly timeline: ConversationTimeline;
  private readonly historyCacheStore: HistoryCacheStore;
  private readonly runtimeConversationEventMapper = new RuntimeConversationEventMapper();
  private readonly loadedFromDisk = new Set<string>();
  private readonly nextTimelineSequenceBySource = new Map<string, number>();
  private readonly canonicalPrefixMayExistByAgentId = new Set<string>();

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

  getConversationHistoryPage(
    agentId: string,
    options?: { cursor?: string; limit?: number; view?: BuilderTimelineChannelView },
  ): ConversationHistoryPageResult {
    const finishPage = (result: ConversationHistoryPageResult): ConversationHistoryPageResult => {
      this.applyPinnedState(agentId, result.messages);
      return result;
    };
    const descriptor = this.deps.descriptors.get(agentId);
    if (!descriptor) {
      return {
        messages: [],
        page: {
          hasOlder: false,
          completeness: "complete",
          source: "memory",
          sourceRevision: "missing_agent",
          pageBytes: 0,
          scanBytes: 0,
        },
      };
    }

    const view = options?.view ?? "all";
    const memoryCursor = decodeMemoryPageCursor(options?.cursor);
    if (memoryCursor) {
      if (memoryCursor.agentId !== agentId || memoryCursor.view !== view) {
        return sourceChangedMemoryPage("wrong_agent");
      }

      const history = this.deps.conversationEntriesByAgentId.get(agentId) ?? [];
      const visibility = buildBuilderPageVisibility(
        descriptor,
        view,
        [...this.deps.descriptors.values()],
        history,
      );
      const boundaryIndex = history.findIndex(
        (entry) => entry.timelineEntryId === memoryCursor.beforeTimelineEntryId,
      );
      if (boundaryIndex >= 0) {
        return finishPage(buildMemoryHistoryPage({
          agentId,
          sessionFile: descriptor.sessionFile,
          history,
          endExclusive: boundaryIndex,
          limit: options?.limit,
          view,
          ...visibility,
          canonicalPrefixMayExist: this.canonicalPrefixMayExistByAgentId.has(agentId),
        }));
      }

      const seamCursor = createConversationHistorySeamCursor(
        descriptor.sessionFile,
        undefined,
        view,
      );
      if (!seamCursor) return sourceChangedMemoryPage("missing_canonical_source");
      return finishPage(readConversationHistoryPage({
        sessionFile: descriptor.sessionFile,
        agentId,
        cursor: seamCursor,
        limit: options?.limit,
        projectionKey: view,
        isVisible: buildCanonicalMemorySeamVisibility(history, visibility.isVisible),
        countsTowardLimit: visibility.countsTowardLimit,
      }));
    }

    if (!options?.cursor && this.deps.runtimes.has(agentId)) {
      const history = this.getConversationHistory(agentId);
      if (history.length > 0) {
        const visibility = buildBuilderPageVisibility(
          descriptor,
          view,
          [...this.deps.descriptors.values()],
          history,
        );
        return finishPage(buildMemoryHistoryPage({
          agentId,
          sessionFile: descriptor.sessionFile,
          history,
          endExclusive: history.length,
          limit: options?.limit,
          view,
          ...visibility,
          canonicalPrefixMayExist: this.canonicalPrefixMayExistByAgentId.has(agentId),
        }));
      }
    }

    const history = this.deps.conversationEntriesByAgentId.get(agentId) ?? [];
    const visibility = buildBuilderPageVisibility(
      descriptor,
      view,
      [...this.deps.descriptors.values()],
      history,
    );
    return finishPage(readConversationHistoryPage({
      sessionFile: descriptor.sessionFile,
      agentId,
      cursor: options?.cursor,
      limit: options?.limit,
      projectionKey: view,
      isVisible: this.deps.runtimes.has(agentId)
        ? buildCanonicalMemorySeamVisibility(
            history,
            visibility.isVisible,
          )
        : visibility.isVisible,
      countsTowardLimit: visibility.countsTowardLimit,
    }));
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
    this.canonicalPrefixMayExistByAgentId.delete(agentId);

    const resolvedSessionFile = sessionFile ?? this.deps.descriptors.get(agentId)?.sessionFile;
    if (!resolvedSessionFile) {
      return;
    }

    this.timeline.resetSession(resolvedSessionFile);
    this.nextTimelineSequenceBySource.delete(resolvedSessionFile);
    this.historyCacheStore.resetSession(resolvedSessionFile);
    this.historyCacheStore.queueCacheSnapshotWrite(resolvedSessionFile, null);
  }

  deleteConversationHistory(agentId: string, sessionFile?: string): void {
    this.deps.conversationEntriesByAgentId.delete(agentId);
    this.loadedFromDisk.delete(agentId);
    this.canonicalPrefixMayExistByAgentId.delete(agentId);

    const resolvedSessionFile = sessionFile ?? this.deps.descriptors.get(agentId)?.sessionFile;
    if (!resolvedSessionFile) {
      return;
    }

    this.timeline.resetSession(resolvedSessionFile);
    this.nextTimelineSequenceBySource.delete(resolvedSessionFile);
    this.historyCacheStore.resetSession(resolvedSessionFile);
    this.historyCacheStore.queueCacheSnapshotWrite(resolvedSessionFile, null);
  }

  emitConversationMessage(event: ConversationMessageEvent, options?: { routingReceipt?: MessageRoutingReceiptRecord }): void {
    this.emitConversationEntry(event, options);
    this.deps.emitServerEvent("conversation_message", event satisfies ServerEvent);
  }

  emitConversationLog(event: ConversationLogEvent): void {
    this.emitConversationEntry(event);
    const activitySummary = buildActivitySummary(event);
    if (activitySummary) {
      // Persist the safe terminal representation before any corresponding raw
      // live event is observable. A crash can then leave extra raw detail, but
      // never a completed activity with no replayable Builder row.
      this.emitConversationEntry(activitySummary);
    }
    this.deps.emitServerEvent("conversation_log", event satisfies ServerEvent);
    if (activitySummary) {
      this.deps.emitServerEvent("activity_summary", activitySummary satisfies ServerEvent);
    }
  }

  emitActivitySummary(event: ActivitySummaryEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("activity_summary", event satisfies ServerEvent);
  }

  emitAgentMessage(event: AgentMessageEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("agent_message", event satisfies ServerEvent);
  }

  emitChoiceRequest(event: ChoiceRequestEvent, options?: { historyAgentId?: string }): void {
    this.emitConversationEntry(event, options);
    this.deps.emitServerEvent("choice_request", event satisfies ServerEvent);
  }

  emitPlanSummary(event: PlanSummaryEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("plan_summary", event satisfies ServerEvent);
  }

  emitModelCacheObservation(event: ModelCacheObservationEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("model_cache_observation", event satisfies ServerEvent);
  }

  emitAgentToolCall(event: AgentToolCallEvent): void {
    this.emitConversationEntry(event);
    // A worker's agent_tool_call is projected into its manager's timeline in
    // addition to the worker-local conversation_log. Only summarize the
    // self-owned event here so each timeline gets one terminal summary.
    if (event.agentId === event.actorAgentId) {
      const activitySummary = buildActivitySummary(event);
      if (activitySummary) {
        this.emitConversationEntry(activitySummary);
        this.deps.emitServerEvent("agent_tool_call", event satisfies ServerEvent);
        this.deps.emitServerEvent("activity_summary", activitySummary satisfies ServerEvent);
        return;
      }
    }
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
    this.canonicalPrefixMayExistByAgentId.clear();

    // Seed leaf ids so fallback appends preserve parentId chains even before
    // the first full history load.
    for (const descriptor of this.deps.descriptors.values()) {
      if (descriptor.status !== "idle" && descriptor.status !== "streaming") {
        continue;
      }

      this.timeline.hydrateLeafEntryId(descriptor);
    }
  }

  captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent, options?: { turnId?: string }): void {
    const projections = this.runtimeConversationEventMapper.mapRuntimeEvent({
      agentId,
      event,
      timestamp: this.deps.now(),
      descriptor: this.deps.descriptors.get(agentId),
      turnId: options?.turnId
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

  private emitConversationEntry(
    event: ConversationEntryEvent,
    options?: { historyAgentId?: string; routingReceipt?: MessageRoutingReceiptRecord },
  ): void {
    const historyAgentId = resolveHistoryAgentId(event, options?.historyAgentId);
    const descriptor = this.deps.descriptors.get(historyAgentId);
    this.assignConversationTimelineMetadata(event, descriptor?.sessionFile);
    const history =
      descriptor && !this.loadedFromDisk.has(historyAgentId)
        ? this.loadConversationHistoryForDescriptor(descriptor)
        : (this.deps.conversationEntriesByAgentId.get(historyAgentId) ?? []);

    history.push(event);
    trimConversationHistory(
      history,
      resolveManagerContextId(descriptor, historyAgentId),
      { normalizePlanSummaries: event.type === "plan_summary" }
    );
    this.deps.conversationEntriesByAgentId.set(historyAgentId, history);
    if (options?.routingReceipt && descriptor?.sessionFile) {
      this.appendRoutingReceiptBestEffort(descriptor.sessionFile, options.routingReceipt);
    }

    // Runtime logs are valuable for the live in-memory transcript and cache, but
    // they are high-volume JSONL noise during replay/fork/recovery. Forks may omit
    // prior conversation_log entries as a tradeoff to keep the canonical session file
    // focused on durable transcript/tool entries instead of transient runtime chatter.
    if (!shouldPersistConversationEntry(event)) {
      this.assignConversationMessageIdIfMissing(event);
      this.queueConversationHistoryCacheWrite(historyAgentId, history);
      return;
    }

    const runtime = this.deps.runtimes.get(historyAgentId);

    try {
      if (runtime) {
        const entryId = runtime.appendCustomEntry(CONVERSATION_ENTRY_TYPE, event);
        this.assignConversationMessageIdIfMissing(event, entryId);
        if (descriptor) {
          this.timeline.trackLastSessionEntryId(descriptor.sessionFile, entryId);
          this.historyCacheStore.incrementPersistedEntryCount(descriptor.sessionFile);
        }
        this.queueConversationHistoryCacheWrite(historyAgentId, history);
        return;
      }

      if (!descriptor) {
        this.assignConversationMessageIdIfMissing(event);
        this.queueConversationHistoryCacheWrite(historyAgentId, history);
        return;
      }

      const { entryId } = this.timeline.appendConversationEntry(descriptor, event);
      this.assignConversationMessageIdIfMissing(event, entryId);
      this.historyCacheStore.incrementPersistedEntryCount(descriptor.sessionFile);
      this.queueConversationHistoryCacheWrite(historyAgentId, history);
    } catch (error) {
      this.deps.logDebug("history:save:error", {
        message: error instanceof Error ? error.message : String(error)
      });
      this.assignConversationMessageIdIfMissing(event);
      this.queueConversationHistoryCacheWrite(historyAgentId, history);
    }
  }

  private loadConversationHistoryForDescriptor(descriptor: AgentDescriptor): ConversationEntryEvent[] {
    return this.loadConversationHistoryForDescriptorWithDiagnostics(descriptor).history;
  }

  private appendRoutingReceiptBestEffort(sessionFile: string, receipt: MessageRoutingReceiptRecord): void {
    try {
      appendMessageRoutingReceipt({ sessionFile, record: receipt });
    } catch (error) {
      this.deps.logDebug("message_routing:receipt:error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
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
        if (!hasCompleteTimelineMetadata(validatedCachedEntries)) {
          this.deps.logDebug("history:load:cache:stale", {
            agentId: descriptor.agentId,
            sessionFile: descriptor.sessionFile,
            reason: "timeline_metadata_missing",
          });
          return this.loadConversationHistoryFromSessionFile(descriptor, existingInMemoryEntries, {
            cacheState: "timeline_metadata_missing",
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
            detail: mergeDiagnosticDetails(validation.detail, "timeline_metadata_missing"),
            fastPathUsed: validation.fastPathUsed,
          });
        }
        trimConversationHistory(
          validatedCachedEntries,
          resolveManagerContextId(descriptor, descriptor.agentId)
        );
        const mergedEntries = this.mergeDiskAndInMemoryEntries(
          validatedCachedEntries,
          existingInMemoryEntries,
          resolveManagerContextId(descriptor, descriptor.agentId)
        );
        this.applyPinnedState(descriptor.agentId, mergedEntries);
        this.historyCacheStore.trackPersistedEntryCount(descriptor.sessionFile, validation.persistedEntryCount);
        this.loadedFromDisk.add(descriptor.agentId);
        this.deps.conversationEntriesByAgentId.set(descriptor.agentId, mergedEntries);
        if (validation.canonicalPrefixMayExist || validation.persistedEntryCount > validation.cachedEntryCount) {
          this.canonicalPrefixMayExistByAgentId.add(descriptor.agentId);
        } else {
          this.canonicalPrefixMayExistByAgentId.delete(descriptor.agentId);
        }
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
    let scannedPersistedEntryCount = 0;
    this.timeline.hydrateLeafEntryId(descriptor);
    const diagnostics = createConversationHistoryDiagnostics({
      ...diagnosticsSeed,
      coldLoad: true
    });
    let canonicalPrefixMayExist = false;

    try {
      let cursor: string | undefined;
      let scannedBytes = 0;
      let readOps = 0;
      const maxColdScanBytes = 16 * 1024 * 1024;

      do {
        const page = readConversationHistoryPage({
          sessionFile: descriptor.sessionFile,
          cursor,
          limit: 500,
          preferCanonical: true,
          projectForWire: false,
        });
        readOps += 1;
        scannedBytes += page.page.scanBytes;
        scannedPersistedEntryCount += page.messages.filter(shouldPersistConversationEntry).length;
        entriesForAgent.unshift(...page.messages);
        trimConversationHistory(entriesForAgent, resolveManagerContextId(descriptor, descriptor.agentId));
        cursor = page.page.nextCursor;
        if (page.page.completeness === "source_changed") {
          canonicalPrefixMayExist = true;
          diagnostics.detail = mergeDiagnosticDetails(diagnostics.detail, "canonical_changed_during_tail_read");
          break;
        }
      } while (
        cursor &&
        scannedBytes < maxColdScanBytes
      );

      if (cursor) {
        canonicalPrefixMayExist = true;
        diagnostics.detail = mergeDiagnosticDetails(diagnostics.detail, "canonical_tail_scan_limited");
      }
      diagnostics.fsReadOps += readOps;
      diagnostics.fsReadBytes += scannedBytes;
      trimConversationHistory(entriesForAgent, resolveManagerContextId(descriptor, descriptor.agentId));

      this.deps.logDebug("history:load:ready", {
        agentId: descriptor.agentId,
        messageCount: entriesForAgent.length,
        scannedBytes,
      });
    } catch (error) {
      canonicalPrefixMayExist = true;
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

    const mergedEntries = this.mergeDiskAndInMemoryEntries(
      entriesForAgent,
      existingInMemoryEntries,
      resolveManagerContextId(descriptor, descriptor.agentId)
    );
    this.applyPinnedState(descriptor.agentId, mergedEntries);
    const persistedEntryCount = diagnosticsSeed.persistedEntryCount ?? scannedPersistedEntryCount;
    this.historyCacheStore.trackPersistedEntryCount(descriptor.sessionFile, persistedEntryCount);
    this.loadedFromDisk.add(descriptor.agentId);
    this.deps.conversationEntriesByAgentId.set(descriptor.agentId, mergedEntries);
    if (canonicalPrefixMayExist) {
      this.canonicalPrefixMayExistByAgentId.add(descriptor.agentId);
    } else {
      this.canonicalPrefixMayExistByAgentId.delete(descriptor.agentId);
    }
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
      validatedCanonicalProof?.canonicalStat ?? this.historyCacheStore.readSessionFileCanonicalStat(descriptor.sessionFile),
      this.canonicalPrefixMayExistByAgentId.has(agentId)
    );
    if (validatedCanonicalProof) {
      metadata.lastPersistedEntryKey = validatedCanonicalProof.lastPersistedEntryKey;
    }
    this.historyCacheStore.queueCacheSnapshotWrite(descriptor.sessionFile, history.slice(), metadata);
  }

  private mergeDiskAndInMemoryEntries(
    diskEntries: ConversationEntryEvent[],
    inMemoryEntries: ConversationEntryEvent[],
    managerId: string
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
    trimConversationHistory(mergedEntries, managerId);
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

  private assignConversationTimelineMetadata(
    event: ConversationEntryEvent,
    sessionFile: string | undefined,
  ): void {
    event.timelineEntryId ??= randomUUID();
    if (event.timelineSequence !== undefined) return;

    const sourceKey = sessionFile ?? `memory:${event.agentId}`;
    let persistedSize = 0;
    if (sessionFile) {
      try {
        persistedSize = statSync(sessionFile).size;
      } catch {
        // A new Pi session can legitimately defer creating its file.
      }
    }

    const sequence = Math.max(persistedSize, this.nextTimelineSequenceBySource.get(sourceKey) ?? 0);
    event.timelineSequence = sequence;
    this.nextTimelineSequenceBySource.set(sourceKey, sequence + 1);
  }

}

function buildMemoryHistoryPage(options: {
  agentId: string;
  sessionFile: string;
  history: readonly ConversationEntryEvent[];
  endExclusive: number;
  limit?: number;
  view: BuilderTimelineChannelView;
  isVisible?: (entry: ConversationEntryEvent) => boolean;
  countsTowardLimit?: (entry: ConversationEntryEvent) => boolean;
  canonicalPrefixMayExist: boolean;
}): ConversationHistoryPageResult {
  const limit = normalizeMemoryPageLimit(options.limit);
  const messages: ConversationEntryEvent[] = [];
  const activitySummaryIds = new Set<string>();
  const supplementalMessages = new Set<ConversationEntryEvent>();
  const maxSupplementalItems = options.countsTowardLimit
    ? Math.min(limit, Math.floor(MAX_CONVERSATION_PAGE_ITEMS / 2))
    : 0;
  let countedMessages = 0;
  let supplementalItems = 0;
  let pageBytes = 0;
  let startIndex = options.endExclusive;

  for (let index = options.endExclusive - 1; index >= 0 && countedMessages < limit; index -= 1) {
    const projected = projectConversationEntryForBuilderWire(options.history[index]);
    if (options.isVisible && !options.isVisible(projected)) {
      startIndex = index;
      continue;
    }
    if (projected.type === "activity_summary" && activitySummaryIds.has(projected.itemId)) {
      startIndex = index;
      continue;
    }
    const countsTowardLimit = !options.countsTowardLimit || options.countsTowardLimit(projected);
    if (
      !countsTowardLimit &&
      (supplementalItems >= maxSupplementalItems || messages.length >= MAX_CONVERSATION_PAGE_ITEMS)
    ) {
      startIndex = index;
      continue;
    }
    const entryBytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
    if (countsTowardLimit) {
      while (
        messages.length > 0 &&
        (messages.length >= MAX_CONVERSATION_PAGE_ITEMS ||
          pageBytes + entryBytes > MAX_CONVERSATION_PAGE_BYTES)
      ) {
        const supplementalIndex = findLastSupplementalIndex(messages, supplementalMessages);
        if (supplementalIndex < 0) break;
        const removed = messages.splice(supplementalIndex, 1)[0]!;
        supplementalMessages.delete(removed);
        supplementalItems -= 1;
        pageBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
      }
      if (
        messages.length >= MAX_CONVERSATION_PAGE_ITEMS ||
        (messages.length > 0 && pageBytes + entryBytes > MAX_CONVERSATION_PAGE_BYTES)
      ) break;
      countedMessages += 1;
    } else {
      if (pageBytes + entryBytes > MAX_CONVERSATION_PAGE_BYTES) {
        startIndex = index;
        continue;
      }
      supplementalMessages.add(projected);
      supplementalItems += 1;
    }
    if (projected.type === "activity_summary") activitySummaryIds.add(projected.itemId);
    messages.push(projected);
    pageBytes += entryBytes;
    startIndex = index;
  }

  messages.reverse();
  const earliest = options.history[startIndex];
  const earliestTimelineEntryId = earliest?.timelineEntryId;
  const memoryCursor = startIndex > 0 && earliestTimelineEntryId
    ? encodeMemoryPageCursor({
        version: MEMORY_PAGE_CURSOR_VERSION,
        source: "memory",
        agentId: options.agentId,
        beforeTimelineEntryId: earliestTimelineEntryId,
        view: options.view,
      })
    : undefined;
  const canonicalSeamCursor =
    !memoryCursor &&
    (options.history.length >= MAX_CONVERSATION_HISTORY || options.canonicalPrefixMayExist) &&
    earliestTimelineEntryId
    ? createConversationHistorySeamCursor(options.sessionFile, undefined, options.view)
    : undefined;
  const nextCursor = memoryCursor ?? canonicalSeamCursor;

  return {
    messages,
    page: {
      ...(nextCursor ? { nextCursor } : {}),
      hasOlder: Boolean(nextCursor),
      completeness: "complete",
      source: "memory",
      sourceRevision: earliestTimelineEntryId ? `memory:${earliestTimelineEntryId}` : "memory:empty",
      pageBytes,
      scanBytes: 0,
    },
  };
}

function findLastSupplementalIndex(
  messages: readonly ConversationEntryEvent[],
  supplementalMessages: ReadonlySet<ConversationEntryEvent>,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (supplementalMessages.has(messages[index])) return index;
  }
  return -1;
}

function buildCanonicalMemorySeamVisibility(
  history: readonly ConversationEntryEvent[],
  isVisible: ((entry: ConversationEntryEvent) => boolean) | undefined,
): (entry: ConversationEntryEvent) => boolean {
  const projectedMemoryIds = new Set(
    history
      .map((entry) => projectConversationEntryForBuilderWire(entry).timelineEntryId)
      .filter((entryId): entryId is string => typeof entryId === "string" && entryId.length > 0),
  );

  return (entry) =>
    (!entry.timelineEntryId || !projectedMemoryIds.has(entry.timelineEntryId)) &&
    (!isVisible || isVisible(entry));
}

function buildBuilderPageVisibility(
  descriptor: AgentDescriptor,
  view: BuilderTimelineChannelView,
  agents: readonly AgentDescriptor[],
  history: readonly ConversationEntryEvent[],
): {
  isVisible?: (entry: ConversationEntryEvent) => boolean;
  countsTowardLimit?: (entry: ConversationEntryEvent) => boolean;
} {
  // Web rules do not depend on legacy manager-alias inference. Worker All is
  // intentionally unfiltered. Cold manager All preserves unfiltered wire
  // inclusion, while still treating known worker quick-look rows as
  // supplemental to the requested canonical row count.
  if (view === "all" && descriptor.role !== "manager") return {};
  const knownWorkerIds = collectKnownWorkerIds(agents, descriptor.agentId);
  if (view === "all" && history.length === 0) {
    return {
      countsTowardLimit: (entry) =>
        !isWorkerQuickLookActivity(entry, descriptor.agentId, knownWorkerIds),
    };
  }
  const isVisibleInTimeline = createBuilderTimelineVisibilityPredicate({
    activeAgentId: descriptor.agentId,
    activeAgentRole: descriptor.role,
    channelView: view,
    agents,
    history,
  });
  if (descriptor.role !== "manager") return { isVisible: isVisibleInTimeline };

  const isWorkerQuickLook = (entry: ConversationEntryEvent) =>
    isWorkerQuickLookActivity(entry, descriptor.agentId, knownWorkerIds);
  return {
    isVisible: (entry) => isVisibleInTimeline(entry) || isWorkerQuickLook(entry),
    // Worker quick-look hydration shares the wire page for compatibility, but
    // it must not consume the manager transcript's requested row count. The
    // page builders separately cap these supplemental rows by item/byte budget.
    countsTowardLimit: view === "all"
      ? (entry) => !isWorkerQuickLook(entry)
      : isVisibleInTimeline,
  };
}

function hasCompleteTimelineMetadata(history: readonly ConversationEntryEvent[]): boolean {
  return history.every((entry) =>
    typeof entry.timelineEntryId === "string" &&
    entry.timelineEntryId.trim().length > 0 &&
    Number.isSafeInteger(entry.timelineSequence) &&
    entry.timelineSequence! >= 0);
}

function normalizeMemoryPageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_CONVERSATION_PAGE_ITEMS;
  return Math.max(1, Math.min(MAX_CONVERSATION_PAGE_ITEMS, Math.floor(limit!)));
}

function encodeMemoryPageCursor(cursor: MemoryPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeMemoryPageCursor(value: string | undefined): MemoryPageCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<MemoryPageCursor>;
    if (parsed.version !== MEMORY_PAGE_CURSOR_VERSION || parsed.source !== "memory") return undefined;
    if (typeof parsed.agentId !== "string" || parsed.agentId.trim().length === 0) return undefined;
    if (parsed.view !== "web" && parsed.view !== "all") return undefined;
    if (
      typeof parsed.beforeTimelineEntryId !== "string" ||
      parsed.beforeTimelineEntryId.trim().length === 0 ||
      parsed.beforeTimelineEntryId.length > 256
    ) return undefined;
    return parsed as MemoryPageCursor;
  } catch {
    return undefined;
  }
}

function sourceChangedMemoryPage(detail: string): ConversationHistoryPageResult {
  return {
    messages: [],
    page: {
      hasOlder: true,
      completeness: "source_changed",
      source: "memory",
      sourceRevision: `memory:${detail}`,
      pageBytes: 0,
      scanBytes: 0,
    },
  };
}

function extractConversationEntryStableDedupeKey(entry: ConversationEntryEvent): string | undefined {
  if (
    entry.type !== "conversation_message" &&
    entry.type !== "plan_summary" &&
    entry.type !== "model_cache_observation"
  ) {
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
