import { describe, expect, it } from 'vitest'
import {
  getProjectAgentSuggestions,
  shouldLoadExternalProjectAgentDirectory,
} from './project-agent-suggestions'
import type {
  AgentDescriptor,
  ManagerProfile,
  ProjectAgentExternalDirectoryEntry,
} from '@forge/protocol'

function makeManager(
  agentId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  }
}

function makeWorker(
  agentId: string,
  managerId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  }
}

function makeProjectAgent(
  agentId: string,
  profileId: string,
  handle: string,
  whenToUse: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return makeManager(agentId, {
    profileId,
    projectAgent: { handle, whenToUse },
    ...overrides,
  })
}

function makeProfile(
  profileId: string,
  overrides: Partial<ManagerProfile> = {},
): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('shouldLoadExternalProjectAgentDirectory', () => {
  it('skips Cortex even before profiles finish loading', () => {
    expect(
      shouldLoadExternalProjectAgentDirectory({
        activeAgentRole: 'manager',
        activeProfileId: 'cortex',
        activeProfileType: null,
      }),
    ).toBe(false)
  })

  it('skips system-managed profiles from the profile snapshot', () => {
    const profiles = [makeProfile('cortex', { profileType: 'system' })]

    expect(
      shouldLoadExternalProjectAgentDirectory({
        activeAgentRole: 'manager',
        activeProfileId: 'cortex',
        activeProfileType: profiles[0].profileType ?? null,
      }),
    ).toBe(false)
  })

  it('allows normal user profiles', () => {
    const profiles = [makeProfile('alpha', { profileType: 'user' })]

    expect(
      shouldLoadExternalProjectAgentDirectory({
        activeAgentRole: 'manager',
        activeProfileId: 'alpha',
        activeProfileType: profiles[0].profileType ?? null,
      }),
    ).toBe(true)
  })
})

describe('getProjectAgentSuggestions', () => {
  it('filters by active manager profile', () => {
    const active = makeManager('alpha', { profileId: 'alpha' })
    const agentInProfile = makeProjectAgent('alpha--s2', 'alpha', 'docs', 'For documentation')
    const agentInOtherProfile = makeProjectAgent('beta--s1', 'beta', 'releases', 'For releases')

    const suggestions = getProjectAgentSuggestions(active, [active, agentInProfile, agentInOtherProfile])

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toEqual({
      agentId: 'alpha--s2',
      handle: 'docs',
      displayName: 'alpha--s2',
      whenToUse: 'For documentation',
    })
  })

  it('excludes the current/self agent', () => {
    const active = makeManager('alpha', {
      profileId: 'alpha',
      projectAgent: { handle: 'self', whenToUse: 'Self' },
    })

    const suggestions = getProjectAgentSuggestions(active, [active])
    expect(suggestions).toEqual([])
  })

  it('excludes workers and non-project agents', () => {
    const active = makeManager('alpha', { profileId: 'alpha' })
    const worker = makeWorker('worker-1', 'alpha', { profileId: 'alpha' })
    const nonProjectManager = makeManager('alpha--s2', { profileId: 'alpha' })

    const suggestions = getProjectAgentSuggestions(active, [active, worker, nonProjectManager])
    expect(suggestions).toEqual([])
  })

  it('uses stale display-label fallback correctly (sessionLabel > displayName > agentId)', () => {
    const active = makeManager('mgr', { profileId: 'mgr' })
    const agentWithSessionLabel = makeProjectAgent('mgr--s2', 'mgr', 'handle-a', 'testing', {
      displayName: 'Old Name',
      sessionLabel: 'Renamed Session',
    })
    const agentWithDisplayName = makeProjectAgent('mgr--s3', 'mgr', 'handle-b', 'other', {
      displayName: 'Display Only',
    })
    const agentWithAgentIdFallback = makeProjectAgent('mgr--s4', 'mgr', 'handle-c', 'fallback', {
      displayName: undefined as any,
    })

    const suggestions = getProjectAgentSuggestions(active, [
      active,
      agentWithSessionLabel,
      agentWithDisplayName,
      agentWithAgentIdFallback,
    ])

    expect(suggestions).toEqual([
      {
        agentId: 'mgr--s2',
        handle: 'handle-a',
        displayName: 'Renamed Session',
        whenToUse: 'testing',
      },
      {
        agentId: 'mgr--s3',
        handle: 'handle-b',
        displayName: 'Display Only',
        whenToUse: 'other',
      },
      {
        agentId: 'mgr--s4',
        handle: 'handle-c',
        displayName: 'mgr--s4',
        whenToUse: 'fallback',
      },
    ])
  })

  it('returns empty array when activeAgent is null', () => {
    expect(getProjectAgentSuggestions(null, [])).toEqual([])
  })

  it('returns empty array when activeAgent is undefined', () => {
    expect(getProjectAgentSuggestions(undefined, [])).toEqual([])
  })

  it('returns empty array when activeAgent is a worker', () => {
    const worker = makeWorker('worker-1', 'mgr', { profileId: 'mgr' })
    const projectAgent = makeProjectAgent('mgr--s2', 'mgr', 'docs', 'docs')

    expect(getProjectAgentSuggestions(worker, [worker, projectAgent])).toEqual([])
  })

  it('returns empty array when activeAgent has no profileId', () => {
    const active = makeManager('alpha', { profileId: undefined })
    const agent = makeProjectAgent('alpha--s2', 'alpha', 'docs', 'For docs')

    expect(getProjectAgentSuggestions(active, [active, agent])).toEqual([])
  })

  it('returns multiple project agents in the same profile', () => {
    const active = makeManager('alpha', { profileId: 'alpha' })
    const agentA = makeProjectAgent('alpha--s2', 'alpha', 'docs', 'Documentation')
    const agentB = makeProjectAgent('alpha--s3', 'alpha', 'releases', 'Releases')

    const suggestions = getProjectAgentSuggestions(active, [active, agentA, agentB])

    expect(suggestions).toHaveLength(2)
    expect(suggestions.map((s) => s.handle)).toEqual(['docs', 'releases'])
  })

  it('includes external shared project agents from server-projected directory snapshots', () => {
    const active = makeManager('alpha', { profileId: 'alpha' })
    const externalEntries: ProjectAgentExternalDirectoryEntry[] = [
      {
        agentId: 'beta--docs',
        handle: 'forge/documentation',
        displayName: 'Docs Agent',
        whenToUse: 'Documentation help',
        sourceProjectName: 'Forge',
        origin: 'external',
      },
    ]

    const suggestions = getProjectAgentSuggestions(active, [active], externalEntries)

    expect(suggestions).toEqual([
      {
        agentId: 'beta--docs',
        handle: 'forge/documentation',
        displayName: 'Docs Agent',
        whenToUse: 'Documentation help',
      },
    ])
  })
})
