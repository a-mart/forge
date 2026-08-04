import { existsSync } from "node:fs";
import type { AgentDescriptor, AgentToolCallEvent, ConversationEntryEvent, ConversationMessageEvent } from "./types.js";
import { CONVERSATION_ENTRY_TYPE, ConversationTimeline } from "./session/conversation-timeline.js";
import { isConversationEntryEvent } from "./session/conversation-validators.js";
import { openSessionManagerWithSizeGuard } from "./session/session-file-guard.js";
import { buildActivitySummary } from "./session/activity-summary.js";

const SEND_MESSAGE_TOOL_NAME = "send_message_to_agent";
const INTERRUPTED_TOOL_TEXT = "Tool call interrupted by backend restart before completion.";
const MAX_DELIVERY_PREVIEW_LENGTH = 240;

export interface InterruptedToolReconciliationResult {
  reconciledToolCalls: number;
  deliveryWarnings: number;
}

export function reconcileInterruptedManagerToolCalls(options: {
  descriptor: AgentDescriptor;
  now: () => string;
  emitAgentToolCall: (event: AgentToolCallEvent) => void;
  emitConversationMessage: (event: ConversationMessageEvent) => void;
  logDebug?: (message: string, details?: unknown) => void;
}): InterruptedToolReconciliationResult {
  const persisted = loadPersistedConversationEntries(options.descriptor);
  if (!persisted) {
    return { reconciledToolCalls: 0, deliveryWarnings: 0 };
  }

  const unmatchedStarts = findUnmatchedToolStarts(
    persisted.entries,
    new Set([options.descriptor.agentId]),
  );
  let reconciledToolCalls = 0;
  let deliveryWarnings = 0;

  for (const start of unmatchedStarts) {
    const timestamp = options.now();
    options.emitAgentToolCall(buildInterruptedToolEnd(start, timestamp));
    reconciledToolCalls += 1;
    if (start.toolName === SEND_MESSAGE_TOOL_NAME) {
      options.emitConversationMessage(buildInterruptedDeliveryWarning(start, timestamp));
      deliveryWarnings += 1;
    }
  }

  if (reconciledToolCalls > 0) {
    options.logDebug?.("runtime_stop:reconcile_interrupted_manager_tool_calls", {
      agentId: options.descriptor.agentId,
      reconciledToolCalls,
      deliveryWarnings,
    });
  }

  return { reconciledToolCalls, deliveryWarnings };
}

export function reconcileInterruptedToolCallsForBoot(options: {
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  interruptedActorAgentIds: ReadonlySet<string>;
  now: () => string;
  logDebug?: (message: string, details?: unknown) => void;
}): InterruptedToolReconciliationResult {
  const { descriptors, interruptedActorAgentIds, now, logDebug } = options;
  const timeline = new ConversationTimeline({ now, logDebug });
  let reconciledToolCalls = 0;
  let deliveryWarnings = 0;

  for (const managerDescriptor of collectImpactedManagerDescriptors(descriptors, interruptedActorAgentIds)) {
    const persisted = loadPersistedConversationEntries(managerDescriptor);
    if (!persisted) {
      continue;
    }

    const unmatchedStarts = findUnmatchedToolStarts(persisted.entries, interruptedActorAgentIds);
    if (unmatchedStarts.length > 0) {
      timeline.trackLastSessionEntryId(managerDescriptor.sessionFile, persisted.lastEntryId);
    }

    for (const start of unmatchedStarts) {
      const timestamp = now();
      const end = buildInterruptedToolEnd(start, timestamp);
      const appended = timeline.appendConversationEntry(managerDescriptor, end);
      // Keep summary repair and raw-row wire projection on the same durable
      // identity when a legacy tool event has no toolCallId.
      end.timelineEntryId ??= appended.entryId;
      const summary = buildActivitySummary(end, { status: "interrupted" });
      if (summary) timeline.appendConversationEntry(managerDescriptor, summary);
      reconciledToolCalls += 1;

      if (start.toolName === SEND_MESSAGE_TOOL_NAME) {
        timeline.appendConversationEntry(managerDescriptor, buildInterruptedDeliveryWarning(start, timestamp));
        deliveryWarnings += 1;
      }
    }
  }

  if (reconciledToolCalls > 0) {
    logDebug?.("boot:reconcile_interrupted_tool_calls", {
      actorAgentIds: Array.from(interruptedActorAgentIds).sort(),
      reconciledToolCalls,
      deliveryWarnings,
    });
  }

  return { reconciledToolCalls, deliveryWarnings };
}

function collectImpactedManagerDescriptors(
  descriptors: ReadonlyMap<string, AgentDescriptor>,
  interruptedActorAgentIds: ReadonlySet<string>,
): AgentDescriptor[] {
  const managerIds = new Set<string>();
  for (const actorAgentId of interruptedActorAgentIds) {
    const descriptor = descriptors.get(actorAgentId);
    if (!descriptor) {
      continue;
    }

    managerIds.add(descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId);
  }

  const managers: AgentDescriptor[] = [];
  for (const managerId of managerIds) {
    const descriptor = descriptors.get(managerId);
    if (descriptor?.role === "manager") {
      managers.push(descriptor);
    }
  }

  return managers;
}

function loadPersistedConversationEntries(
  descriptor: AgentDescriptor,
): { entries: ConversationEntryEvent[]; lastEntryId?: string } | undefined {
  if (!existsSync(descriptor.sessionFile)) {
    return { entries: [] };
  }

  const sessionManager = openSessionManagerWithSizeGuard(descriptor.sessionFile, {
    context: `boot:interrupted_tool_reconciliation:${descriptor.agentId}`,
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

function findUnmatchedToolStarts(
  history: ConversationEntryEvent[],
  interruptedActorAgentIds: ReadonlySet<string>,
): AgentToolCallEvent[] {
  const openStarts = new Map<string, AgentToolCallEvent>();

  for (const entry of history) {
    if (entry.type !== "agent_tool_call" || !interruptedActorAgentIds.has(entry.actorAgentId)) {
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

function buildInterruptedToolEnd(start: AgentToolCallEvent, timestamp: string): AgentToolCallEvent {
  return {
    type: "agent_tool_call",
    agentId: start.agentId,
    actorAgentId: start.actorAgentId,
    timestamp,
    kind: "tool_execution_end",
    toolName: start.toolName,
    toolCallId: start.toolCallId,
    text: INTERRUPTED_TOOL_TEXT,
    isError: true,
  };
}

function buildInterruptedDeliveryWarning(start: AgentToolCallEvent, timestamp: string): ConversationMessageEvent {
  const input = parseToolInput(start.text);
  const targetAgentId =
    readStringField(input, "targetAgentId") ?? readStringFieldFromJsonText(start.text, "targetAgentId") ?? "unknown target";
  const preview = truncatePreview(
    readStringField(input, "message") ?? readStringFieldFromJsonText(start.text, "message") ?? "",
  );

  return {
    type: "conversation_message",
    agentId: start.agentId,
    role: "system",
    text: preview.length > 0
      ? `⚠️ Delivery to ${targetAgentId} may not have completed before the backend restarted. Resend it if still needed. Preview: ${preview}`
      : `⚠️ Delivery to ${targetAgentId} may not have completed before the backend restarted. Resend it if still needed.`,
    timestamp,
    source: "system",
  };
}

function parseToolInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function readStringFieldFromJsonText(text: string, key: string): string | undefined {
  const keyPattern = escapeRegExp(key);
  const closedStringMatch = new RegExp(`"${keyPattern}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(text);
  const rawValue = closedStringMatch?.[1] ?? new RegExp(`"${keyPattern}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`).exec(text)?.[1];
  if (!rawValue) {
    return undefined;
  }

  const decoded = decodeJsonStringFragment(rawValue);
  return decoded.trim().length > 0 ? decoded.trim() : undefined;
}

function decodeJsonStringFragment(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncatePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_DELIVERY_PREVIEW_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_DELIVERY_PREVIEW_LENGTH)}…`;
}
