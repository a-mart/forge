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

export class RuntimeRecoveryState {
  private readonly pendingManagerRuntimeRecycleReasonsByAgentId = new Map<string, ManagerRuntimeRecycleReason>();

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

  listPendingManagerRuntimeRecycles(): PendingManagerRuntimeRecycleEntry[] {
    return Array.from(this.pendingManagerRuntimeRecycleReasonsByAgentId, ([agentId, reason]) => ({ agentId, reason }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
  }
}
