import { describe, expect, it } from 'vitest'
import {
  getInactiveRepoProjectAgentDefinitions,
  getInactiveRepoProjectAgentEntryKey,
  getUnavailableRepoProjectAgentDefinitions,
  matchesRepoProjectAgentSearch,
} from './repo-project-agent-ui-utils'

describe('repo-project-agent-ui helpers', () => {
  const section = {
    exists: true,
    count: 3,
    items: [
      {
        definitionId: 'active',
        handle: 'active',
        path: '/repo/.forge/project-agents/active',
        status: 'valid' as const,
        problems: [],
        activatedAgentId: 'agent-1',
      },
      {
        definitionId: 'inactive',
        handle: 'docs',
        path: '/repo/.forge/project-agents/inactive',
        status: 'valid' as const,
        problems: [],
        displayName: 'Documentation Agent',
      },
      {
        definitionId: 'broken',
        handle: 'broken',
        path: '/repo/.forge/project-agents/broken',
        status: 'invalid' as const,
        problems: [{ code: 'missing_prompt', message: 'Missing prompt' }],
      },
    ],
  }

  it('returns only valid inactive definitions', () => {
    expect(getInactiveRepoProjectAgentDefinitions(section)).toEqual([section.items[1]])
  })

  it('returns unavailable inactive definitions', () => {
    expect(getUnavailableRepoProjectAgentDefinitions(section)).toEqual([section.items[2]])
  })

  it('matches search against handle, display name, whenToUse, and definition id', () => {
    const item = section.items[1]
    expect(matchesRepoProjectAgentSearch(item, 'docs')).toBe(true)
    expect(matchesRepoProjectAgentSearch(item, 'documentation')).toBe(true)
    expect(matchesRepoProjectAgentSearch(item, 'inactive')).toBe(true)
    expect(matchesRepoProjectAgentSearch(item, 'missing')).toBe(false)
    expect(matchesRepoProjectAgentSearch(item, undefined)).toBe(true)
  })

  it('keys inactive entries by profile and definition id', () => {
    const item = section.items[1]
    expect(getInactiveRepoProjectAgentEntryKey({ profileId: 'profile-a', item })).toBe('profile-a:inactive')
    expect(getInactiveRepoProjectAgentEntryKey({ profileId: 'profile-b', item })).toBe('profile-b:inactive')
  })
})
