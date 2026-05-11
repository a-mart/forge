import type {
  CliActiveToolSnapshotEntry,
  SessionActiveToolsSnapshotEvent,
} from "@forge/protocol";
import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import type { AgentDescriptor, AgentStatusEvent, AgentToolCallEvent } from "./types.js";

export class SessionActiveToolsState {
  private readonly activeToolsBySessionAgentId = new Map<string, Map<string, CliActiveToolSnapshotEntry>>();

  recordToolCall(event: AgentToolCallEvent): SessionActiveToolsSnapshotEvent | null {
    const sessionAgentId = event.agentId;
    const key = buildActiveToolKey(event.actorAgentId, event.toolCallId, event.toolName);

    if (event.kind === "tool_execution_end") {
      const existing = this.activeToolsBySessionAgentId.get(sessionAgentId);
      if (!existing?.delete(key)) {
        return null;
      }
      if (existing.size === 0) {
        this.activeToolsBySessionAgentId.delete(sessionAgentId);
      }
      return this.buildSnapshotEvent(sessionAgentId);
    }

    const existingByKey = this.activeToolsBySessionAgentId.get(sessionAgentId) ?? new Map<string, CliActiveToolSnapshotEntry>();
    const existing = existingByKey.get(key);
    existingByKey.set(key, {
      sessionAgentId,
      actorAgentId: event.actorAgentId,
      agentId: event.actorAgentId,
      ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
      ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
      text: event.text,
      startedAt: event.kind === "tool_execution_start" ? event.timestamp : existing?.startedAt ?? event.timestamp,
      updatedAt: event.timestamp,
      ...(event.isError !== undefined ? { isError: event.isError } : {}),
    });
    this.activeToolsBySessionAgentId.set(sessionAgentId, existingByKey);
    return this.buildSnapshotEvent(sessionAgentId);
  }

  recordAgentStatus(event: AgentStatusEvent, descriptor: AgentDescriptor | undefined): SessionActiveToolsSnapshotEvent[] {
    if (!descriptor || !isNonRunningAgentStatus(event.status)) {
      return [];
    }

    if (descriptor.role === "manager") {
      const snapshot = this.clearSession(descriptor.agentId);
      return snapshot ? [snapshot] : [];
    }

    const snapshot = this.clearActor(descriptor.agentId, descriptor.managerId);
    return snapshot ? [snapshot] : [];
  }

  clearSession(sessionAgentId: string): SessionActiveToolsSnapshotEvent | null {
    if (!this.activeToolsBySessionAgentId.delete(sessionAgentId)) {
      return null;
    }
    return this.buildSnapshotEvent(sessionAgentId);
  }

  clearActor(actorAgentId: string, sessionAgentId: string): SessionActiveToolsSnapshotEvent | null {
    return this.clearActorFromSession(actorAgentId, sessionAgentId);
  }

  getSnapshot(sessionAgentId: string): CliActiveToolSnapshotEntry[] {
    return Array.from(this.activeToolsBySessionAgentId.get(sessionAgentId)?.values() ?? [], cloneActiveToolEntry);
  }

  buildSnapshotEvent(sessionAgentId: string, requestId?: string): SessionActiveToolsSnapshotEvent {
    return {
      type: "session_active_tools_snapshot",
      sessionAgentId,
      activeTools: this.getSnapshot(sessionAgentId),
      ...(requestId !== undefined ? { requestId } : {}),
    };
  }

  private clearActorFromSession(actorAgentId: string, sessionAgentId: string): SessionActiveToolsSnapshotEvent | null {
    const existing = this.activeToolsBySessionAgentId.get(sessionAgentId);
    if (!existing) {
      return null;
    }

    let changed = false;
    for (const [key, entry] of existing.entries()) {
      if (entry.actorAgentId === actorAgentId) {
        existing.delete(key);
        changed = true;
      }
    }

    if (!changed) {
      return null;
    }

    if (existing.size === 0) {
      this.activeToolsBySessionAgentId.delete(sessionAgentId);
    }
    return this.buildSnapshotEvent(sessionAgentId);
  }
}

function buildActiveToolKey(actorAgentId: string, toolCallId: string | undefined, toolName: string | undefined): string {
  const normalizedToolCallId = normalizeActiveToolKeyPart(toolCallId);
  if (normalizedToolCallId) {
    return `${actorAgentId}\u0000call:${normalizedToolCallId}`;
  }

  return `${actorAgentId}\u0000fallback:${normalizeActiveToolKeyPart(toolName) ?? "unknown"}`;
}

function normalizeActiveToolKeyPart(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function cloneActiveToolEntry(entry: CliActiveToolSnapshotEntry): CliActiveToolSnapshotEntry {
  return { ...entry };
}
