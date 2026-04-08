import type { AgentDescriptor } from '@forge/protocol'
import type { SessionRow } from '@/lib/agent-hierarchy'
import type { AgentLiveStatus, StatusMap } from './types'

export function getAgentLiveStatus(
  agent: AgentDescriptor,
  statuses: StatusMap,
): AgentLiveStatus {
  const live = statuses[agent.agentId]
  return {
    status: live?.status ?? agent.status,
    pendingCount: live?.pendingCount ?? 0,
  }
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

// Inject subtle glow pulse keyframes once
export function injectGlowPulseStyle(): void {
  if (typeof document !== 'undefined' && !document.getElementById('sidebar-glow-pulse')) {
    const style = document.createElement('style')
    style.id = 'sidebar-glow-pulse'
    style.textContent = `@keyframes subtle-glow-pulse{0%,100%{box-shadow:0 0 6px rgba(245,158,11,0.5)}50%{box-shadow:0 0 10px rgba(245,158,11,0.7)}}`
    document.head.appendChild(style)
  }
}
