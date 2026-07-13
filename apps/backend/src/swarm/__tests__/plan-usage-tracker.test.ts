import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SessionPlanUsageTracker,
  type PlanStepAssignment,
} from '../planning/plan-usage-tracker.js'
import type { SessionPlanState } from '../planning/session-plan-state.js'
import {
  getSessionFilePath,
  getSessionPlanUsagePath,
  getWorkerSessionFilePath,
} from '../storage/data-paths.js'

describe('plan token usage accounting', () => {
  it('attributes parallel worker usage by step and includes the manager completion turn', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-plan-usage-'))
    let now = '2026-07-13T00:00:00.000Z'
    const tracker = new SessionPlanUsageTracker({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => now,
      randomId: () => 'run-1',
    })
    const empty = state(0, null, [])
    const active = state(1, now, [
      { step: 'Implement backend', status: 'in_progress' },
      { step: 'Build UI', status: 'in_progress' },
    ])
    await tracker.recordPlanTransition(empty, active)

    now = '2026-07-13T00:00:10.000Z'
    const backend = await tracker.resolveAssignment(active, 'Implement backend')
    await tracker.recordWorkerAssignment({
      ...backend,
      workerId: 'backend-worker',
      source: 'spawn_agent',
    })
    now = '2026-07-13T00:00:20.000Z'
    const ui = await tracker.resolveAssignment(active, 'Build UI')
    await tracker.recordWorkerAssignment({
      ...ui,
      workerId: 'ui-worker',
      source: 'spawn_agent',
    })
    now = '2026-07-13T00:00:30.000Z'
    await tracker.recordWorkerAssignment({
      ...backend,
      workerId: 'backend-worker',
      source: 'send_message_to_agent',
      deliveryId: 'same-step-follow-up',
      acceptedMode: 'steer',
    })

    await writeUsageFile(
      getWorkerSessionFilePath(dataDir, 'profile-1', 'session-1', 'backend-worker'),
      [usageMessage('2026-07-13T00:01:00.000Z', 10, 5)],
    )
    await writeUsageFile(
      getWorkerSessionFilePath(dataDir, 'profile-1', 'session-1', 'ui-worker'),
      [usageMessage('2026-07-13T00:01:30.000Z', 20, 7)],
    )
    await writeUsageFile(
      getSessionFilePath(dataDir, 'profile-1', 'session-1'),
      [
        usageMessage('2026-07-13T00:00:05.000Z', 30, 3),
        usageMessage('2026-07-13T00:02:30.000Z', 40, 4),
      ],
    )

    now = '2026-07-13T00:02:00.000Z'
    const completed = state(2, now, [
      { step: 'Implement backend', status: 'completed' },
      { step: 'Build UI', status: 'completed' },
    ])
    await tracker.recordPlanTransition(active, completed)
    now = '2026-07-13T00:03:00.000Z'
    await tracker.finalizePendingPlan()

    const records = await readRecords(
      getSessionPlanUsagePath(dataDir, 'profile-1', 'session-1'),
    )
    const stepReceipts = records.filter((record) => record.type === 'step_completed')
    expect(stepReceipts).toHaveLength(2)
    expect(stepReceipts.map((record) => ({ step: record.step, total: record.usage.total })))
      .toEqual([
        { step: 'Implement backend', total: 15 },
        { step: 'Build UI', total: 27 },
      ])

    const receipt = records.find((record) => record.type === 'plan_completed')
    expect(receipt).toMatchObject({
      planRunId: 'run-1',
      completedAt: '2026-07-13T00:02:00.000Z',
      accountedThrough: '2026-07-13T00:03:00.000Z',
      managerUsage: { input: 70, output: 7, total: 77 },
      workerUsage: { input: 30, output: 12, total: 42 },
      totalUsage: { input: 100, output: 19, total: 119 },
      unassignedWorkerUsage: { total: 0 },
      coverage: 'complete',
      coverageReasons: [],
    })
    expect(receipt.steps.map((step: { step: string; usage: { total: number } }) => ({
      step: step.step,
      total: step.usage.total,
    }))).toEqual([
      { step: 'Implement backend', total: 15 },
      { step: 'Build UI', total: 27 },
    ])
  })

  it('starts a new assignment period on follow-up messaging and labels busy delivery estimates', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-plan-reassign-'))
    let now = '2026-07-13T00:00:00.000Z'
    const tracker = new SessionPlanUsageTracker({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => now,
      randomId: () => 'run-2',
    })
    const empty = state(0, null, [])
    const active = state(1, now, [
      { step: 'First step', status: 'in_progress' },
      { step: 'Second step', status: 'in_progress' },
    ])
    await tracker.recordPlanTransition(empty, active)

    now = '2026-07-13T00:00:05.000Z'
    const first = await tracker.resolveAssignment(active, 'First step')
    await recordAssignment(tracker, first, 'worker-1')
    now = '2026-07-13T00:01:05.000Z'
    const second = await tracker.resolveAssignment(active, 'Second step')
    await tracker.recordWorkerAssignment({
      ...second,
      workerId: 'worker-1',
      source: 'send_message_to_agent',
      deliveryId: 'delivery-1',
      acceptedMode: 'steer',
    })

    await writeUsageFile(
      getWorkerSessionFilePath(dataDir, 'profile-1', 'session-1', 'worker-1'),
      [
        usageMessage('2026-07-13T00:01:00.000Z', 8, 2),
        usageMessage('2026-07-13T00:02:00.000Z', 12, 3),
      ],
    )
    now = '2026-07-13T00:03:00.000Z'
    await tracker.recordPlanTransition(active, state(2, now, [
      { step: 'First step', status: 'completed' },
      { step: 'Second step', status: 'completed' },
    ]))
    await tracker.finalizePendingPlan()

    const records = await readRecords(tracker.filePath)
    const receipt = records.find((record) => record.type === 'plan_completed')
    expect(receipt.coverage).toBe('estimated')
    expect(receipt.coverageReasons).toEqual(['busy_assignment_boundary'])
    expect(receipt.steps.map((step: { usage: { total: number } }) => step.usage.total))
      .toEqual([10, 15])
  })

  it('requires exact, non-completed current plan text for an assignment', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-plan-validate-'))
    const tracker = new SessionPlanUsageTracker({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      randomId: () => 'run-3',
    })
    const current = state(1, '2026-07-13T00:00:00.000Z', [
      { step: 'Already done', status: 'completed' },
      { step: 'Exact active text', status: 'in_progress' },
    ])

    await expect(tracker.resolveAssignment(current, 'Different text'))
      .rejects.toThrow('must exactly match a current plan step')
    await expect(tracker.resolveAssignment(current, 'Already done'))
      .rejects.toThrow('cannot reference a completed plan step')
  })

  it('closes an incomplete accounting run when the plan is cleared', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-plan-clear-'))
    const tracker = new SessionPlanUsageTracker({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      randomId: () => 'run-4',
    })
    const active = state(1, '2026-07-13T00:00:00.000Z', [
      { step: 'Unfinished work', status: 'in_progress' },
    ])
    await tracker.recordPlanTransition(state(0, null, []), active)
    await tracker.recordPlanTransition(active, state(2, '2026-07-13T00:01:00.000Z', []))

    const records = await readRecords(tracker.filePath)
    expect(records.filter((record) => record.type === 'plan_abandoned')).toHaveLength(1)
    expect(records.filter((record) => record.type === 'plan_completed')).toHaveLength(0)
  })

  it('retains unassociated worker usage with worker identity and partial coverage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-plan-unassigned-'))
    let now = '2026-07-13T00:00:00.000Z'
    const tracker = new SessionPlanUsageTracker({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => now,
      randomId: () => 'run-5',
    })
    const active = state(1, now, [{ step: 'Tracked work', status: 'in_progress' }])
    await tracker.recordPlanTransition(state(0, null, []), active)
    await writeUsageFile(
      getWorkerSessionFilePath(dataDir, 'profile-1', 'session-1', 'unassigned-worker'),
      [usageMessage('2026-07-13T00:01:00.000Z', 9, 4)],
    )
    now = '2026-07-13T00:02:00.000Z'
    await tracker.recordPlanTransition(active, state(2, now, [
      { step: 'Tracked work', status: 'completed' },
    ]))
    await tracker.finalizePendingPlan()

    const receipt = (await readRecords(tracker.filePath))
      .find((record) => record.type === 'plan_completed')
    expect(receipt).toMatchObject({
      coverage: 'partial',
      coverageReasons: ['unassigned_worker_usage'],
      unassignedWorkerUsage: { total: 13 },
      unassignedWorkers: [{ workerId: 'unassigned-worker', usage: { total: 13 } }],
    })
  })

  it('finalizes a durable pending completion after restart with honest recovery coverage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-plan-recovery-'))
    let now = '2026-07-13T00:00:00.000Z'
    const tracker = new SessionPlanUsageTracker({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => now,
      randomId: () => 'run-6',
    })
    const active = state(1, now, [{ step: 'Recover completion', status: 'in_progress' }])
    await tracker.recordPlanTransition(state(0, null, []), active)
    now = '2026-07-13T00:01:00.000Z'
    await tracker.recordPlanTransition(active, state(2, now, [
      { step: 'Recover completion', status: 'completed' },
    ]))

    const rebooted = new SessionPlanUsageTracker({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => '2026-07-13T00:02:00.000Z',
    })
    await rebooted.finalizePendingPlan({ recovered: true })

    const receipt = (await readRecords(tracker.filePath))
      .find((record) => record.type === 'plan_completed')
    expect(receipt).toMatchObject({
      coverage: 'partial',
      coverageReasons: ['recovered_completion'],
      accountedThrough: '2026-07-13T00:01:00.000Z',
    })
  })

  it('does not absorb a later turn when a plan completion is finalized late', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-plan-delayed-completion-'))
    let now = '2026-07-13T00:00:00.000Z'
    const tracker = new SessionPlanUsageTracker({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => now,
      randomId: () => 'run-delayed',
    })
    const active = state(1, now, [{ step: 'Finish this turn', status: 'in_progress' }])
    await tracker.recordPlanTransition(state(0, null, []), active)
    await writeUsageFile(getSessionFilePath(dataDir, 'profile-1', 'session-1'), [
      usageMessage('2026-07-13T00:00:30.000Z', 10, 1),
      usageMessage('2026-07-13T00:02:00.000Z', 20, 2),
    ])
    now = '2026-07-13T00:01:00.000Z'
    const completed = state(2, now, [{ step: 'Finish this turn', status: 'completed' }])
    await tracker.recordPlanTransition(active, completed)

    now = '2026-07-13T00:03:00.000Z'
    await tracker.recordPlanTransition(completed, state(3, now, [
      { step: 'Start a later plan', status: 'in_progress' },
    ]))

    const receipt = (await readRecords(tracker.filePath))
      .find((record) => record.type === 'plan_completed')
    expect(receipt).toMatchObject({
      accountedThrough: '2026-07-13T00:01:00.000Z',
      managerUsage: { total: 11 },
      coverage: 'partial',
      coverageReasons: ['delayed_completion'],
    })
  })
})

function state(
  revision: number,
  updatedAt: string | null,
  plan: SessionPlanState['plan'],
): SessionPlanState {
  return { schemaVersion: 1, revision, updatedAt, plan }
}

async function recordAssignment(
  tracker: SessionPlanUsageTracker,
  assignment: PlanStepAssignment,
  workerId: string,
): Promise<void> {
  await tracker.recordWorkerAssignment({
    ...assignment,
    workerId,
    source: 'spawn_agent',
  })
}

function usageMessage(timestamp: string, input: number, output: number): unknown {
  return {
    type: 'message',
    timestamp,
    message: {
      role: 'assistant',
      usage: { input, output, totalTokens: input + output },
    },
  }
}

async function writeUsageFile(filePath: string, entries: unknown[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
}

async function readRecords(filePath: string): Promise<any[]> {
  return (await readFile(filePath, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
}
