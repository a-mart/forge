import type { AgentStatus } from "./agent-state-machine.js";
import type { RuntimeErrorEvent, RuntimeSessionEvent } from "./runtime-contracts.js";
import type { AgentDescriptor, ConversationMessageEvent } from "./types.js";
import { extractMessageText } from "./message-utils.js";
import {
  appendTurnLedgerRecord,
  type TurnLedgerSessionTarget,
} from "./turn-ledger.js";

export const MANAGER_TURN_NOTICE_MS = 30_000;
export const MANAGER_TURN_ESCALATE_MS = 5 * 60_000;
export const MANAGER_TURN_STUCK_MS = 10 * 60_000;
export const MANAGER_TURN_RECOVERY_HOLD_MS = 2 * 60_000;

export interface ManagerTurnWatchdogOptions {
  dataDir: string;
  now(): string;
  descriptors: Map<string, AgentDescriptor>;
  getSessionTarget(agentId: string): TurnLedgerSessionTarget | null;
  getActiveTurnId(agentId: string, runtimeToken?: number): string | undefined;
  hasPendingChoicesForSession(sessionAgentId: string): boolean;
  isRuntimeRecoveryActive(agentId: string): boolean;
  emitConversationMessage(event: ConversationMessageEvent): void;
  logDebug(message: string, details?: unknown): void;
}

interface ManagerTurnState {
  turnId: string;
  runtimeToken?: number;
  startedAt: number;
  lastProgressAt: number;
  tier: 0 | 1 | 2 | 3;
  openToolCalls: Set<string>;
  recoveryHoldUntil: number | null;
}

export class ManagerTurnWatchdog {
  private readonly stateByAgentId = new Map<string, ManagerTurnState>();

  constructor(private readonly options: ManagerTurnWatchdogOptions) {}

  recordStatus(agentId: string, runtimeToken: number | undefined, status: AgentStatus, pendingCount: number): void {
    const descriptor = this.options.descriptors.get(agentId);
    if (descriptor?.role !== "manager") return;

    if (status === "streaming") {
      const turnId = this.options.getActiveTurnId(agentId, runtimeToken);
      if (turnId) {
        this.arm(agentId, turnId, runtimeToken);
      }
      return;
    }

    if (status === "idle" && pendingCount === 0) {
      this.recordTerminal(agentId, "idle");
    }
  }

  recordEvent(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void {
    const descriptor = this.options.descriptors.get(agentId);
    if (descriptor?.role !== "manager") return;

    if (event.type === "agent_start" || event.type === "turn_start" || event.type === "message_start") {
      const turnId = this.options.getActiveTurnId(agentId, runtimeToken);
      if (turnId) {
        this.arm(agentId, turnId, runtimeToken);
      }
    }

    const state = this.stateByAgentId.get(agentId);
    if (!state) return;

    switch (event.type) {
      case "tool_execution_start":
        state.openToolCalls.add(event.toolCallId);
        this.recordProgress(agentId);
        break;
      case "tool_execution_update":
        this.recordProgress(agentId);
        break;
      case "tool_execution_end":
        state.openToolCalls.delete(event.toolCallId);
        this.recordProgress(agentId);
        break;
      case "auto_compaction_start":
        state.recoveryHoldUntil = Date.now() + MANAGER_TURN_RECOVERY_HOLD_MS;
        this.recordProgress(agentId);
        break;
      case "auto_compaction_end":
        state.recoveryHoldUntil = null;
        this.recordProgress(agentId);
        break;
      case "message_update":
      case "message_end":
        // Thinking-only and empty provider deltas are not visible progress.
        // They can arrive for minutes before the manager produces anything the
        // user can see, so they must not keep resetting the stall ladder.
        if (extractMessageText(event.message)?.trim()) {
          this.recordProgress(agentId);
        }
        break;
      case "turn_end":
        this.recordProgress(agentId);
        break;
      case "auto_retry_start":
      case "auto_retry_end":
        // Provider retries are hidden transport activity, not user-visible
        // manager progress. Counting them can restart the ladder forever and
        // prevent a genuinely stuck turn from offering runtime recycle.
        break;
      case "agent_end":
        this.recordTerminal(agentId, "agent_end");
        break;
      default:
        break;
    }
  }

  recordRuntimeError(agentId: string, _error: RuntimeErrorEvent): void {
    this.recordTerminal(agentId, "error");
  }

  recordTerminal(agentId: string, outcome: "agent_end" | "idle" | "error" | "recycled" | "abandoned" | "reconciled"): void {
    const state = this.stateByAgentId.get(agentId);
    if (!state) return;
    this.stateByAgentId.delete(agentId);
    const target = this.options.getSessionTarget(agentId);
    if (!target) return;
    void appendTurnLedgerRecord(target, {
      t: "turn_terminal",
      turnId: state.turnId,
      outcome,
      at: this.options.now(),
    }).catch((error) => {
      this.options.logDebug("turn_ledger:terminal:error", { agentId, turnId: state.turnId, error: String(error) });
    });
  }

  check(nowMs = Date.now()): void {
    for (const [agentId, state] of this.stateByAgentId) {
      const descriptor = this.options.descriptors.get(agentId);
      if (!descriptor || descriptor.role !== "manager" || descriptor.status !== "streaming") {
        this.stateByAgentId.delete(agentId);
        continue;
      }

      if (this.options.hasPendingChoicesForSession(agentId)) {
        // Waiting for an explicit user choice is healthy, intentional inactivity.
        // Exclude that time from the stall ladder so answering a long-lived
        // choice cannot immediately produce a stale warning.
        state.lastProgressAt = nowMs;
        state.tier = 0;
        continue;
      }

      if (state.openToolCalls.size > 0) {
        // Manager-run tools pause the ladder (long builds/tests are legitimate),
        // but an indefinitely hung tool must still surface: past the stuck
        // threshold the ladder fires regardless of open tool calls.
        if (nowMs - state.lastProgressAt < MANAGER_TURN_STUCK_MS) {
          continue;
        }
      }

      if (this.options.isRuntimeRecoveryActive(agentId)) {
        state.recoveryHoldUntil ??= nowMs + MANAGER_TURN_RECOVERY_HOLD_MS;
        if (nowMs < state.recoveryHoldUntil) {
          continue;
        }
      } else if (state.recoveryHoldUntil && nowMs < state.recoveryHoldUntil) {
        continue;
      } else if (state.recoveryHoldUntil && nowMs >= state.recoveryHoldUntil) {
        state.recoveryHoldUntil = null;
      }

      const elapsed = nowMs - state.lastProgressAt;
      if (elapsed >= MANAGER_TURN_STUCK_MS && state.tier < 3) {
        state.tier = 3;
        this.emitStallNotice(agentId, state, 3);
      } else if (elapsed >= MANAGER_TURN_ESCALATE_MS && state.tier < 2) {
        state.tier = 2;
        this.emitStallNotice(agentId, state, 2);
      } else if (elapsed >= MANAGER_TURN_NOTICE_MS && state.tier < 1) {
        state.tier = 1;
        this.emitStallNotice(agentId, state, 1);
      }
    }
  }

  clear(agentId: string): void {
    this.stateByAgentId.delete(agentId);
  }

  getState(agentId: string): Readonly<ManagerTurnState> | undefined {
    return this.stateByAgentId.get(agentId);
  }

  private arm(agentId: string, turnId: string, runtimeToken: number | undefined): void {
    const existing = this.stateByAgentId.get(agentId);
    if (existing?.turnId === turnId) {
      return;
    }
    const nowMs = Date.now();
    this.stateByAgentId.set(agentId, {
      turnId,
      ...(runtimeToken !== undefined ? { runtimeToken } : {}),
      startedAt: nowMs,
      lastProgressAt: nowMs,
      tier: 0,
      openToolCalls: new Set(),
      recoveryHoldUntil: null,
    });
  }

  private recordProgress(agentId: string): void {
    const state = this.stateByAgentId.get(agentId);
    if (!state) return;
    state.lastProgressAt = Date.now();
    state.tier = 0;
    state.recoveryHoldUntil = null;
  }

  private emitStallNotice(agentId: string, state: ManagerTurnState, tier: 1 | 2 | 3): void {
    const target = this.options.getSessionTarget(agentId);
    if (target) {
      void appendTurnLedgerRecord(target, {
        t: "turn_stalled",
        turnId: state.turnId,
        agentId,
        tier,
        at: this.options.now(),
      }).catch((error) => {
        this.options.logDebug("turn_ledger:stalled:error", { agentId, turnId: state.turnId, tier, error: String(error) });
      });
    }

    const text =
      tier === 1
        ? "Still working, but the manager has not produced a runtime update for this turn yet."
        : tier === 2
          ? "The manager still has not produced a runtime update for this turn. It may be stuck; you can wait or recycle the runtime if needed."
          : "The manager appears stuck. Use ⋮ → Stop All, then retry the request.";

    this.options.emitConversationMessage({
      type: "conversation_message",
      agentId,
      turnId: state.turnId,
      role: "system",
      text,
      timestamp: this.options.now(),
      source: "system",
    });
  }
}
