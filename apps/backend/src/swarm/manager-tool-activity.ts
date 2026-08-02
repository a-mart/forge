import type { ManagerToolActivityEvent } from "@forge/protocol";

const MAX_MANAGER_TOOL_NAME_LENGTH = 64;

interface SessionManagerToolActivityState {
  revision: number;
  activeTurnId?: string;
  startedToolKeys: Set<string>;
  toolCount: number;
  currentToolName?: string;
}

/**
 * Ephemeral manager-turn tool progress for the local Builder header.
 *
 * Turn IDs and tool-call IDs are authority/correlation inputs only; neither is
 * retained in the wire event. This state is intentionally not conversation or
 * session-history state.
 */
export class ManagerToolActivityState {
  private readonly bySessionAgentId = new Map<string, SessionManagerToolActivityState>();

  activate(sessionAgentId: string, turnId: string): ManagerToolActivityEvent | null {
    const normalizedTurnId = normalizeIdentifier(turnId);
    if (!normalizedTurnId) {
      return null;
    }

    const state = this.getOrCreate(sessionAgentId);
    if (state.activeTurnId === normalizedTurnId) {
      return null;
    }

    state.activeTurnId = normalizedTurnId;
    state.startedToolKeys.clear();
    state.toolCount = 0;
    state.currentToolName = undefined;
    state.revision += 1;
    return this.toEvent(sessionAgentId, state);
  }

  recordToolStart(input: {
    sessionAgentId: string;
    turnId?: string;
    toolCallId?: string;
    toolName?: string;
  }): ManagerToolActivityEvent | null {
    const state = this.bySessionAgentId.get(input.sessionAgentId);
    const turnId = normalizeIdentifier(input.turnId);
    if (!state?.activeTurnId || !turnId || state.activeTurnId !== turnId) {
      return null;
    }

    const normalizedToolName = normalizeToolName(input.toolName);
    // Tool-call IDs are only an internal de-duplication key. A missing ID is
    // still counted as a start; names are bounded before they ever leave this
    // state and the fallback key is scoped to the active turn.
    const key = normalizeIdentifier(input.toolCallId)
      ? `call:${normalizeIdentifier(input.toolCallId)}`
      : `anonymous:${state.toolCount}:${normalizedToolName ?? "unknown"}`;
    if (state.startedToolKeys.has(key)) {
      return null;
    }

    state.startedToolKeys.add(key);
    state.toolCount += 1;
    state.currentToolName = normalizedToolName;
    state.revision += 1;
    return this.toEvent(input.sessionAgentId, state);
  }

  clear(sessionAgentId: string): ManagerToolActivityEvent | null {
    const state = this.bySessionAgentId.get(sessionAgentId);
    if (!state || (!state.activeTurnId && state.toolCount === 0)) {
      return null;
    }

    const resolved = state;
    resolved.activeTurnId = undefined;
    resolved.startedToolKeys.clear();
    resolved.toolCount = 0;
    resolved.currentToolName = undefined;
    resolved.revision += 1;
    return this.toEvent(sessionAgentId, resolved);
  }

  buildSnapshotEvent(sessionAgentId: string): ManagerToolActivityEvent {
    return this.toEvent(sessionAgentId, this.getOrCreate(sessionAgentId));
  }

  private getOrCreate(sessionAgentId: string): SessionManagerToolActivityState {
    const existing = this.bySessionAgentId.get(sessionAgentId);
    if (existing) {
      return existing;
    }

    const created: SessionManagerToolActivityState = {
      revision: 0,
      startedToolKeys: new Set(),
      toolCount: 0,
    };
    this.bySessionAgentId.set(sessionAgentId, created);
    return created;
  }

  private toEvent(sessionAgentId: string, state: SessionManagerToolActivityState): ManagerToolActivityEvent {
    return {
      type: "manager_tool_activity",
      sessionAgentId,
      revision: state.revision,
      toolCount: state.toolCount,
      ...(state.currentToolName ? { currentToolName: state.currentToolName } : {}),
    };
  }
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeToolName(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_MANAGER_TOOL_NAME_LENGTH);
  return normalized || undefined;
}
