import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import type { ServerEvent } from "@middleman/protocol";
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
  constructor(private readonly deps: ConversationProjectorDependencies) {}

  getConversationHistory(agentId: string): ConversationEntryEvent[] {
    let history = this.deps.conversationEntriesByAgentId.get(agentId);
    if (!history) {
      const descriptor = this.deps.descriptors.get(agentId);
      if (descriptor) {
        // Always try to load from the session file on demand.
        // During boot, idle/streaming agents are preloaded in bulk, but agents
        // created after boot (e.g., forked sessions) may have a valid session
        // file that was never preloaded.
        history = this.loadConversationHistoryForDescriptor(descriptor);
      }
    }

    return (history ?? []).map((entry) => ({ ...entry }));
  }

  resetConversationHistory(agentId: string): void {
    this.deps.conversationEntriesByAgentId.set(agentId, []);
  }

  deleteConversationHistory(agentId: string): void {
    this.deps.conversationEntriesByAgentId.delete(agentId);
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
    this.deps.conversationEntriesByAgentId.clear();

    for (const descriptor of this.deps.descriptors.values()) {
      if (!this.shouldPreloadHistoryForDescriptor(descriptor)) {
        continue;
      }
      this.loadConversationHistoryForDescriptor(descriptor);
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

    // tool_execution_update payloads are high-volume streaming snapshots.
    // Persisting each snapshot causes runaway JSONL growth and can crash reopening.
    // Keep updates in-memory/live WS only; terminal *_end events are still persisted.
    if (!shouldPersistConversationEntry(event)) {
      return;
    }

    const runtime = this.deps.runtimes.get(event.agentId);
    try {
      if (runtime) {
        runtime.appendCustomEntry(CONVERSATION_ENTRY_TYPE, event);
        return;
      }

      const descriptor = this.deps.descriptors.get(event.agentId);
      if (!descriptor) {
        return;
      }

      this.appendConversationEntryToSessionFile(descriptor, event);
    } catch (error) {
      this.deps.logDebug("history:save:error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private appendConversationEntryToSessionFile(
    descriptor: AgentDescriptor,
    event: ConversationEntryEvent
  ): void {
    // Avoid SessionManager.open() here: opening re-reads the whole JSONL file,
    // which is unsafe for very large transcripts. Appending a well-formed JSONL
    // entry keeps this path O(1) with no full-file reads.
    this.ensureSessionFileHeader(descriptor);

    appendFileSync(
      descriptor.sessionFile,
      `${JSON.stringify({
        type: "custom",
        customType: CONVERSATION_ENTRY_TYPE,
        data: event,
        id: randomUUID().slice(0, 8),
        parentId: null,
        timestamp: this.deps.now()
      })}\n`,
      "utf8"
    );
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
      return;
    }

    // Existing files with invalid headers cannot be reopened by SessionManager.
    // Replace with a fresh header so subsequent appends stay recoverable.
    writeFileSync(descriptor.sessionFile, headerLine, "utf8");
  }

  private shouldPreloadHistoryForDescriptor(descriptor: AgentDescriptor): boolean {
    return descriptor.status === "idle" || descriptor.status === "streaming";
  }

  private loadConversationHistoryForDescriptor(descriptor: AgentDescriptor): ConversationEntryEvent[] {
    const entriesForAgent: ConversationEntryEvent[] = [];

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
          entriesForAgent.push(entry.data);
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

    this.deps.conversationEntriesByAgentId.set(descriptor.agentId, entriesForAgent);
    return entriesForAgent;
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
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
  if (entry.type === "agent_tool_call") {
    return entry.kind !== "tool_execution_update";
  }

  if (entry.type === "conversation_log") {
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
