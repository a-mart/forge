import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionGoalSnapshot } from '@forge/protocol'
import {
  appendSessionGoalCompactionInstructions,
  formatSessionGoalModelContext,
} from '../goals/session-goal-context.js'
import { buildGoalTools } from '../goals/goal-tools.js'
import { SessionGoalStore } from '../goals/session-goal-store.js'
import { getSessionGoalPath } from '../storage/data-paths.js'
import type { SwarmToolHost } from '../swarm-tool-host.js'
import type { AgentDescriptor } from '../types.js'

const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, total: 150 }

describe('session goals', () => {
  it('persists one active goal and restores it after a restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-goal-'))
    let now = '2026-07-13T10:00:00.000Z'
    const options = {
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => now,
      randomId: () => 'goal-1',
    }
    const created = await new SessionGoalStore(options).create({
      objective: '  Ship the durable goal system  ',
      tokenBudget: 50_000,
    })

    expect(created).toMatchObject({
      revision: 1,
      goal: {
        id: 'goal-1',
        objective: 'Ship the durable goal system',
        status: 'active',
        tokenBudget: 50_000,
        turnCount: 1,
      },
    })
    await expect(new SessionGoalStore(options).load()).resolves.toEqual(created)
    await expect(new SessionGoalStore(options).create({ objective: 'Competing goal' }))
      .rejects.toThrow('Finish or cancel the current goal')

    now = '2026-07-13T10:00:05.000Z'
    const paused = await new SessionGoalStore(options).control({ action: 'pause' })
    expect(paused.goal).toMatchObject({
      status: 'paused',
      pauseReason: 'user',
      activeElapsedMs: 5_000,
    })
    expect(paused.goal).not.toHaveProperty('activeSince')
  })

  it('supports edit, pause, resume, blocking, completion, and sequential goals', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-goal-lifecycle-'))
    let now = '2026-07-13T10:00:00.000Z'
    let nextId = 1
    const store = new SessionGoalStore({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => now,
      randomId: () => `goal-${nextId++}`,
    })

    await store.create({ objective: 'First outcome', tokenBudget: 1_000 })
    await store.control({ action: 'edit', objective: 'Revised outcome', tokenBudget: null })
    const edited = await store.load()
    expect(edited.goal).toMatchObject({ objective: 'Revised outcome' })
    expect(edited.goal).not.toHaveProperty('tokenBudget')

    await expect(store.updateFromAgent('blocked')).rejects.toThrow('at least 3 goal turns')
    await store.incrementTurn()
    await store.incrementTurn()
    const blocked = await store.updateFromAgent('blocked')
    expect(blocked.goal).toMatchObject({ status: 'blocked', turnCount: 3 })

    now = '2026-07-13T10:01:00.000Z'
    const resumed = await store.control({ action: 'resume' })
    expect(resumed.goal).toMatchObject({ status: 'active', activeSince: now })
    await expect(store.updateFromAgent('blocked')).rejects.toThrow('current blocking audit')
    await store.incrementTurn()
    await store.incrementTurn()
    await store.incrementTurn()
    await expect(store.updateFromAgent('blocked')).resolves.toMatchObject({
      goal: { status: 'blocked', turnCount: 6 },
    })
    await store.control({ action: 'resume' })

    now = '2026-07-13T10:02:00.000Z'
    const completed = await store.updateFromAgent('complete', { usage, coverage: 'complete' })
    expect(completed.goal).toMatchObject({
      status: 'completed',
      endedAt: now,
      finalUsage: usage,
      finalUsageCoverage: 'complete',
    })

    const history = readJsonl(await readFile(store.historyFilePath, 'utf8'))
    expect(history).toEqual([completed])

    now = '2026-07-13T10:03:00.000Z'
    const second = await store.create({ objective: 'Second outcome' })
    expect(second).toMatchObject({ revision: completed.revision + 1, goal: { id: 'goal-2' } })
    expect(readJsonl(await readFile(store.historyFilePath, 'utf8'))).toEqual([completed])
  })

  it('pauses at a budget and archives cancellation when a session is cleared', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-goal-clear-'))
    const store = new SessionGoalStore({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => '2026-07-13T10:00:00.000Z',
      randomId: () => 'goal-1',
    })
    await store.create({ objective: 'Stay bounded', tokenBudget: 100 })

    const paused = await store.pauseForBudget()
    expect(paused.goal).toMatchObject({ status: 'paused', pauseReason: 'token_budget_exhausted' })
    await store.control({ action: 'resume' })
    const cleared = await store.clear({ usage, coverage: 'partial' })

    expect(cleared).toMatchObject({ revision: 5, goal: null })
    expect(readJsonl(await readFile(store.historyFilePath, 'utf8'))).toEqual([
      expect.objectContaining({
        revision: 4,
        goal: expect.objectContaining({
          status: 'cancelled',
          finalUsage: usage,
          finalUsageCoverage: 'partial',
        }),
      }),
    ])
  })

  it('does not end the current goal if terminal history cannot be written', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-goal-history-failure-'))
    const appendHistory = vi.fn(async () => { throw new Error('history unavailable') })
    const store = new SessionGoalStore({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      appendHistory,
    })
    await store.create({ objective: 'Preserve me' })

    await expect(store.updateFromAgent('complete', { usage, coverage: 'complete' }))
      .rejects.toThrow('history unavailable')
    await expect(store.load()).resolves.toMatchObject({
      revision: 1,
      goal: { status: 'active', objective: 'Preserve me' },
    })
  })

  it('quarantines malformed state and safely returns an empty goal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-goal-corrupt-'))
    const path = getSessionGoalPath(dataDir, 'profile-1', 'session-1')
    const store = new SessionGoalStore({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      randomId: () => 'corrupt-backup',
    })
    await store.create({ objective: 'Temporary' })
    await writeFile(path, '{broken', 'utf8')

    await expect(store.load()).resolves.toMatchObject({ revision: 0, goal: null })
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('formats a compact model and compaction context for unfinished goals only', () => {
    const snapshot = makeSnapshot()
    const context = formatSessionGoalModelContext(snapshot)
    expect(context).toContain('[activeGoal] {"revision":3,"id":"goal-1"')
    expect(context).toContain('"remainingTokens":850')
    expect(context).not.toContain('createdAt')

    const combined = appendSessionGoalCompactionInstructions('Keep the user constraints.', snapshot)
    expect(combined).toContain('Keep the user constraints.')
    expect(combined).toContain('Preserve this active goal across compaction.')
    expect(formatSessionGoalModelContext({
      ...snapshot,
      goal: snapshot.goal ? { ...snapshot.goal, status: 'completed' } : null,
    })).toBeUndefined()
  })

  it('exposes three narrow tools and delegates each operation through the host', async () => {
    const snapshot = makeSnapshot()
    const host = {
      createGoal: vi.fn(async () => snapshot),
      getGoal: vi.fn(async () => snapshot),
      updateGoal: vi.fn(async () => snapshot),
    } as unknown as SwarmToolHost
    const tools = buildGoalTools(host, { agentId: 'session-1', role: 'manager' } as AgentDescriptor)

    expect(tools.map((tool) => tool.name)).toEqual(['create_goal', 'get_goal', 'update_goal'])
    await tools[0]!.execute('create-1', { objective: 'Ship it', tokenBudget: 500 })
    await tools[1]!.execute('get-1', {})
    await tools[2]!.execute('update-1', { status: 'complete' })

    expect(host.createGoal).toHaveBeenCalledWith(
      'session-1',
      'create-1',
      { objective: 'Ship it', tokenBudget: 500 },
    )
    expect(host.getGoal).toHaveBeenCalledWith('session-1')
    expect(host.updateGoal).toHaveBeenCalledWith('session-1', 'update-1', { status: 'complete' })
  })
})

function makeSnapshot(): SessionGoalSnapshot {
  return {
    revision: 3,
    measuredAt: '2026-07-13T10:00:30.000Z',
    goal: {
      id: 'goal-1',
      objective: 'Ship the result',
      status: 'active',
      createdAt: '2026-07-13T10:00:00.000Z',
      updatedAt: '2026-07-13T10:00:00.000Z',
      tokenBudget: 1_000,
      activeElapsedMs: 30_000,
      turnCount: 3,
      usage,
      usageCoverage: 'complete',
      remainingTokens: 850,
    },
  }
}

function readJsonl(raw: string): unknown[] {
  return raw.trim().split('\n').map((line) => JSON.parse(line))
}
