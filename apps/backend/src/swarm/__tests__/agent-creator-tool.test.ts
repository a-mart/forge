import { TypeCompiler } from '@sinclair/typebox/compiler'
import { describe, expect, it, vi } from 'vitest'
import { buildCreateProjectAgentTool } from '../agent-creator-tool.js'
import type { SwarmToolHost } from '../swarm-tool-host.js'
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
    const check = TypeCompiler.Compile(tool.parameters as any)
    expect(check.Check({
      sessionName: 'Release Notes',
      whenToUse: 'Draft release notes.',
      systemPrompt: 'You are the release notes project agent.',
      location: 'shared',
    })).toBe(false)

    const result = await tool.execute(
      'tool-1',
      {
        sessionName: 'Release Notes',
        handle: 'releases',
        whenToUse: 'Draft release notes.',
        systemPrompt: 'You are the release notes project agent.',
        location: 'repo',
      },
      undefined,
      undefined,
      {} as any,
    )

    expect(host.createAndPromoteProjectAgent).toHaveBeenCalledWith('creator-session', {
      sessionName: 'Release Notes',
      handle: 'releases',
      whenToUse: 'Draft release notes.',
      systemPrompt: 'You are the release notes project agent.',
      placement: 'repo',
    })
    expect(result.details).toEqual({
      agentId: 'manager--s2',
      handle: 'release-notes',
      sessionName: 'Release Notes',
    })
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Project agent @release-notes created successfully (agentId: manager--s2).',
    })
  })

  it('defaults omitted location to local for direct compatibility', async () => {
    const host = {
      createAndPromoteProjectAgent: vi.fn(async () => ({
        agentId: 'manager--s2',
        handle: 'release-notes',
      })),
    } as unknown as SwarmToolHost

    const tool = buildCreateProjectAgentTool(host, { agentId: 'creator-session' } as AgentDescriptor)
    await tool.execute(
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
      placement: 'local',
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
