/**
 * Ephemeral local-Builder progress for the manager's currently authoritative inbound turn.
 * This intentionally contains neither tool identifiers nor tool payload/output detail.
 */
export interface ManagerToolActivityEvent {
  type: 'manager_tool_activity'
  sessionAgentId: string
  /** Monotonic for this in-memory manager session; clients reject older authority. */
  revision: number
  /** Distinct manager-owned tool starts in the active turn. */
  toolCount: number
  /** Normalized, bounded name of the most recently started manager tool. */
  currentToolName?: string
}
