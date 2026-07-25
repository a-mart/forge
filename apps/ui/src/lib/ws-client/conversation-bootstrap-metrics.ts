export type ConversationSubscriptionReason =
  | 'selection'
  | 'view_change'
  | 'refresh'
  | 'reconnect'
  | 'create'
  | 'fork'
  | 'fallback'
  | 'retry'

export type ConversationBootstrapTerminal =
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'superseded'
  | 'disconnected'

export type ConversationBootstrapMismatch = {
  frame: 'ready' | 'conversation_history' | 'pending_choices_snapshot' | 'bootstrap_failed'
  dimension: 'id' | 'agent' | 'view' | 'phase'
}

const counts = new Map<string, number>()
const staleDwellSamples: number[] = []

function increment(key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

export const conversationBootstrapMetrics = {
  started(reason: ConversationSubscriptionReason): void {
    increment(`conversation_bootstrap.started_total:${reason}`)
  },
  terminal(terminal: ConversationBootstrapTerminal): void {
    increment(`conversation_bootstrap.terminal_total:${terminal}`)
  },
  mismatch({ frame, dimension }: ConversationBootstrapMismatch): void {
    increment(`conversation_bootstrap.mismatched_frames_total:${frame}:${dimension}`)
  },
  staleDwell(durationMs: number): void {
    staleDwellSamples.push(Math.max(0, durationMs))
    if (staleDwellSamples.length > 128) staleDwellSamples.shift()
  },
  snapshot(): { counts: Record<string, number>; staleDwellMs: number[] } {
    return { counts: Object.fromEntries(counts), staleDwellMs: [...staleDwellSamples] }
  },
  reset(): void {
    counts.clear()
    staleDwellSamples.length = 0
  },
}
