import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildUpdatePlanTool } from '../planning/update-plan-tool.js'
import { shouldCreateCompletedPlanSummary } from '../planning/plan-summary.js'
import {
  appendSessionPlanCompactionInstructions,
  formatSessionPlanModelContext,
} from '../planning/session-plan-context.js'
import {
  normalizeSessionPlanInput,
} from '../planning/session-plan-state.js'
import { SessionPlanStore } from '../planning/session-plan-store.js'
import { getSessionPlanHistoryPath, getSessionPlanPath } from '../storage/data-paths.js'
import type { SwarmToolHost } from '../swarm-tool-host.js'
import type { AgentDescriptor } from '../types.js'

describe('Codex-style session plans', () => {
  it('normalizes a full plan and supports parallel in-progress steps', () => {
    expect(normalizeSessionPlanInput({
      explanation: '  Narrowed after inspection.  ',
      plan: [
        { step: '  Inspect behavior  ', status: 'completed' },
        { step: 'Implement fix', status: 'in_progress' },
      ],
    })).toEqual({
      explanation: 'Narrowed after inspection.',
      plan: [
        { step: 'Inspect behavior', status: 'completed' },
        { step: 'Implement fix', status: 'in_progress' },
      ],
    })

    expect(normalizeSessionPlanInput({
      plan: [
        { step: 'First', status: 'in_progress' },
        { step: 'Second', status: 'in_progress' },
      ],
    })).toEqual({
      plan: [
        { step: 'First', status: 'in_progress' },
        { step: 'Second', status: 'in_progress' },
      ],
    })
  })

  it('normalizes stable ids and rejects duplicate or malformed ids', () => {
    expect(normalizeSessionPlanInput({
      plan: [{ id: ' inspect_step ', step: 'Inspect', status: 'in_progress' }],
    })).toEqual({
      plan: [{ id: 'inspect_step', step: 'Inspect', status: 'in_progress' }],
    })
    expect(() => normalizeSessionPlanInput({
      plan: [
        { id: 'same', step: 'First', status: 'pending' },
        { id: 'same', step: 'Second', status: 'pending' },
      ],
    })).toThrow('plan step ids must be unique')
    expect(() => normalizeSessionPlanInput({
      plan: [{ id: 'Not Valid', step: 'Inspect', status: 'pending' }],
    })).toThrow('must use lowercase letters')
  })

  it('creates a summary only when a completed snapshot is actually replaced', () => {
    const completed = {
      schemaVersion: 1 as const,
      revision: 2,
      updatedAt: '2026-07-13T00:00:00.000Z',
      explanation: 'Done.',
      plan: [{ step: 'Finish the work', status: 'completed' as const }],
    }

    expect(shouldCreateCompletedPlanSummary(completed, completed.plan)).toBe(false)
    expect(shouldCreateCompletedPlanSummary(completed, [
      { step: 'Start the next plan', status: 'in_progress' },
    ])).toBe(true)
    expect(shouldCreateCompletedPlanSummary(completed, [])).toBe(true)
    expect(shouldCreateCompletedPlanSummary({
      ...completed,
      plan: [{ step: 'Finish the work', status: 'in_progress' }],
    }, [
      { step: 'Start the next plan', status: 'in_progress' },
    ])).toBe(false)
  })

  it('persists atomic snapshots and increments the revision', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-plan-'))
    const store = new SessionPlanStore({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    })

    expect(await store.load()).toMatchObject({ revision: 0, updatedAt: null, plan: [] })
    await store.update({ plan: [{ step: 'Inspect', status: 'in_progress' }] })
    const updated = await store.update({
      explanation: 'Inspection complete.',
      plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Implement', status: 'in_progress' },
      ],
    })

    expect(updated).toMatchObject({ revision: 2, explanation: 'Inspection complete.' })
    expect(JSON.parse(await readFile(getSessionPlanPath(dataDir, 'profile-1', 'session-1'), 'utf8'))).toEqual(updated)
    await store.clear()
    expect(readJsonl(await readFile(
      getSessionPlanHistoryPath(dataDir, 'profile-1', 'session-1'),
      'utf8',
    ))).toEqual([
      {
        schemaVersion: 1,
        revision: 1,
        updatedAt: '2026-07-12T00:00:00.000Z',
        plan: [{ step: 'Inspect', status: 'in_progress' }],
      },
      updated,
    ])
  })

  it('backs up malformed state and safely returns an empty plan', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-plan-corrupt-'))
    const path = getSessionPlanPath(dataDir, 'profile-1', 'session-1')
    const store = new SessionPlanStore({ dataDir, profileId: 'profile-1', sessionAgentId: 'session-1' })
    await store.update({ plan: [] })
    await writeFile(path, '{broken', 'utf8')

    await expect(store.load()).resolves.toMatchObject({ revision: 0, plan: [] })
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('backs up a structurally invalid persisted work graph', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-plan-corrupt-graph-'))
    const path = getSessionPlanPath(dataDir, 'profile-1', 'session-1')
    const store = new SessionPlanStore({ dataDir, profileId: 'profile-1', sessionAgentId: 'session-1' })
    await store.update({ plan: [] })
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      updatedAt: '2026-07-18T12:00:00.000Z',
      coordinationMode: 'graph',
      plan: [],
      workGraph: { maxConcurrency: 4, nodes: [] },
    }), 'utf8')

    await expect(store.load()).resolves.toMatchObject({ revision: 0, plan: [] })
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes clear after an in-flight update and preserves monotonic revisions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-plan-clear-'))
    const store = new SessionPlanStore({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    })

    const update = store.update({ plan: [{ step: 'Inspect', status: 'in_progress' }] })
    const clear = store.clear()

    await expect(update).resolves.toMatchObject({ revision: 1 })
    await expect(clear).resolves.toMatchObject({ revision: 2, plan: [] })
    await expect(store.load()).resolves.toMatchObject({ revision: 2, plan: [] })
    expect(readJsonl(await readFile(store.historyFilePath, 'utf8'))).toEqual([{
      schemaVersion: 1,
      revision: 1,
      updatedAt: '2026-07-12T00:00:00.000Z',
      plan: [{ step: 'Inspect', status: 'in_progress' }],
    }])
  })

  it('returns the exact outgoing snapshot from inside the serialized update', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-plan-outgoing-'))
    const store = new SessionPlanStore({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    })

    await store.update({ plan: [{ step: 'First plan', status: 'completed' }] })
    const first = store.updateWithOutgoingState({
      plan: [{ step: 'Second plan', status: 'in_progress' }],
    })
    const second = store.updateWithOutgoingState({
      plan: [{ step: 'Third plan', status: 'in_progress' }],
    })

    await expect(first).resolves.toMatchObject({
      outgoing: { revision: 1, plan: [{ step: 'First plan', status: 'completed' }] },
      snapshot: { revision: 2, plan: [{ step: 'Second plan', status: 'in_progress' }] },
    })
    await expect(second).resolves.toMatchObject({
      outgoing: { revision: 2, plan: [{ step: 'Second plan', status: 'in_progress' }] },
      snapshot: { revision: 3, plan: [{ step: 'Third plan', status: 'in_progress' }] },
    })
  })

  it('keeps the current plan unchanged when history archival fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-plan-history-failure-'))
    const appendHistory = vi.fn(async () => { throw new Error('history unavailable') })
    const store = new SessionPlanStore({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      appendHistory,
    })

    await store.update({ plan: [{ step: 'Preserve me', status: 'in_progress' }] })
    await expect(store.update({ plan: [{ step: 'Replace me', status: 'in_progress' }] }))
      .rejects.toThrow('history unavailable')

    expect(appendHistory).toHaveBeenCalledWith(store.historyFilePath, expect.objectContaining({
      revision: 1,
      plan: [{ step: 'Preserve me', status: 'in_progress' }],
    }))
    await expect(store.load()).resolves.toMatchObject({
      revision: 1,
      plan: [{ step: 'Preserve me', status: 'in_progress' }],
    })
  })

  it('formats a bounded authoritative model context block', () => {
    const context = formatSessionPlanModelContext({
      revision: 7,
      updatedAt: '2026-07-12T00:00:00.000Z',
      explanation: 'Recovered after compaction.',
      plan: [{ step: 'Continue verification', status: 'in_progress' }],
    })

    expect(context).toBe(
      '[workingPlan] {"revision":7,"explanation":"Recovered after compaction.","plan":[{"step":"Continue verification","status":"in_progress"}]}',
    )
    expect(context).not.toContain('updatedAt')
  })

  it('adds the current plan to compaction instructions without duplication', () => {
    const snapshot = {
      revision: 7,
      updatedAt: '2026-07-12T00:00:00.000Z',
      plan: [{ step: 'Continue verification', status: 'in_progress' as const }],
    }
    const combined = appendSessionPlanCompactionInstructions('Preserve user constraints.', snapshot)

    expect(combined).toContain('Preserve user constraints.')
    expect(combined).toContain('[workingPlan] {"revision":7')
    expect(appendSessionPlanCompactionInstructions(combined, snapshot)).toBe(combined)
  })

  it('exposes the same narrow schema and delegates updates through the host', async () => {
    const updatePlan = vi.fn(async (_agentId, _toolCallId, input) => ({
      sessionAgentId: 'session-1',
      revision: 1,
      updatedAt: '2026-07-12T00:00:00.000Z',
      ...input,
    }))
    const tool = buildUpdatePlanTool({ updatePlan } as unknown as SwarmToolHost, {
      agentId: 'session-1',
      role: 'manager',
    } as AgentDescriptor)
    const input = { plan: [{ step: 'Verify', status: 'in_progress' as const }] }

    const result = await tool.execute('tool-call-1', input)

    expect(tool.name).toBe('update_plan')
    expect(updatePlan).toHaveBeenCalledWith('session-1', 'tool-call-1', input)
    expect(result.details).toMatchObject({ revision: 1, plan: input.plan })
  })
})

function readJsonl(raw: string): unknown[] {
  return raw.trim().split('\n').map((line) => JSON.parse(line))
}
