import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlanSummaryEvent, SessionPlanSnapshotEvent } from '@forge/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SessionPlanCoordinator,
  type SessionPlanOwner,
} from '../planning/session-plan-coordinator.js'
import { SessionPlanStore } from '../planning/session-plan-store.js'
import { getSessionPlanUsagePath } from '../storage/data-paths.js'

const tempDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all(Array.from(tempDirectories, (directory) => (
    rm(directory, { recursive: true, force: true })
  )))
  tempDirectories.clear()
})

describe('SessionPlanCoordinator', () => {
  it('owns normalized snapshots, model context, and the durable summary lifecycle', async () => {
    const harness = await createHarness()

    const started = await harness.coordinator.update(harness.owner, {
      explanation: '  Start with inspection.  ',
      plan: [{ step: '  Inspect behavior  ', status: 'in_progress' }],
    })

    expect(started).toMatchObject({
      input: {
        explanation: 'Start with inspection.',
        plan: [{ step: 'Inspect behavior', status: 'in_progress' }],
      },
      result: {
        sessionAgentId: 'session-1',
        revision: 1,
        explanation: 'Start with inspection.',
      },
    })
    expect(harness.snapshots).toMatchObject([{
      type: 'session_plan_snapshot',
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      revision: 1,
    }])
    expect(harness.timelineSummaries).toMatchObject([{
      state: 'active',
      revision: 1,
      plan: [{ step: 'Inspect behavior', status: 'in_progress' }],
    }])
    await expect(harness.coordinator.appendToManagerInput(harness.owner, 'Continue.'))
      .resolves.toContain('\n\n[workingPlan] {"revision":1')
    await expect(harness.coordinator.appendCompactionInstructions(
      harness.owner,
      'Preserve the user constraint.',
    )).resolves.toContain('[workingPlan] {"revision":1')

    await harness.coordinator.update(harness.owner, {
      explanation: 'Inspection verified.',
      plan: [{ step: 'Inspect behavior', status: 'completed' }],
    })

    expect(harness.timelineSummaries).toHaveLength(1)
    expect(harness.timelineSummaries[0]).toMatchObject({
      state: 'completed',
      revision: 2,
      explanation: 'Inspection verified.',
    })
    await expect(harness.coordinator.getSnapshot(harness.owner, 'request-1'))
      .resolves.toMatchObject({
        requestId: 'request-1',
        revision: 2,
        plan: [{ step: 'Inspect behavior', status: 'completed' }],
      })
  })

  it('serializes overlapping replacements into one new active summary', async () => {
    const harness = await createHarness()
    await harness.coordinator.update(harness.owner, {
      plan: [{ step: 'First plan', status: 'completed' }],
    })

    await Promise.all([
      harness.coordinator.update(harness.owner, {
        plan: [{ step: 'Second plan', status: 'in_progress' }],
      }),
      harness.coordinator.update(harness.owner, {
        plan: [{ step: 'Third plan', status: 'in_progress' }],
      }),
    ])

    expect(harness.timelineSummaries).toHaveLength(2)
    expect(harness.timelineSummaries[0]).toMatchObject({
      state: 'completed',
      revision: 1,
      plan: [{ step: 'First plan', status: 'completed' }],
    })
    expect(harness.timelineSummaries[1]).toMatchObject({
      state: 'active',
      revision: 2,
      plan: [{ step: 'Second plan', status: 'in_progress' }],
    })
    await expect(harness.coordinator.getSnapshot(harness.owner)).resolves.toMatchObject({
      revision: 3,
      plan: [{ step: 'Third plan', status: 'in_progress' }],
    })
  })

  it('coordinates worker assignments, clear accounting, and cache eviction', async () => {
    const harness = await createHarness()
    await harness.coordinator.update(harness.owner, {
      plan: [{ step: 'Implement backend', status: 'in_progress' }],
    })
    const assignment = await harness.coordinator.resolveAssignment(
      harness.owner,
      'Implement backend',
    )
    await harness.coordinator.recordWorkerAssignment(harness.owner, assignment, {
      workerId: 'worker-1',
      source: 'spawn_agent',
    })

    const externalStore = new SessionPlanStore({
      dataDir: harness.dataDir,
      profileId: harness.owner.profileId,
      sessionAgentId: harness.owner.agentId,
    })
    await externalStore.update({
      plan: [{ step: 'Changed outside the coordinator', status: 'in_progress' }],
    })
    await expect(harness.coordinator.getSnapshot(harness.owner)).resolves.toMatchObject({
      revision: 1,
      plan: [{ step: 'Implement backend', status: 'in_progress' }],
    })

    harness.coordinator.forget(harness.owner.agentId)
    await expect(harness.coordinator.getSnapshot(harness.owner)).resolves.toMatchObject({
      revision: 2,
      plan: [{ step: 'Changed outside the coordinator', status: 'in_progress' }],
    })
    await expect(harness.coordinator.clear(harness.owner)).resolves.toMatchObject({
      revision: 3,
      plan: [],
    })

    const records = await readJsonl(
      getSessionPlanUsagePath(harness.dataDir, harness.owner.profileId, harness.owner.agentId),
    )
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'worker_assigned',
        workerId: 'worker-1',
        step: 'Implement backend',
      }),
      expect.objectContaining({ type: 'plan_abandoned', planRevision: 3 }),
    ]))
  })

  it('preloads persisted state and finalizes pending completion as recovered', async () => {
    const first = await createHarness()
    await first.coordinator.update(first.owner, {
      plan: [{ step: 'Recover completion', status: 'in_progress' }],
    })
    await first.coordinator.update(first.owner, {
      plan: [{ step: 'Recover completion', status: 'completed' }],
    })

    const rebooted = await createHarness(first.dataDir)
    await rebooted.coordinator.preload([rebooted.owner])

    await expect(rebooted.coordinator.getSnapshot(rebooted.owner)).resolves.toMatchObject({
      revision: 2,
      plan: [{ step: 'Recover completion', status: 'completed' }],
    })
    const records = await readJsonl(
      getSessionPlanUsagePath(first.dataDir, first.owner.profileId, first.owner.agentId),
    )
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'plan_completed',
        coverageReasons: expect.arrayContaining(['recovered_completion']),
      }),
    ]))
    expect(rebooted.logDebug).not.toHaveBeenCalled()
  })
})

async function createHarness(existingDataDir?: string): Promise<{
  coordinator: SessionPlanCoordinator
  dataDir: string
  owner: SessionPlanOwner
  timelineSummaries: PlanSummaryEvent[]
  snapshots: SessionPlanSnapshotEvent[]
  logDebug: ReturnType<typeof vi.fn>
}> {
  const dataDir = existingDataDir ?? await mkdtemp(join(tmpdir(), 'forge-plan-coordinator-'))
  tempDirectories.add(dataDir)
  const owner = { agentId: 'session-1', profileId: 'profile-1' }
  const timelineSummaries: PlanSummaryEvent[] = []
  const snapshots: SessionPlanSnapshotEvent[] = []
  const logDebug = vi.fn()
  const coordinator = new SessionPlanCoordinator({
    dataDir,
    now: () => new Date().toISOString(),
    getPlanSummaries: () => timelineSummaries,
    emitPlanSummary: (event) => {
      const existingIndex = timelineSummaries.findIndex((current) => current.id === event.id)
      if (existingIndex >= 0) {
        timelineSummaries[existingIndex] = event
      } else {
        timelineSummaries.push(event)
      }
    },
    emitSnapshot: (event) => snapshots.push(event),
    logDebug,
  })
  return { coordinator, dataDir, owner, timelineSummaries, snapshots, logDebug }
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
