import { isSystemProfile, type AgentDescriptor } from '@forge/protocol'
import { arrayMove } from '@dnd-kit/sortable'
import type { ProfileTreeRow } from '@/lib/agent-hierarchy'

export function isRemoteCortexSession(agent: AgentDescriptor): boolean {
  return agent.profileId === 'cortex'
    || agent.archetypeId === 'cortex'
    || agent.sessionPurpose === 'cortex_review'
    || agent.sessionPurpose === 'capture_check'
}

export function getRemoteVisibleProfileRows(rows: ProfileTreeRow[]): ProfileTreeRow[] {
  return rows
    .filter((row) => row.profile.profileId !== 'cortex' && !isSystemProfile(row.profile))
    .map((row) => ({
      ...row,
      sessions: row.sessions.filter((session) => !isRemoteCortexSession(session.sessionAgent)),
    }))
}

export function getRemoteReorderProfileIds(rows: ProfileTreeRow[]): string[] {
  return getRemoteVisibleProfileRows(rows).map((row) => row.profile.profileId)
}

export function buildRemoteReorderProfileIds(
  rows: ProfileTreeRow[],
  activeId: string,
  overId: string,
): string[] | null {
  if (activeId === overId) return null

  const currentIds = getRemoteReorderProfileIds(rows)
  const oldIndex = currentIds.indexOf(activeId)
  const newIndex = currentIds.indexOf(overId)
  if (oldIndex === -1 || newIndex === -1) return null

  return arrayMove(currentIds, oldIndex, newIndex)
}
