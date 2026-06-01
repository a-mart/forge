import { describe, expect, it, vi } from 'vitest'
import type { ManagerProfile, ProjectAgentExternalDirectoryEntry } from '@forge/protocol'
import { SwarmManager } from '../swarm-manager.js'

describe('SwarmManager.getProjectAgentExternalDirectory', () => {
  it('returns empty entries for system-managed profiles without consulting sharing service', async () => {
    const entries: ProjectAgentExternalDirectoryEntry[] = [{
      agentId: 'docs--s1',
      handle: 'forge/documentation',
      displayName: 'Docs',
      whenToUse: 'docs',
      sourceProjectName: 'Forge',
      origin: 'external',
    }]
    const getExternalDirectoryEntries = vi.fn(() => entries)

    const manager = Object.create(SwarmManager.prototype) as SwarmManager & {
      profiles: Map<string, ManagerProfile>
      projectAgentSharingService: {
        getExternalDirectoryEntries: (profileId: string) => ProjectAgentExternalDirectoryEntry[]
      }
    }

    manager.profiles = new Map([
      [
        'cortex',
        {
          profileId: 'cortex',
          displayName: 'Cortex',
          defaultSessionAgentId: 'cortex',
          defaultModel: {
            provider: 'openai-codex',
            modelId: 'gpt-5.5',
            thinkingLevel: 'medium',
          },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          profileType: 'system',
        },
      ],
    ])
    manager.projectAgentSharingService = { getExternalDirectoryEntries }

    await expect(manager.getProjectAgentExternalDirectory('cortex')).resolves.toEqual([])
    expect(getExternalDirectoryEntries).not.toHaveBeenCalled()
  })
})
