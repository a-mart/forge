import { existsSync, rmSync } from "node:fs";
import { getConversationHistoryCacheFilePath } from "../conversation-history-cache.js";
import { isCodexAppServerExternalThreadDescriptor } from "../external-threads.js";
import { CONVERSATION_ENTRY_TYPE, ConversationTimeline } from "../session/conversation-timeline.js";
import { openSessionManagerWithSizeGuard } from "../session/session-file-guard.js";
import { isConversationEntryEvent } from "../session/conversation-validators.js";
import type { AgentDescriptor, AgentToolCallEvent, ConversationEntryEvent } from "../types.js";
import { safeJson } from "./codex-app-server-event-normalizer.js";
import { buildActivitySummary } from "../session/activity-summary.js";

const INTERRUPTED_CODEX_DETAIL_TEXT = safeJson({
  status: "cancelled",
  note: "Codex detail interrupted by backend restart before completion.",
});

export interface ReconcilePersistedCodexDetailStateForBootResult {
  reconciledToolCalls: number;
  clearedCacheFiles: number;
  reconciledSidecarAgentIds: string[];
}

export function reconcilePersistedCodexDetailStateForBoot(options: {
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  now: () => string;
  logDebug?: (message: string, details?: unknown) => void;
}): ReconcilePersistedCodexDetailStateForBootResult {
  const sidecars = Array.from(options.descriptors.values()).filter(
    (descriptor) => descriptor.status === "streaming" && isCodexAppServerExternalThreadDescriptor(descriptor),
  );
  if (sidecars.length === 0) {
    return {
      reconciledToolCalls: 0,
      clearedCacheFiles: 0,
      reconciledSidecarAgentIds: [],
    };
  }

  const timeline = new ConversationTimeline({ now: options.now, logDebug: options.logDebug });
  const managerEntriesById = new Map<string, ConversationEntryEvent[]>();
  const managerLastEntryIdById = new Map<string, string | undefined>();
  const clearedCacheFiles = new Set<string>();
  const reconciledSidecarAgentIds: string[] = [];
  let reconciledToolCalls = 0;

  for (const sidecar of sidecars) {
    clearConversationHistoryCache(sidecar.sessionFile, clearedCacheFiles);

    const manager = options.descriptors.get(sidecar.managerId);
    if (!manager || manager.role !== "manager") {
      reconciledSidecarAgentIds.push(sidecar.agentId);
      continue;
    }

    clearConversationHistoryCache(manager.sessionFile, clearedCacheFiles);

    if (!managerEntriesById.has(manager.agentId)) {
      const persisted = loadPersistedConversationEntries(manager);
      if (!persisted) {
        reconciledSidecarAgentIds.push(sidecar.agentId);
        continue;
      }

      managerEntriesById.set(manager.agentId, persisted.entries);
      managerLastEntryIdById.set(manager.agentId, persisted.lastEntryId);
    }

    const managerEntries = managerEntriesById.get(manager.agentId);
    if (!managerEntries) {
      reconciledSidecarAgentIds.push(sidecar.agentId);
      continue;
    }

    const unmatchedStarts = findUnmatchedCodexDetailStarts(managerEntries, sidecar.agentId);
    if (unmatchedStarts.length > 0) {
      timeline.trackLastSessionEntryId(manager.sessionFile, managerLastEntryIdById.get(manager.agentId));
    }

    for (const start of unmatchedStarts) {
      const timestamp = options.now();
      const end = buildInterruptedCodexDetailEnd(start, timestamp);
      const appended = timeline.appendConversationEntry(manager, end);
      // Keep summary repair and raw-row wire projection on the same durable
      // identity when a legacy tool event has no toolCallId.
      end.timelineEntryId ??= appended.entryId;
      managerEntries.push(end);
      managerLastEntryIdById.set(manager.agentId, appended.entryId);
      const summary = buildActivitySummary(end);
      if (summary) {
        const summaryAppend = timeline.appendConversationEntry(manager, summary);
        managerEntries.push(summary);
        managerLastEntryIdById.set(manager.agentId, summaryAppend.entryId);
      }
      reconciledToolCalls += 1;
    }

    reconciledSidecarAgentIds.push(sidecar.agentId);
  }

  if (reconciledToolCalls > 0 || clearedCacheFiles.size > 0) {
    options.logDebug?.("boot:reconcile_codex_detail_state", {
      reconciledToolCalls,
      clearedCacheFiles: clearedCacheFiles.size,
      reconciledSidecarAgentIds,
    });
  }

  return {
    reconciledToolCalls,
    clearedCacheFiles: clearedCacheFiles.size,
    reconciledSidecarAgentIds,
  };
}

function clearConversationHistoryCache(sessionFile: string, clearedCacheFiles: Set<string>): void {
  const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
  if (!existsSync(cacheFile)) {
    return;
  }

  rmSync(cacheFile, { force: true });
  clearedCacheFiles.add(cacheFile);
}

function loadPersistedConversationEntries(
  descriptor: AgentDescriptor,
): { entries: ConversationEntryEvent[]; lastEntryId?: string } | undefined {
  const sessionManager = openSessionManagerWithSizeGuard(descriptor.sessionFile, {
    context: `boot:codex_detail_reconciliation:${descriptor.agentId}`,
  });
  if (!sessionManager) {
    return undefined;
  }

  const entries: ConversationEntryEvent[] = [];
  let lastEntryId: string | undefined;
  for (const entry of sessionManager.getEntries()) {
    const entryId = readSessionEntryId(entry);
    if (entryId) {
      lastEntryId = entryId;
    }

    if (entry.type !== "custom" || entry.customType !== CONVERSATION_ENTRY_TYPE) {
      continue;
    }

    if (isConversationEntryEvent(entry.data)) {
      entries.push(entry.data);
    }
  }

  return { entries, lastEntryId };
}

function readSessionEntryId(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }

  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

function findUnmatchedCodexDetailStarts(
  history: ConversationEntryEvent[],
  sidecarAgentId: string,
): AgentToolCallEvent[] {
  const openStarts = new Map<string, AgentToolCallEvent>();

  for (const entry of history) {
    if (entry.type !== "agent_tool_call" || entry.actorAgentId !== sidecarAgentId) {
      continue;
    }

    const key = getToolCallMatchKey(entry);
    if (entry.kind === "tool_execution_start") {
      openStarts.set(key, entry);
      continue;
    }

    if (entry.kind === "tool_execution_end") {
      openStarts.delete(key);
    }
  }

  return Array.from(openStarts.values());
}

function getToolCallMatchKey(event: AgentToolCallEvent): string {
  return [event.actorAgentId, event.toolCallId ?? "", event.toolName ?? ""].join("\0");
}

function buildInterruptedCodexDetailEnd(start: AgentToolCallEvent, timestamp: string): AgentToolCallEvent {
  return {
    type: "agent_tool_call",
    agentId: start.agentId,
    actorAgentId: start.actorAgentId,
    timestamp,
    kind: "tool_execution_end",
    toolName: start.toolName,
    toolCallId: start.toolCallId,
    text: INTERRUPTED_CODEX_DETAIL_TEXT,
    isError: false,
  };
}
