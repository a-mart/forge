import { isSystemProfile, type AgentDescriptor } from '@forge/protocol'
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
