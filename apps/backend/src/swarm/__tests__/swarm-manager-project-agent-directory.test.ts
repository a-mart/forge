import { describe, expect, it, vi } from 'vitest'
import type { ManagerProfile, ProjectAgentExternalDirectoryEntry } from '@forge/protocol'
import {
  ProjectAgentCoordinator,
  type ProjectAgentCoordinatorOptions,
} from '../project-agent-coordinator.js'

describe('ProjectAgentCoordinator.getExternalDirectory', () => {
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

    const profiles = new Map<string, ManagerProfile>([
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
    const coordinator = new ProjectAgentCoordinator({
      profiles,
      descriptors: new Map(),
      sharing: { getExternalDirectoryEntries },
    } as unknown as ProjectAgentCoordinatorOptions)

    await expect(coordinator.getExternalDirectory('cortex')).resolves.toEqual([])
    expect(getExternalDirectoryEntries).not.toHaveBeenCalled()
  })
})
