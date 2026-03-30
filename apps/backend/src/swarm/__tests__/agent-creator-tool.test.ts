import { describe, expect, it, vi } from 'vitest'
import { buildCreateProjectAgentTool } from '../agent-creator-tool.js'
import type { SwarmToolHost } from '../swarm-tools.js'
import type { AgentDescriptor } from '../types.js'

describe('buildCreateProjectAgentTool', () => {
  it('builds the create_project_agent tool and delegates execution to the host', async () => {
    const host = {
      createAndPromoteProjectAgent: vi.fn(async () => ({
        agentId: 'manager--s2',
        handle: 'release-notes',
      })),
    } as unknown as SwarmToolHost
    const creatorDescriptor = { agentId: 'creator-session' } as AgentDescriptor

    const tool = buildCreateProjectAgentTool(host, creatorDescriptor)

    expect(tool.name).toBe('create_project_agent')
    expect(tool.label).toBe('Create Project Agent')
    expect(Object.keys((tool.parameters as any).properties ?? {})).toEqual([
      'sessionName',
      'whenToUse',
      'systemPrompt',
    ])

    const result = await tool.execute(
      'tool-1',
      {
        sessionName: 'Release Notes',
        whenToUse: 'Draft release notes.',
        systemPrompt: 'You are the release notes project agent.',
      },
      undefined,
      undefined,
      {} as any,
    )

    expect(host.createAndPromoteProjectAgent).toHaveBeenCalledWith('creator-session', {
      sessionName: 'Release Notes',
      whenToUse: 'Draft release notes.',
      systemPrompt: 'You are the release notes project agent.',
    })
    expect(result.details).toEqual({
      agentId: 'manager--s2',
      handle: 'release-notes',
      sessionName: 'Release Notes',
    })
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Project agent "Release Notes" created successfully with handle @release-notes (agentId: manager--s2).',
    })
  })

  it('fails when the host does not support project-agent creation', async () => {
    const tool = buildCreateProjectAgentTool({} as SwarmToolHost, { agentId: 'creator-session' } as AgentDescriptor)

    await expect(
      tool.execute(
        'tool-1',
        {
          sessionName: 'Release Notes',
          whenToUse: 'Draft release notes.',
          systemPrompt: 'You are the release notes project agent.',
        },
        undefined,
        undefined,
        {} as any,
      ),
    ).rejects.toThrow('Project-agent creation is not available in this runtime')
  })
})
