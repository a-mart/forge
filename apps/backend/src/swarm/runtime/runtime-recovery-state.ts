import type { SwarmAgentRuntime } from "../runtime-contracts.js";

export type ManagerRuntimeRecycleReason =
  | "model_change"
  | "cwd_change"
  | "idle_transition"
  | "prompt_mode_change"
  | "project_agent_directory_change"
  | "specialist_roster_change";

export interface PendingManagerRuntimeRecycleEntry {
  agentId: string;
  reason: ManagerRuntimeRecycleReason;
}

export function isRuntimeRecoveryActiveForRuntime(
  runtime?: Pick<SwarmAgentRuntime, "isContextRecoveryActive" | "isContextRecoveryInProgress">
): boolean {
  return Boolean(runtime?.isContextRecoveryActive?.() ?? runtime?.isContextRecoveryInProgress?.());
}

export class RuntimeRecoveryState {
  private readonly pendingManagerRuntimeRecycleReasonsByAgentId = new Map<string, ManagerRuntimeRecycleReason>();
  private readonly recoveryAbortedWorkerTurnAgentIds = new Set<string>();

  hasPendingManagerRuntimeRecycle(agentId: string): boolean {
    return this.pendingManagerRuntimeRecycleReasonsByAgentId.has(agentId);
  }

  getPendingManagerRuntimeRecycleReason(agentId: string): ManagerRuntimeRecycleReason | undefined {
    return this.pendingManagerRuntimeRecycleReasonsByAgentId.get(agentId);
  }

  setPendingManagerRuntimeRecycle(agentId: string, reason: ManagerRuntimeRecycleReason): void {
    this.pendingManagerRuntimeRecycleReasonsByAgentId.set(agentId, reason);
  }

  clearPendingManagerRuntimeRecycle(agentId: string): void {
    this.pendingManagerRuntimeRecycleReasonsByAgentId.delete(agentId);
  }

  markRecoveryAbortedWorkerTurn(agentId: string): void {
    this.recoveryAbortedWorkerTurnAgentIds.add(agentId);
  }

  hasRecoveryAbortedWorkerTurn(agentId: string): boolean {
    return this.recoveryAbortedWorkerTurnAgentIds.has(agentId);
  }

  clearRecoveryAbortedWorkerTurn(agentId: string): void {
    this.recoveryAbortedWorkerTurnAgentIds.delete(agentId);
  }

  listPendingManagerRuntimeRecycles(): PendingManagerRuntimeRecycleEntry[] {
    return Array.from(this.pendingManagerRuntimeRecycleReasonsByAgentId, ([agentId, reason]) => ({ agentId, reason }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
  }
}
