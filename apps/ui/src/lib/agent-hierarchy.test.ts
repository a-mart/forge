import { describe, expect, it } from 'vitest'
import {
  buildManagerTreeRows,
  buildProfileTreeRows,
  chooseFallbackAgentId,
  getPrimaryManagerId,
} from './agent-hierarchy'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'

function manager(agentId: string, managerId = agentId): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: `2026-01-01T00:00:0${agentId.endsWith('2') ? '1' : '0'}.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function worker(agentId: string, managerId: string): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker',
    status: 'idle',
    createdAt: '2026-01-01T00:00:02.000Z',
    updatedAt: '2026-01-01T00:00:02.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function profile(profileId: string): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('agent-hierarchy', () => {
  it('groups workers under owning managers', () => {
    const agents: AgentDescriptor[] = [
      manager('manager'),
      manager('manager-2', 'manager'),
      worker('worker-a', 'manager'),
      worker('worker-b', 'manager-2'),
      worker('worker-orphan', 'missing-manager'),
    ]

    const { managerRows, orphanWorkers } = buildManagerTreeRows(agents)

    expect(managerRows).toHaveLength(2)
    expect(managerRows[0]?.manager.agentId).toBe('manager')
    expect(managerRows[0]?.workers.map((entry) => entry.agentId)).toEqual(['worker-a'])
    expect(managerRows[1]?.manager.agentId).toBe('manager-2')
    expect(managerRows[1]?.workers.map((entry) => entry.agentId)).toEqual(['worker-b'])
    expect(orphanWorkers.map((entry) => entry.agentId)).toEqual(['worker-orphan'])
  })

  it('prefers the legacy default manager id when choosing a primary manager', () => {
    const agents: AgentDescriptor[] = [manager('manager'), manager('manager-2', 'manager')]
    expect(getPrimaryManagerId(agents)).toBe('manager')
  })

  it('falls back to created-order manager selection when no legacy manager id exists', () => {
    const agents: AgentDescriptor[] = [manager('beta'), manager('alpha')]
    expect(getPrimaryManagerId(agents)).toBe('alpha')
  })

  it('chooses fallback target preferring a primary manager', () => {
    const agents: AgentDescriptor[] = [
      manager('manager'),
      manager('manager-2', 'manager'),
      worker('worker-a', 'manager-2'),
    ]

    expect(chooseFallbackAgentId(agents, 'worker-a')).toBe('worker-a')
    expect(chooseFallbackAgentId(agents, 'missing-agent')).toBe('manager')
  })

  it('treats stopped and errored agents as inactive', () => {
    const stoppedManager = { ...manager('manager-stopped'), status: 'stopped' as const }
    const erroredWorker = { ...worker('worker-error', 'manager-stopped'), status: 'error' as const }

    const { managerRows, orphanWorkers } = buildManagerTreeRows([stoppedManager, erroredWorker])

    expect(managerRows).toHaveLength(0)
    expect(orphanWorkers).toHaveLength(0)
    expect(getPrimaryManagerId([stoppedManager])).toBeNull()
    expect(chooseFallbackAgentId([stoppedManager, erroredWorker], null)).toBeNull()
  })

  it('sorts sessions by updatedAt descending within a profile', () => {
    const profileId = 'manager'
    const root = {
      ...manager(profileId),
      profileId,
      sessionLabel: 'Main',
      updatedAt: '2026-01-01T00:00:05.000Z',
    }
    const older = {
      ...manager('manager--s2', 'manager--s2'),
      profileId,
      sessionLabel: 'Session 2',
      createdAt: '2026-01-01T00:00:10.000Z',
      updatedAt: '2026-01-01T00:00:06.000Z',
    }
    const newest = {
      ...manager('manager--s3', 'manager--s3'),
      profileId,
      sessionLabel: 'Session 3',
      createdAt: '2026-01-01T00:00:11.000Z',
      updatedAt: '2026-01-01T00:00:09.000Z',
    }

    const rows = buildProfileTreeRows([root, older, newest], [profile(profileId)])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.sessions.map((entry) => entry.sessionAgent.agentId)).toEqual([
      'manager--s3',
      'manager--s2',
      'manager',
    ])
  })

  it('filters collab-backed sessions out of Builder tree and fallback selection', () => {
    const profileId = 'manager'
    const builderSession = {
      ...manager(profileId),
      profileId,
      sessionLabel: 'Builder',
    }
    const collabSession = {
      ...manager('manager--collab'),
      profileId,
      sessionLabel: 'Collab',
      sessionSurface: 'collab' as const,
      collab: {
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
      },
    }

    const rows = buildProfileTreeRows([builderSession, collabSession], [profile(profileId)])

    expect(rows[0]?.sessions.map((entry) => entry.sessionAgent.agentId)).toEqual(['manager'])
    expect(getPrimaryManagerId([collabSession, builderSession])).toBe('manager')
    expect(chooseFallbackAgentId([collabSession, builderSession], collabSession.agentId)).toBe('manager')
  })
})
