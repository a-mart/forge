import type { RoomsInboxReason } from './rooms-inbox-selectors'

export interface RoomsInboxReasonPresentation {
  subtitle: string
}

/** UI-owned copy for typed Inbox reasons; unknown values stay truthful. */
export function presentRoomsInboxReason(reason: RoomsInboxReason | string): RoomsInboxReasonPresentation {
  switch (reason) {
    case 'awaiting_choice':
      return { subtitle: 'awaiting your answer' }
    case 'error':
      return { subtitle: 'run failed' }
    // Unread is NOT proof the agent finished. The backend also increments it for
    // project_agent_input (apps/backend/src/ws/server.ts:226-228) and for manual
    // mark-unread (apps/backend/src/ws/ws-handler.ts:434). Claim only what is true:
    // there is unread output here. A true "finished" reason needs the Phase 4
    // quiescence signal.
    case 'unread_result':
      return { subtitle: 'unread update' }
    case 'compacting':
      return { subtitle: 'compacting' }
    case 'manager_working':
      return { subtitle: 'manager working' }
    case 'recently_updated':
      return { subtitle: 'recently updated' }
    default:
      if (reason.includes('choice') || reason.includes('review') || reason.includes('decision')) {
        return { subtitle: 'needs your attention' }
      }
      if (reason.includes('active') || reason.includes('working') || reason.includes('stream')) {
        return { subtitle: 'manager working' }
      }
      return { subtitle: 'recently updated' }
  }
}

/** Approximate descriptor timestamps; never present them as exact activity. */
export function formatRoomsInboxRelativeTime(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp)
  const milliseconds = date.getTime()
  if (!Number.isFinite(milliseconds)) return ''
  const elapsed = Math.max(0, now.getTime() - milliseconds)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 3) return `${days}d`
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date)
}
