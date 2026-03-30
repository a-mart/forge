import { describe, expect, it } from 'vitest'
import {
  PROJECT_AGENT_DIRECTORY_MAX_ENTRIES,
  deliverProjectAgentMessage,
  findProjectAgentByHandle,
  generateProjectAgentDirectoryBlock,
  getProjectAgentPublicName,
  listProjectAgents,
  normalizeProjectAgentHandle,
} from '../project-agents.js'
import type { AgentDescriptor } from '../types.js'

function makeManagerDescriptor(overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, 'agentId'>): AgentDescriptor {
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role: 'manager',
    managerId: overrides.managerId ?? overrides.agentId,
    status: overrides.status ?? 'idle',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    cwd: overrides.cwd ?? '/tmp/project',
    model: overrides.model ?? {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile: overrides.sessionFile ?? `/tmp/${overrides.agentId}.jsonl`,
    profileId: overrides.profileId ?? 'manager',
    sessionLabel: overrides.sessionLabel,
    projectAgent: overrides.projectAgent,
  }
}

describe('project-agents helpers', () => {
  it('derives public names and handles from session naming', () => {
    const descriptor = makeManagerDescriptor({
      agentId: 'release-notes--s2',
      displayName: 'Release Notes',
      sessionLabel: 'Release Notes!',
    })

    expect(getProjectAgentPublicName(descriptor)).toBe('Release Notes!')
    expect(normalizeProjectAgentHandle(' Release Notes! 2026 ')).toBe('release-notes-2026')
  })

  it('lists promoted sessions within a profile and resolves by handle', () => {
    const descriptors: AgentDescriptor[] = [
      makeManagerDescriptor({
        agentId: 'release-notes--s2',
        sessionLabel: 'Release Notes',
        projectAgent: { handle: 'release-notes', whenToUse: 'Draft release notes' },
      }),
      makeManagerDescriptor({
        agentId: 'qa--s3',
        sessionLabel: 'QA',
        projectAgent: { handle: 'qa', whenToUse: 'Reproduce issues' },
      }),
      makeManagerDescriptor({
        agentId: 'other-profile',
        profileId: 'other',
        sessionLabel: 'Other Profile',
        projectAgent: { handle: 'other-profile', whenToUse: 'Other work' },
      }),
      makeManagerDescriptor({
        agentId: 'plain-session',
        sessionLabel: 'Plain Session',
      }),
    ]

    expect(listProjectAgents(descriptors, 'manager').map((entry) => entry.agentId)).toEqual([
      'qa--s3',
      'release-notes--s2',
    ])
    expect(listProjectAgents(descriptors, 'manager', { excludeAgentId: 'qa--s3' }).map((entry) => entry.agentId)).toEqual([
      'release-notes--s2',
    ])
    expect(findProjectAgentByHandle(descriptors, 'manager', '@release notes!')?.agentId).toBe('release-notes--s2')
    expect(findProjectAgentByHandle(descriptors, 'manager', 'missing')).toBeUndefined()
  })

  it('generates a prompt directory block with entries', () => {
    const populated = generateProjectAgentDirectoryBlock([
      {
        agentId: 'release-notes--s2',
        displayName: 'Release Notes',
        handle: 'release-notes',
        whenToUse: 'Draft release notes and changelog copy.',
      },
    ])

    expect(populated).toContain('Project agents in this profile')
    expect(populated).toContain('`@release-notes`')
    expect(populated).toContain('Draft release notes and changelog copy.')
    expect(populated).toContain('Workers do not have this directory.')
  })

  it('renders a sensible empty directory block when no project agents are configured', () => {
    expect(generateProjectAgentDirectoryBlock([])).toBe('Project agents in this profile — none configured.')
  })

  it('normalizes multiline display names and when-to-use text before rendering', () => {
    const populated = generateProjectAgentDirectoryBlock([
      {
        agentId: 'release-notes--s2',
        displayName: 'Release\n\nNotes',
        handle: 'release-notes',
        whenToUse: 'Draft release notes\n\nand   changelog\tcopy.',
      },
    ])

    expect(populated).toContain('- Release Notes (`@release-notes`, agentId: `release-notes--s2`): Draft release notes and changelog copy.')
    expect(populated).not.toContain('Release\n\nNotes')
    expect(populated).not.toContain('Draft release notes\n\nand   changelog\tcopy.')
  })

  it('caps rendered directory entries and adds a summary line when more exist', () => {
    const entries = Array.from({ length: PROJECT_AGENT_DIRECTORY_MAX_ENTRIES + 2 }, (_, index) => ({
      agentId: `agent-${index + 1}`,
      displayName: `Agent ${index + 1}`,
      handle: `agent-${index + 1}`,
      whenToUse: `Task ${index + 1}`,
    }))

    const populated = generateProjectAgentDirectoryBlock(entries)

    expect(populated).toContain(`- Agent ${PROJECT_AGENT_DIRECTORY_MAX_ENTRIES} (\`@agent-${PROJECT_AGENT_DIRECTORY_MAX_ENTRIES}\`, agentId: \`agent-${PROJECT_AGENT_DIRECTORY_MAX_ENTRIES}\`): Task ${PROJECT_AGENT_DIRECTORY_MAX_ENTRIES}`)
    expect(populated).not.toContain(`- Agent ${PROJECT_AGENT_DIRECTORY_MAX_ENTRIES + 1} (\`@agent-${PROJECT_AGENT_DIRECTORY_MAX_ENTRIES + 1}\`, agentId: \`agent-${PROJECT_AGENT_DIRECTORY_MAX_ENTRIES + 1}\`): Task ${PROJECT_AGENT_DIRECTORY_MAX_ENTRIES + 1}`)
    expect(populated).toContain('(+2 more project agents not shown)')
  })

  it('collapses multiline session labels before rendering the directory block', () => {
    const [entry] = listProjectAgents(
      [
        makeManagerDescriptor({
          agentId: 'release-notes--s2',
          sessionLabel: 'Release\n\nNotes',
          projectAgent: { handle: 'release-notes', whenToUse: 'Draft release notes' },
        }),
      ],
      'manager',
    )

    expect(entry).toBeDefined()
    const populated = generateProjectAgentDirectoryBlock([
      {
        agentId: entry!.agentId,
        displayName: getProjectAgentPublicName(entry!),
        handle: entry!.projectAgent.handle,
        whenToUse: entry!.projectAgent.whenToUse,
      },
    ])

    expect(populated).toContain('- Release Notes (`@release-notes`, agentId: `release-notes--s2`): Draft release notes')
    expect(populated).not.toContain('Release\n\nNotes')
  })

  it('does not emit a transcript entry or mark activity when runtime creation fails', async () => {
    const sender = makeManagerDescriptor({
      agentId: 'manager',
      sessionLabel: 'manager',
    })
    const target = makeManagerDescriptor({
      agentId: 'release-notes--s2',
      sessionLabel: 'Release Notes',
      projectAgent: { handle: 'release-notes', whenToUse: 'Draft release notes' },
    })

    const emittedEvents: unknown[] = []
    const markedActivity: Array<{ agentId: string; timestamp?: string }> = []

    await expect(
      deliverProjectAgentMessage(
        {
          now: () => '2026-01-02T03:04:05.000Z',
          getOrCreateRuntimeForDescriptor: async () => {
            throw new Error('runtime creation failed')
          },
          emitConversationMessage: (event) => {
            emittedEvents.push(event)
          },
          markSessionActivity: (agentId, timestamp) => {
            markedActivity.push({ agentId, timestamp })
          },
          rateLimitBuckets: new Map(),
        },
        {
          sender,
          target,
          message: 'Please draft release notes.',
          delivery: 'auto',
        },
      ),
    ).rejects.toThrow('runtime creation failed')

    expect(emittedEvents).toEqual([])
    expect(markedActivity).toEqual([])
  })
})
