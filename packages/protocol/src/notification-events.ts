export interface UnreadNotificationEvent {
  type: 'unread_notification'
  agentId: string
  /** What triggered this notification. Absent for legacy compat (treat as 'message'). */
  reason?: 'message' | 'choice_request'
  /** The session/manager agent this notification belongs to. Needed for per-manager prefs on worker-originated events. */
  sessionAgentId?: string
}

/** Sent during bootstrap — full authoritative state for all profiles. */
export interface UnreadCountsSnapshotEvent {
  type: 'unread_counts_snapshot'
  /** sessionAgentId → count (sparse: only entries with count > 0) */
  counts: Record<string, number>
}

/** Sent live after any mutation — single session update. */
export interface UnreadCountUpdateEvent {
  type: 'unread_count_update'
  agentId: string
  count: number
}
