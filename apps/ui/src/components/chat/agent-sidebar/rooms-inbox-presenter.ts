import type { RoomsInboxReason } from './rooms-inbox-selectors'

export interface RoomsInboxReasonPresentation {
  subtitle: string
}

/** UI-owned copy for typed Inbox reasons; unknown values stay truthful. */
export function presentRoomsInboxReason(reason: RoomsInboxReason | string): RoomsInboxReasonPresentation {
  switch (reason) {
    case 'work_settled':
      return { subtitle: 'work completed' }
    case 'plan_completed':
      return { subtitle: 'plan completed' }
    case 'work_graph_completed':
      return { subtitle: 'work completed' }
    case 'awaiting_review':
      return { subtitle: 'ready for review' }
    case 'decision_waiting':
      return { subtitle: 'decision needed' }
    case 'work_failed':
      return { subtitle: 'run failed' }
    case 'compacting':
      return { subtitle: 'compacting' }
    case 'manager_working':
      return { subtitle: 'manager working' }
    case 'recently_updated':
      return { subtitle: 'recently updated' }
    default:
      return { subtitle: 'needs your attention' }
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
