import type {
  ServerEvent,
  SessionAttention,
  SessionAttentionSnapshotEvent,
  SessionAttentionUpdateEvent,
} from '@forge/protocol'
import type { ManagerWsState } from '../../ws-state'
import type { ManagerWsSessionAttentionEventContext } from '../types'

function attentionMap(attentions: readonly SessionAttention[]): Record<string, SessionAttention> {
  const next: Record<string, SessionAttention> = {}
  for (const attention of attentions) {
    next[attention.sessionAgentId] = attention
  }
  return next
}

/**
 * A snapshot is complete visible state at its revision: the bootstrap baseline
 * and every live fanout use this shape, so one dropped delivery is fully healed
 * by the next. State resets on transport open, so within a connection epoch a
 * lower-revision snapshot can only be a stale arrival and is skipped.
 */
export function reduceSessionAttentionSnapshot(
  event: SessionAttentionSnapshotEvent,
): Pick<ManagerWsState, 'sessionAttentionRevision' | 'sessionAttentions'> {
  return {
    sessionAttentionRevision: event.revision,
    sessionAttentions: attentionMap(event.attentions),
  }
}

/** Apply a whole revision batch once; stale/equal revisions are idempotent no-ops. */
export function reduceSessionAttentionUpdate(
  state: Pick<ManagerWsState, 'sessionAttentionRevision' | 'sessionAttentions'>,
  event: SessionAttentionUpdateEvent,
): Pick<ManagerWsState, 'sessionAttentionRevision' | 'sessionAttentions'> | null {
  if (event.revision <= state.sessionAttentionRevision) return null

  const sessionAttentions = { ...state.sessionAttentions }
  for (const change of event.changes) {
    if (change.attention === null) {
      delete sessionAttentions[change.sessionAgentId]
      continue
    }
    if (change.attention.sessionAgentId !== change.sessionAgentId) continue
    sessionAttentions[change.sessionAgentId] = change.attention
  }
  return { sessionAttentionRevision: event.revision, sessionAttentions }
}

export function handleSessionAttentionEvent(
  event: ServerEvent,
  context: ManagerWsSessionAttentionEventContext,
): boolean {
  if (event.type === 'session_attention_snapshot') {
    if (event.revision >= context.state.sessionAttentionRevision) {
      context.updateState(reduceSessionAttentionSnapshot(event))
    }
    return true
  }
  if (event.type === 'session_attention_update') {
    if (event.requestId) {
      context.requestTracker.resolve('dismiss_session_attention', event.requestId, event)
    }
    const patch = reduceSessionAttentionUpdate(context.state, event)
    if (patch) context.updateState(patch)
    return true
  }
  return false
}
