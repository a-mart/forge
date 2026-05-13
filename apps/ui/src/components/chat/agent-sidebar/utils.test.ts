import { describe, expect, it } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import type { ProfileTreeRow, SessionRow } from '@/lib/agent-hierarchy'
import { findCliHideNavigationTarget } from './utils'

// ── Factories ──

function makeAgent(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: 'agent-1',
    managerId: 'agent-1',
    displayName: 'Agent',
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'high' },
    sessionFile: '/tmp/agent-1.jsonl',
    ...overrides,
  }
}

function makeSession(agent: AgentDescriptor, workers: AgentDescriptor[] = [], isDefault = false): SessionRow {
  return { sessionAgent: agent, workers, isDefault }
}

function makeProfile(profileId: string, displayName?: string): ManagerProfile {
  return {
    profileId,
    displayName: displayName ?? profileId,
    defaultSessionAgentId: profileId,
    defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'high' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function makeRow(profileId: string, sessions: SessionRow[]): ProfileTreeRow {
  return { profile: makeProfile(profileId), sessions }
}

const CLI_META = { createdBy: 'forge-cli' as const, runId: 'run-1', command: 'run' as const, startedAt: '2026-01-01T00:00:00.000Z' }

// ── Tests ──

describe('findCliHideNavigationTarget', () => {
  it('returns null when the selected agent is not a CLI session', () => {
    const regularAgent = makeAgent({ agentId: 'regular', profileId: 'p1' })
    const row = makeRow('p1', [makeSession(regularAgent)])
    expect(findCliHideNavigationTarget('regular', [regularAgent], [row])).toBeNull()
  })

  it('returns null when selected agent does not exist', () => {
    const row = makeRow('p1', [])
    expect(findCliHideNavigationTarget('ghost', [], [row])).toBeNull()
  })

  it('picks the first regular non-CLI session in the same profile', () => {
    const cliSession = makeAgent({ agentId: 'cli-1', profileId: 'p1', cli: CLI_META })
    const regular1 = makeAgent({ agentId: 'regular-1', profileId: 'p1' })
    const regular2 = makeAgent({ agentId: 'regular-2', profileId: 'p1' })
    const row = makeRow('p1', [
      makeSession(cliSession),
      makeSession(regular1),
      makeSession(regular2),
    ])
    expect(findCliHideNavigationTarget('cli-1', [cliSession, regular1, regular2], [row])).toBe('regular-1')
  })

  it('prefers a project agent over a pinned session', () => {
    const cliSession = makeAgent({ agentId: 'cli-1', profileId: 'p1', cli: CLI_META })
    const pinned = makeAgent({
      agentId: 'pinned-1',
      profileId: 'p1',
      pinnedAt: '2026-01-02T00:00:00.000Z',
    })
    const projectAgent = makeAgent({
      agentId: 'pa-1',
      profileId: 'p1',
      projectAgent: { handle: 'my-agent', whenToUse: 'always' },
    })
    // Project agent appears AFTER pinned in the raw array, but should still win
    const row = makeRow('p1', [
      makeSession(cliSession),
      makeSession(pinned),
      makeSession(projectAgent),
    ])
    expect(findCliHideNavigationTarget('cli-1', [cliSession, pinned, projectAgent], [row])).toBe('pa-1')
  })

  it('prefers a pinned session over a regular session', () => {
    const cliSession = makeAgent({ agentId: 'cli-1', profileId: 'p1', cli: CLI_META })
    const regular = makeAgent({ agentId: 'regular-1', profileId: 'p1' })
    const pinned = makeAgent({
      agentId: 'pinned-1',
      profileId: 'p1',
      pinnedAt: '2026-01-02T00:00:00.000Z',
    })
    // Pinned appears after regular in raw array, but should still win
    const row = makeRow('p1', [
      makeSession(cliSession),
      makeSession(regular),
      makeSession(pinned),
    ])
    expect(findCliHideNavigationTarget('cli-1', [cliSession, regular, pinned], [row])).toBe('pinned-1')
  })

  it('picks the earliest-pinned session when multiple are pinned', () => {
    const cliSession = makeAgent({ agentId: 'cli-1', profileId: 'p1', cli: CLI_META })
    const pinnedLater = makeAgent({
      agentId: 'pinned-later',
      profileId: 'p1',
      pinnedAt: '2026-01-03T00:00:00.000Z',
    })
    const pinnedFirst = makeAgent({
      agentId: 'pinned-first',
      profileId: 'p1',
      pinnedAt: '2026-01-01T00:00:00.000Z',
    })
    // pinnedLater is first in array, but pinnedFirst should win (earlier pin time)
    const row = makeRow('p1', [
      makeSession(cliSession),
      makeSession(pinnedLater),
      makeSession(pinnedFirst),
    ])
    expect(findCliHideNavigationTarget('cli-1', [cliSession, pinnedLater, pinnedFirst], [row])).toBe('pinned-first')
  })

  it('resolves through a worker to its parent CLI session', () => {
    const cliSession = makeAgent({ agentId: 'cli-1', profileId: 'p1', cli: CLI_META })
    const cliWorker = makeAgent({ agentId: 'cli-worker', managerId: 'cli-1', role: 'worker' })
    const regular = makeAgent({ agentId: 'regular-1', profileId: 'p1' })
    const row = makeRow('p1', [
      makeSession(cliSession, [cliWorker]),
      makeSession(regular),
    ])
    expect(findCliHideNavigationTarget('cli-worker', [cliSession, cliWorker, regular], [row])).toBe('regular-1')
  })

  it('skips agentCreatorResult sessions', () => {
    const cliSession = makeAgent({ agentId: 'cli-1', profileId: 'p1', cli: CLI_META })
    const wizard = makeAgent({
      agentId: 'wizard-1',
      profileId: 'p1',
      agentCreatorResult: { createdAgentId: 'x', createdHandle: 'x', createdAt: '2026-01-01T00:00:00.000Z' },
    })
    const regular = makeAgent({ agentId: 'regular-1', profileId: 'p1' })
    const row = makeRow('p1', [
      makeSession(cliSession),
      makeSession(wizard),
      makeSession(regular),
    ])
    expect(findCliHideNavigationTarget('cli-1', [cliSession, wizard, regular], [row])).toBe('regular-1')
  })

  it('falls back to another profile when same-profile has only CLI sessions', () => {
    const cliSession = makeAgent({ agentId: 'cli-1', profileId: 'p1', cli: CLI_META })
    const otherRegular = makeAgent({ agentId: 'other-regular', profileId: 'p2' })
    const row1 = makeRow('p1', [makeSession(cliSession)])
    const row2 = makeRow('p2', [makeSession(otherRegular)])
    expect(findCliHideNavigationTarget('cli-1', [cliSession, otherRegular], [row1, row2])).toBe('other-regular')
  })

  it('returns null when all sessions across all profiles are CLI', () => {
    const cli1 = makeAgent({ agentId: 'cli-1', profileId: 'p1', cli: CLI_META })
    const cli2 = makeAgent({ agentId: 'cli-2', profileId: 'p2', cli: CLI_META })
    const row1 = makeRow('p1', [makeSession(cli1)])
    const row2 = makeRow('p2', [makeSession(cli2)])
    expect(findCliHideNavigationTarget('cli-1', [cli1, cli2], [row1, row2])).toBeNull()
  })

  it('uses search-filtered rows so hidden sessions are not selected', () => {
    const cliSession = makeAgent({ agentId: 'cli-1', profileId: 'p1', cli: CLI_META })
    const regular = makeAgent({ agentId: 'regular-1', profileId: 'p1' })
    const filteredOut = makeAgent({ agentId: 'filtered-out', profileId: 'p1' })
    // Simulate search filtering: filteredOut does not appear in the row
    const row = makeRow('p1', [
      makeSession(cliSession),
      makeSession(regular),
      // filteredOut intentionally excluded — simulates search filter
    ])
    const allAgents = [cliSession, regular, filteredOut]
    expect(findCliHideNavigationTarget('cli-1', allAgents, [row])).toBe('regular-1')
  })

  it('skips CLI-flagged project agents', () => {
    // A project agent that also has cli metadata should not be a target
    const cliSession = makeAgent({ agentId: 'cli-1', profileId: 'p1', cli: CLI_META })
    const cliProjectAgent = makeAgent({
      agentId: 'cli-pa',
      profileId: 'p1',
      cli: CLI_META,
      projectAgent: { handle: 'bot', whenToUse: 'always' },
    })
    const regular = makeAgent({ agentId: 'regular-1', profileId: 'p1' })
    const row = makeRow('p1', [
      makeSession(cliSession),
      makeSession(cliProjectAgent),
      makeSession(regular),
    ])
    expect(findCliHideNavigationTarget('cli-1', [cliSession, cliProjectAgent, regular], [row])).toBe('regular-1')
  })
})
