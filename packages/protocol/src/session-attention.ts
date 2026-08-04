/**
 * Server-owned, per-session attention raised only after an armed work epoch
 * crosses into full quiescence. Reasons enrich that quiescence edge; they do
 * not independently create attention.
 */
export const SESSION_ATTENTION_REASONS = [
  'work_settled',
  'plan_completed',
  'work_graph_completed',
  'awaiting_review',
  'decision_waiting',
  'work_failed',
] as const

export type SessionAttentionReason = (typeof SESSION_ATTENTION_REASONS)[number]

/** A stable, opaque attention occurrence for one settled work epoch. */
export interface SessionAttention {
  attentionId: string
  sessionAgentId: string
  profileId: string
  reason: SessionAttentionReason
  raisedAt: string
}

/** Authoritative all-session Builder snapshot for one origin. */
export interface SessionAttentionSnapshotEvent {
  type: 'session_attention_snapshot'
  revision: number
  attentions: SessionAttention[]
}

/** A null attention removes the current visible occurrence for the session. */
export interface SessionAttentionChange {
  sessionAgentId: string
  attention: SessionAttention | null
}

/** Batched, revisioned changes so one dismissal can remove multiple sessions atomically. */
export interface SessionAttentionUpdateEvent {
  type: 'session_attention_update'
  revision: number
  changes: SessionAttentionChange[]
  /** Present only on the request-correlated dismissal result. */
  requestId?: string
}

/** Maximum number of exact attention instances a single dismissal may target. */
export const SESSION_ATTENTION_MAX_DISMISS_IDS = 100

/** Maximum length for opaque attention instance identifiers. */
export const SESSION_ATTENTION_MAX_ID_LENGTH = 256

/**
 * A dismissal is instance-exact: an old attentionId must not clear attention
 * raised by a later work epoch for the same session.
 */
export interface DismissSessionAttentionCommand {
  type: 'dismiss_session_attention'
  /** Nonempty, deduplicated exact IDs; bounded by the exported limits above. */
  attentionIds: string[]
  requestId: string
}
