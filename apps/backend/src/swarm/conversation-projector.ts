import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ServerEvent } from "@forge/protocol";
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
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "./runtime-types.js";
import type {
  AgentDescriptor,
  AgentMessageEvent,
  AgentToolCallEvent,
  ConversationEntryEvent,
  ConversationLogEvent,
  ConversationMessageEvent
} from "./types.js";

const MAX_CONVERSATION_HISTORY = 2000;
const MAX_SAFE_JSON_BYTES = 32 * 1024;
const SAFE_JSON_TRUNCATED_SUFFIX = " [truncated]";
const CONVERSATION_ENTRY_TYPE = "swarm_conversation_entry";
const SESSION_HEADER_VERSION = 3;
const MANAGER_ERROR_CONTEXT_HINT = "Try compacting the conversation to free up context space.";
const MANAGER_ERROR_GENERIC_HINT = "Please retry. If this persists, check provider auth and rate limits.";

type ConversationEventName =
  | "conversation_message"
  | "conversation_log"
  | "agent_message"
  | "agent_tool_call"
  | "conversation_reset";

interface ConversationProjectorDependencies {
  descriptors: Map<string, AgentDescriptor>;
  runtimes: Map<string, SwarmAgentRuntime>;
  conversationEntriesByAgentId: Map<string, ConversationEntryEvent[]>;
  now: () => string;
  emitServerEvent: (eventName: ConversationEventName, payload: ServerEvent) => void;
  logDebug: (message: string, details?: unknown) => void;
}

export class ConversationProjector {
  private readonly lastSessionEntryIdBySessionFile = new Map<string, string>();
  private readonly loadedFromDisk = new Set<string>();
  private readonly pendingCacheWrites = new Map<string, Promise<void>>();
  private readonly queuedCacheSnapshots = new Map<string, ConversationEntryEvent[] | null>();

  constructor(private readonly deps: ConversationProjectorDependencies) {}

  getConversationHistory(agentId: string): ConversationEntryEvent[] {
    if (!this.loadedFromDisk.has(agentId)) {
      const descriptor = this.deps.descriptors.get(agentId);
      if (descriptor) {
        this.loadConversationHistoryForDescriptor(descriptor);
      }
    }

    const history = this.deps.conversationEntriesByAgentId.get(agentId) ?? [];
    return history;
  }

  resetConversationHistory(agentId: string, sessionFile?: string): void {
    this.deps.conversationEntriesByAgentId.set(agentId, []);
    this.loadedFromDisk.add(agentId);

    const resolvedSessionFile = sessionFile ?? this.deps.descriptors.get(agentId)?.sessionFile;
    if (!resolvedSessionFile) {
      return;
    }

    this.lastSessionEntryIdBySessionFile.delete(resolvedSessionFile);
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
        return;

      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
    }
  }

  private emitConversationEntry(event: ConversationEntryEvent): void {
    const history = this.deps.conversationEntriesByAgentId.get(event.agentId) ?? [];
    history.push(event);
    trimConversationHistory(history);
    this.deps.conversationEntriesByAgentId.set(event.agentId, history);
    this.queueConversationHistoryCacheWrite(event.agentId, history);

    // Runtime logs are valuable for the live in-memory transcript and cache, but
    // they are high-volume JSONL noise during replay/fork/recovery. Forks may omit
    // prior conversation_log entries as a tradeoff to keep the canonical session file
    // focused on durable transcript/tool entries instead of transient runtime chatter.
    if (!shouldPersistConversationEntry(event)) {
      this.assignConversationMessageIdIfMissing(event);
      return;
    }

    const descriptor = this.deps.descriptors.get(event.agentId);
    const runtime = this.deps.runtimes.get(event.agentId);

    try {
      if (runtime) {
        const entryId = runtime.appendCustomEntry(CONVERSATION_ENTRY_TYPE, event);
        this.assignConversationMessageIdIfMissing(event, entryId);
        if (descriptor) {
          this.trackLastSessionEntryId(descriptor.sessionFile, entryId);
        }
        return;
      }

      if (!descriptor) {
        this.assignConversationMessageIdIfMissing(event);
        return;
      }

      const entryId = this.appendConversationEntryToSessionFile(descriptor, event);
      this.assignConversationMessageIdIfMissing(event, entryId);
    } catch (error) {
      this.deps.logDebug("history:save:error", {
        message: error instanceof Error ? error.message : String(error)
      });
      this.assignConversationMessageIdIfMissing(event);
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
    const existingInMemoryEntries = this.deps.conversationEntriesByAgentId.get(descriptor.agentId) ?? [];

    const cachedEntries = this.loadConversationHistoryFromCache(descriptor.sessionFile);
    if (cachedEntries) {
      const validatedCachedEntries = this.validateCachedConversationHistory(descriptor.sessionFile, cachedEntries);
      if (validatedCachedEntries) {
        trimConversationHistory(validatedCachedEntries);
        const mergedEntries = this.mergeDiskAndInMemoryEntries(validatedCachedEntries, existingInMemoryEntries);
        this.loadedFromDisk.add(descriptor.agentId);
        this.deps.conversationEntriesByAgentId.set(descriptor.agentId, mergedEntries);
        this.queueConversationHistoryCacheWrite(descriptor.agentId, mergedEntries);
        this.deps.logDebug("history:load:cache", {
          agentId: descriptor.agentId,
          messageCount: mergedEntries.length
        });
        return mergedEntries;
      }

      this.deps.logDebug("history:load:cache:stale", {
        agentId: descriptor.agentId,
        sessionFile: descriptor.sessionFile
      });
    }

    const entriesForAgent: ConversationEntryEvent[] = [];
    let lastSessionEntryId: string | undefined = this.lastSessionEntryIdBySessionFile.get(descriptor.sessionFile);

    try {
      const sessionManager = openSessionManagerWithSizeGuard(descriptor.sessionFile, {
        context: `history:load:${descriptor.agentId}`
      });

      if (!sessionManager) {
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

          entriesForAgent.push(this.backfillConversationMessageEntryId(entry.data, extractSessionEntryId(entry)));
        }

        trimConversationHistory(entriesForAgent);

        this.deps.logDebug("history:load:ready", {
          agentId: descriptor.agentId,
          messageCount: entriesForAgent.length
        });
      }
    } catch (error) {
      this.deps.logDebug("history:load:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const mergedEntries = this.mergeDiskAndInMemoryEntries(entriesForAgent, existingInMemoryEntries);
    this.trackLastSessionEntryId(descriptor.sessionFile, lastSessionEntryId);
    this.loadedFromDisk.add(descriptor.agentId);
    this.deps.conversationEntriesByAgentId.set(descriptor.agentId, mergedEntries);
    this.queueConversationHistoryCacheWrite(descriptor.agentId, mergedEntries);
    return mergedEntries;
  }

  private loadConversationHistoryFromCache(sessionFile: string): ConversationEntryEvent[] | null {
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    if (!existsSync(cacheFile)) {
      return null;
    }

    try {
      const raw = readFileSync(cacheFile, "utf8");
      if (raw.trim().length === 0) {
        return [];
      }

      const entries: ConversationEntryEvent[] = [];
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

        if (isConversationEntryEvent(parsed)) {
          entries.push(parsed);
        }
      }

      if (entries.length === 0 && raw.trim().length > 0) {
        return null;
      }

      return entries;
    } catch (error) {
      this.deps.logDebug("history:load:cache:error", {
        cacheFile,
        message: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private validateCachedConversationHistory(
    sessionFile: string,
    cachedEntries: ConversationEntryEvent[]
  ): ConversationEntryEvent[] | null {
    const cachedIdentity = extractPersistedConversationEntryIdentity(cachedEntries.at(-1));
    const lastPersistedCachedEntry =
      cachedIdentity ?? this.findLastPersistedConversationEntryIdentityInCache(cachedEntries);
    const lastPersistedSessionEntry = this.readLastPersistedConversationEntryIdentity(sessionFile);

    if (!lastPersistedCachedEntry && !lastPersistedSessionEntry) {
      return cachedEntries;
    }

    if (!lastPersistedSessionEntry) {
      return lastPersistedCachedEntry && hasValidSessionHeader(sessionFile) ? cachedEntries : null;
    }

    if (!lastPersistedCachedEntry) {
      return null;
    }

    return lastPersistedCachedEntry.key === lastPersistedSessionEntry.key ? cachedEntries : null;
  }

  private findLastPersistedConversationEntryIdentityInCache(
    cachedEntries: ConversationEntryEvent[]
  ): PersistedConversationEntryIdentity | null {
    for (let index = cachedEntries.length - 1; index >= 0; index -= 1) {
      const identity = extractPersistedConversationEntryIdentity(cachedEntries[index]);
      if (identity) {
        return identity;
      }
    }

    return null;
  }

  private readLastPersistedConversationEntryIdentity(sessionFile: string): PersistedConversationEntryIdentity | null {
    let fileDescriptor: number | undefined;

    try {
      const fileSize = statSync(sessionFile).size;
      if (fileSize <= 0) {
        return null;
      }

      const chunkSize = 8192;
      let position = fileSize;
      let remainder = "";

      fileDescriptor = openSync(sessionFile, "r");

      while (position > 0) {
        const readOffset = Math.max(0, position - chunkSize);
        const readLength = position - readOffset;
        const buffer = Buffer.alloc(readLength);
        const bytesRead = readSync(fileDescriptor, buffer, 0, readLength, readOffset);
        if (bytesRead <= 0) {
          break;
        }

        const chunk = buffer.toString("utf8", 0, bytesRead);
        const combined = `${chunk}${remainder}`;
        const lines = combined.split("\n");
        remainder = readOffset > 0 ? (lines.shift() ?? "") : "";

        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const identity = parsePersistedConversationEntryIdentity(lines[index]);
          if (identity) {
            return identity;
          }
        }

        position = readOffset;
      }

      return parsePersistedConversationEntryIdentity(remainder);
    } catch (error) {
      if (isEnoentError(error)) {
        return null;
      }

      this.deps.logDebug("history:load:cache:validate:error", {
        sessionFile,
        message: error instanceof Error ? error.message : String(error)
      });
      return null;
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

    this.queueCacheSnapshotWrite(descriptor.sessionFile, history.slice());
  }

  private queueCacheSnapshotWrite(sessionFile: string, history: ConversationEntryEvent[] | null): void {
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    this.queuedCacheSnapshots.set(cacheFile, history);

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
        if (this.queuedCacheSnapshots.has(cacheFile)) {
          this.queueCacheSnapshotWrite(sessionFile, this.queuedCacheSnapshots.get(cacheFile) ?? null);
        }
      });

    this.pendingCacheWrites.set(cacheFile, writePromise);
  }

  private async flushQueuedCacheSnapshot(cacheFile: string): Promise<void> {
    while (this.queuedCacheSnapshots.has(cacheFile)) {
      const history = this.queuedCacheSnapshots.get(cacheFile) ?? null;
      this.queuedCacheSnapshots.delete(cacheFile);

      if (history === null) {
        await rm(cacheFile, { force: true });
        continue;
      }

      await mkdir(dirname(cacheFile), { recursive: true });
      const serializedHistory =
        history.length === 0 ? "" : `${history.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
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
        return;

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
        return;
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
    return `⚠️ Manager reply failed: ${options.errorMessage}. ${MANAGER_ERROR_GENERIC_HINT}`;
  }

  return `⚠️ Manager reply failed. ${MANAGER_ERROR_GENERIC_HINT}`;
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
