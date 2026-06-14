import { describe, expect, it } from 'vitest'
import type { GitWorktreeAgentSummary } from '@forge/protocol'
import {
  isWorktreeAttachedAgentStatus,
  isWorktreeRunningAgentStatus,
  isWorktreeRunningWorker,
  summarizeWorktreeAgents,
} from './worktree-agent-stats'

function agent(
  overrides: Partial<GitWorktreeAgentSummary> & Pick<GitWorktreeAgentSummary, 'agentId'>,
): GitWorktreeAgentSummary {
  return {
    displayName: overrides.agentId,
    role: 'worker',
    status: 'idle',
    ...overrides,
  }
}

describe('worktree-agent-stats', () => {
  it('treats idle and streaming agents as attached', () => {
    expect(isWorktreeAttachedAgentStatus('idle')).toBe(true)
    expect(isWorktreeAttachedAgentStatus('streaming')).toBe(true)
    expect(isWorktreeAttachedAgentStatus('terminated')).toBe(false)
    expect(isWorktreeAttachedAgentStatus('stopped')).toBe(false)
    expect(isWorktreeAttachedAgentStatus('error')).toBe(false)
  })

  it('treats only streaming agents as running', () => {
    expect(isWorktreeRunningAgentStatus('streaming')).toBe(true)
    expect(isWorktreeRunningAgentStatus('idle')).toBe(false)
    expect(isWorktreeRunningAgentStatus('terminated')).toBe(false)
  })

  it('counts only streaming workers as running', () => {
    expect(
      isWorktreeRunningWorker(agent({ agentId: 'worker-1', role: 'worker', status: 'streaming' })),
    ).toBe(true)
    expect(
      isWorktreeRunningWorker(agent({ agentId: 'mgr-1', role: 'manager', status: 'streaming' })),
    ).toBe(false)
    expect(
      isWorktreeRunningWorker(agent({ agentId: 'worker-2', role: 'worker', status: 'idle' })),
    ).toBe(false)
  })

  it('does not count a streaming manager as running', () => {
    const stats = summarizeWorktreeAgents([
      agent({ agentId: 'mgr-1', role: 'manager', status: 'streaming' }),
      agent({ agentId: 'worker-1', role: 'worker', status: 'idle' }),
    ])

    expect(stats).toEqual({
      attached: 2,
      running: 0,
      managers: 1,
      workers: 1,
    })
  })

  it('counts a streaming worker as running', () => {
    const stats = summarizeWorktreeAgents([
      agent({ agentId: 'mgr-1', role: 'manager', status: 'idle' }),
      agent({ agentId: 'worker-1', role: 'worker', status: 'streaming' }),
    ])

    expect(stats).toEqual({
      attached: 2,
      running: 1,
      managers: 1,
      workers: 1,
    })
  })

  it('summarizes attached, running, and role counts without terminated agents', () => {
    const stats = summarizeWorktreeAgents([
      agent({ agentId: 'mgr-1', role: 'manager', status: 'idle' }),
      agent({ agentId: 'worker-1', status: 'streaming' }),
      agent({ agentId: 'worker-2', status: 'streaming' }),
      agent({ agentId: 'worker-3', status: 'terminated' }),
    ])

    expect(stats).toEqual({
      attached: 3,
      running: 2,
      managers: 1,
      workers: 2,
    })
  })

  it('returns zero counts for empty input', () => {
    expect(summarizeWorktreeAgents([])).toEqual({
      attached: 0,
      running: 0,
      managers: 0,
      workers: 0,
    })
  })
})
