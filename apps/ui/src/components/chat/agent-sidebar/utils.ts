import type { AgentDescriptor } from '@forge/protocol'
import type { SessionRow } from '@/lib/agent-hierarchy'
import type { SessionContextMenuActions } from './SessionContextMenu'
import type { AgentLiveStatus, SessionContextMenuActionSource, StatusMap } from './types'

type SessionActivityAgent = Pick<AgentDescriptor, 'agentId' | 'status' | 'activeWorkerCount'>

export function getAgentLiveStatus(
  agent: SessionActivityAgent,
  statuses: StatusMap,
): AgentLiveStatus {
  const live = statuses[agent.agentId]
  return {
    status: live?.status ?? agent.status,
    pendingCount: live?.pendingCount ?? 0,
  }
}

export function isSessionCompactionInProgress(agentId: string, statuses: StatusMap): boolean {
  return statuses[agentId]?.contextRecoveryInProgress === true
}

/**
 * Rooms activity deliberately means work is in progress, not merely that a
 * session runtime exists. In particular, idle managers and pending runtime
 * input do not make a room active.
 */
export function isSessionActivelyWorking(
  session: { sessionAgent: SessionActivityAgent },
  statuses: StatusMap,
): boolean {
  const agent = session.sessionAgent
  return getAgentLiveStatus(agent, statuses).status === 'streaming'
    || (agent.activeWorkerCount ?? 0) > 0
    || isSessionCompactionInProgress(agent.agentId, statuses)
}

export interface ProjectRoomSummary {
  activeSessionCount: number
  unreadCount: number
  visibleSessionCount: number
}

/**
 * Aggregate only sessions that can appear in the project card. Tree rows
 * already exclude archived sessions, but the explicit archive guard keeps this
 * helper correct for filtered and test-provided rows too.
 */
export function getProjectRoomSummary(
  sessions: SessionRow[],
  statuses: StatusMap,
  unreadCounts: Record<string, number>,
  options: { hideCliSessions?: boolean; selectedAgentId?: string | null } = {},
): ProjectRoomSummary {
  const visibleSessions = sessions.filter((session) => {
    const agent = session.sessionAgent
    const selected = agent.agentId === options.selectedAgentId
      || session.workers.some((worker) => worker.agentId === options.selectedAgentId)
    return !agent.archivedAt
      && !agent.agentCreatorResult
      && !(options.hideCliSessions && agent.cli && !selected)
  })

  return visibleSessions.reduce<ProjectRoomSummary>((summary, session) => ({
    activeSessionCount: summary.activeSessionCount + (isSessionActivelyWorking(session, statuses) ? 1 : 0),
    unreadCount: summary.unreadCount + (unreadCounts[session.sessionAgent.agentId] ?? 0),
    visibleSessionCount: summary.visibleSessionCount + 1,
  }), { activeSessionCount: 0, unreadCount: 0, visibleSessionCount: 0 })
}

export function slugifySessionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function getSessionLabel(session: SessionRow): string {
  return session.sessionAgent.sessionLabel || (session.isDefault ? 'Main' : session.sessionAgent.displayName || session.sessionAgent.agentId)
}

const DEFAULT_SESSION_ARCHIVE_DISABLED_REASON = 'The default session for a project can\u2019t be archived directly.'

/**
 * Bind the same local session-menu availability used by Projects/project view.
 * Remote Inbox rows must not receive these actions.
 */
export function buildSessionContextMenuActions(
  session: SessionRow,
  source: SessionContextMenuActionSource,
  options: {
    canPromoteToProjectAgent?: boolean
    onViewCreationHistory?: () => void
  } = {},
): SessionContextMenuActions {
  const sid = session.sessionAgent.agentId
  return {
    onStop: source.onStopSession ? () => source.onStopSession?.(sid) : undefined,
    onResume: source.onResumeSession ? () => source.onResumeSession?.(sid) : undefined,
    onDelete: source.onDeleteSession ? () => source.onDeleteSession?.(sid) : undefined,
    onArchive: source.onArchiveSession && !session.isDefault ? () => source.onArchiveSession?.(sid) : undefined,
    archiveDisabledReason: session.isDefault ? DEFAULT_SESSION_ARCHIVE_DISABLED_REASON : undefined,
    onRename: source.onRequestRenameSession ? () => source.onRequestRenameSession?.(sid) : undefined,
    onFork: source.onForkSession ? () => source.onForkSession?.(sid) : undefined,
    onMarkUnread: source.onMarkUnread ? () => source.onMarkUnread?.(sid) : undefined,
    onPinSession: source.onPinSession,
    onPromoteToProjectAgent: options.canPromoteToProjectAgent !== false && source.onPromoteToProjectAgent
      ? () => source.onPromoteToProjectAgent?.(sid)
      : undefined,
    onOpenProjectAgentSharing: source.onOpenProjectAgentSharing ? () => source.onOpenProjectAgentSharing?.(sid) : undefined,
    onOpenProjectAgentSettings: source.onOpenProjectAgentSettings ? () => source.onOpenProjectAgentSettings?.(sid) : undefined,
    onDemoteProjectAgent: source.onDemoteProjectAgent ? () => { void source.onDemoteProjectAgent?.(sid) } : undefined,
    onViewCreationHistory: options.onViewCreationHistory,
    onChangeSessionModel: source.onChangeSessionModel ? () => source.onChangeSessionModel?.(sid) : undefined,
    onUseProjectDefault: source.onUseProjectDefault ? () => source.onUseProjectDefault?.(sid) : undefined,
    isMutedSession: source.mutedAgents?.has(sid),
    onToggleMute: source.onToggleMute ? () => source.onToggleMute?.(sid) : undefined,
    hideCliSessions: source.hideCliSessions,
    onToggleHideCliSessions: source.onToggleHideCliSessions,
  }
}

// ── Search helpers ──

export function parseSearchQuery(raw: string): { mode: 'both' | 'session' | 'worker'; term: string } {
  const trimmed = raw.trim()
  if (trimmed.startsWith('s:')) return { mode: 'session', term: trimmed.slice(2).trim() }
  if (trimmed.startsWith('w:')) return { mode: 'worker', term: trimmed.slice(2).trim() }
  return { mode: 'both', term: trimmed }
}

export function filterTreeRows(
  rows: import('@/lib/agent-hierarchy').ProfileTreeRow[],
  rawQuery: string,
): { filtered: import('@/lib/agent-hierarchy').ProfileTreeRow[]; matchCount: number } {
  const { mode, term } = parseSearchQuery(rawQuery)
  if (!term) return { filtered: rows, matchCount: 0 }

  const lowerTerm = term.toLowerCase()
  let matchCount = 0
  const filtered: import('@/lib/agent-hierarchy').ProfileTreeRow[] = []

  for (const row of rows) {
    const matchingSessions: SessionRow[] = []

    for (const session of row.sessions) {
      const sessionLabel = getSessionLabel(session).toLowerCase()
      const sessionAgentId = session.sessionAgent.agentId.toLowerCase()
      const sessionDisplayName = (session.sessionAgent.displayName || '').toLowerCase()
      const sessionMatches = (mode === 'both' || mode === 'session') &&
        (sessionLabel.includes(lowerTerm) || sessionAgentId.includes(lowerTerm) || sessionDisplayName.includes(lowerTerm))

      const workerMatches = (mode === 'both' || mode === 'worker') &&
        session.workers.some(
          (w) => (w.displayName || w.agentId).toLowerCase().includes(lowerTerm),
        )

      if (sessionMatches || workerMatches) {
        matchingSessions.push(session)
        matchCount++
      }
    }

    if (matchingSessions.length > 0) {
      filtered.push({ ...row, sessions: matchingSessions })
    }
  }

  return { filtered, matchCount }
}

// ── CLI-hide auto-navigate helper ──

/**
 * When the user toggles "Hide CLI Sessions" ON while viewing a CLI session,
 * find the best non-CLI session to navigate to.
 *
 * The target is chosen from `displayedRows` (which already reflect search
 * filtering) using the same visual order that ProfileGroup renders:
 *   1. Project agents (always visible at top)
 *   2. Pinned sessions (sorted by pin time ascending)
 *   3. Regular sessions (in existing sort order — most-recently-updated first)
 *
 * Same-profile match is preferred; falls back to any displayed profile.
 * Returns the target session agentId, or null if no viable target exists.
 */
export function findCliHideNavigationTarget(
  selectedAgentId: string,
  agents: AgentDescriptor[],
  displayedRows: import('@/lib/agent-hierarchy').ProfileTreeRow[],
): string | null {
  // Resolve the session-level agent (selected might be a worker)
  const directMatch = agents.find((a) => a.agentId === selectedAgentId)
  if (!directMatch) return null
  let sessionAgent: AgentDescriptor | undefined
  if (directMatch.role === 'worker') {
    sessionAgent = agents.find((a) => a.agentId === directMatch.managerId)
  } else {
    sessionAgent = directMatch
  }
  if (!sessionAgent?.cli) return null

  const profileId = sessionAgent.profileId

  const firstVisibleNonCli = (row: import('@/lib/agent-hierarchy').ProfileTreeRow): SessionRow | undefined => {
    const isCandidate = (s: SessionRow) =>
      !s.sessionAgent.cli && !s.sessionAgent.agentCreatorResult

    // 1) Project agents (always pinned at top)
    const pa = row.sessions.find((s) => Boolean(s.sessionAgent.projectAgent) && isCandidate(s))
    if (pa) return pa

    // 2) Pinned sessions (sorted by pin time ascending, matching ProfileGroup)
    const pinned = row.sessions
      .filter((s) => !s.sessionAgent.projectAgent && Boolean(s.sessionAgent.pinnedAt) && isCandidate(s))
      .sort((a, b) => (a.sessionAgent.pinnedAt ?? '').localeCompare(b.sessionAgent.pinnedAt ?? ''))
    if (pinned.length > 0) return pinned[0]

    // 3) Regular sessions (in existing sort order — most-recently-updated first)
    return row.sessions.find(
      (s) => !s.sessionAgent.projectAgent && !s.sessionAgent.pinnedAt && isCandidate(s),
    )
  }

  // Prefer same profile
  const sameProfileRow = displayedRows.find((r) => r.profile.profileId === profileId)
  let target = sameProfileRow ? firstVisibleNonCli(sameProfileRow) : undefined

  // Fall back to any other displayed profile
  if (!target) {
    for (const row of displayedRows) {
      if (row === sameProfileRow) continue
      target = firstVisibleNonCli(row)
      if (target) break
    }
  }

  return target?.sessionAgent.agentId ?? null
}

// Inject subtle glow pulse keyframes once
export function injectGlowPulseStyle(): void {
  if (typeof document !== 'undefined' && !document.getElementById('sidebar-glow-pulse')) {
    const style = document.createElement('style')
    style.id = 'sidebar-glow-pulse'
    style.textContent = `@keyframes subtle-glow-pulse{0%,100%{box-shadow:0 0 6px rgba(245,158,11,0.5)}50%{box-shadow:0 0 10px rgba(245,158,11,0.7)}}`
    document.head.appendChild(style)
  }
}
