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
        plan: [{
          id: expect.stringMatching(/^step-/),
          step: 'Inspect behavior',
          status: 'in_progress',
        }],
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

    const stepId = started.result.plan[0]?.id
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
        plan: [{ id: stepId, step: 'Inspect behavior', status: 'completed' }],
      })
  })

  it('enriches qualified attention from only current-epoch plan and graph state', async () => {
    const harness = await createHarness()
    const completedPlan = await harness.coordinator.update(harness.owner, {
      plan: [{ step: 'Finish the work', status: 'completed' }],
    })
    const planUpdatedAt = completedPlan.result.updatedAt!

    await expect(harness.coordinator.getAttentionReason({
      sessionAgentId: harness.owner.agentId,
      profileId: harness.owner.profileId,
      workStartedAt: planUpdatedAt,
    })).resolves.toBe('plan_completed')
    await expect(harness.coordinator.getAttentionReason({
      sessionAgentId: harness.owner.agentId,
      profileId: harness.owner.profileId,
      workStartedAt: '2100-01-01T00:00:00.000Z',
    })).resolves.toBeUndefined()

    const waiting = await harness.coordinator.updateWorkGraph(harness.owner, {
      nodes: [{
        id: 'decision',
        title: 'Choose rollout',
        task: 'Choose the rollout.',
        kind: 'decision',
        status: 'waiting',
      }],
    })
    await expect(harness.coordinator.getAttentionReason({
      sessionAgentId: harness.owner.agentId,
      profileId: harness.owner.profileId,
      workStartedAt: waiting.snapshot.workGraph!.nodes[0]!.statusUpdatedAt!,
    })).resolves.toBe('decision_waiting')

    await harness.coordinator.updateWorkGraph(harness.owner, {
      nodes: [{
        id: 'review',
        title: 'Review implementation',
        task: 'Review the implementation.',
        kind: 'review',
        status: 'pending',
      }],
    })
    const [claim] = await harness.coordinator.claimReadyWorkGraphNodes(harness.owner)
    await harness.coordinator.recordWorkGraphWorkerStarted(
      harness.owner,
      'review',
      claim!.attemptId,
      'review-worker',
    )
    await harness.coordinator.recordWorkGraphWorkerResult(
      harness.owner,
      'review-worker',
      'status: done\nsummary: reviewed',
    )
    const review = await harness.coordinator.getSnapshot(harness.owner)
    await expect(harness.coordinator.getAttentionReason({
      sessionAgentId: harness.owner.agentId,
      profileId: harness.owner.profileId,
      workStartedAt: review.workGraph!.nodes[0]!.statusUpdatedAt!,
    })).resolves.toBe('awaiting_review')

    const graphCompleted = await harness.coordinator.acceptWorkGraphNode(harness.owner, 'review')
    await expect(harness.coordinator.getAttentionReason({
      sessionAgentId: harness.owner.agentId,
      profileId: harness.owner.profileId,
      workStartedAt: graphCompleted.snapshot.workGraph!.nodes[0]!.statusUpdatedAt!,
    })).resolves.toBe('work_graph_completed')
  })

  it('does not reuse a stale waiting node after an unrelated current-epoch graph update', async () => {
    let now = '2026-08-04T12:00:00.000Z'
    const harness = await createHarness(undefined, undefined, () => now)
    await harness.coordinator.updateWorkGraph(harness.owner, {
      nodes: [
        {
          id: 'old-decision',
          title: 'Old decision',
          task: 'This was already waiting before work began.',
          kind: 'decision',
          status: 'waiting',
        },
        {
          id: 'current-task',
          title: 'Current task',
          task: 'Change this during the current epoch.',
          status: 'pending',
        },
      ],
    })

    const workStartedAt = '2026-08-04T12:00:00.500Z'
    now = '2026-08-04T12:00:01.000Z'
    await harness.coordinator.updateWorkGraph(harness.owner, {
      nodes: [
        {
          id: 'old-decision',
          title: 'Old decision',
          task: 'This was already waiting before work began.',
          kind: 'decision',
          status: 'waiting',
        },
        {
          id: 'current-task',
          title: 'Current task',
          task: 'Change this during the current epoch.',
          status: 'cancelled',
        },
      ],
    })

    await expect(harness.coordinator.getAttentionReason({
      sessionAgentId: harness.owner.agentId,
      profileId: harness.owner.profileId,
      workStartedAt,
    })).resolves.toBeUndefined()
  })

  it('keeps one durable graph-card identity when saturated history evicts the active anchor', async () => {
    const harness = await createHarness()
    const graphNode = {
      id: 'saturated-graph',
      title: 'Saturated graph node',
      task: 'Preserve this graph across saturated history.',
      kind: 'implementation' as const,
      status: 'pending' as const,
    }
    await harness.coordinator.updateWorkGraph(harness.owner, { nodes: [graphNode] })
    const authoritativeId = harness.timelineSummaries[0]!.id

    // Model the 2,000-entry history cap evicting the transcript projection. The
    // identity must come from durable plan state, not the evictable row.
    harness.timelineSummaries.splice(0)
    await harness.coordinator.updateWorkGraph(harness.owner, {
      explanation: 'Revision after saturation.',
      nodes: [graphNode],
    })
    await harness.coordinator.updateWorkGraph(harness.owner, {
      explanation: 'Another revision of the same graph.',
      nodes: [graphNode],
    })

    expect(harness.timelineSummaries).toHaveLength(1)
    expect(harness.timelineSummaries[0]).toMatchObject({
      id: authoritativeId,
      state: 'active',
      revision: 2,
      coordinationMode: 'graph',
      workGraph: { nodes: [{ id: 'saturated-graph' }] },
    })

    const rebooted = await createHarness(harness.dataDir)
    await rebooted.coordinator.preload([rebooted.owner])
    await rebooted.coordinator.updateWorkGraph(rebooted.owner, {
      nodes: [{ ...graphNode, status: 'completed' }],
    })
    expect(rebooted.timelineSummaries).toEqual([
      expect.objectContaining({
        id: authoritativeId,
        state: 'completed',
        revision: 4,
        coordinationMode: 'graph',
      }),
    ])
  })

  it('preserves explicit ids across renamed checklist steps', async () => {
    const harness = await createHarness()
    const started = await harness.coordinator.update(harness.owner, {
      plan: [{ step: 'Inspect behavior', status: 'in_progress' }],
    })
    const id = started.result.plan[0]?.id
    expect(id).toMatch(/^step-/)

    const revised = await harness.coordinator.update(harness.owner, {
      plan: [{ id, step: 'Inspect and verify behavior', status: 'completed' }],
    })

    expect(revised.result.plan).toEqual([{
      id,
      step: 'Inspect and verify behavior',
      status: 'completed',
    }])
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

  it('blocks a persisted running graph when its assigned worker is no longer active', async () => {
    const first = await createHarness()
    await first.coordinator.updateWorkGraph(first.owner, {
      nodes: [{
        id: 'validate',
        title: 'Run final validation',
        task: 'Run the final validation suite.',
        kind: 'review',
        status: 'pending',
      }],
    })
    const claims = await first.coordinator.claimReadyWorkGraphNodes(first.owner)
    await first.coordinator.recordWorkGraphWorkerStarted(
      first.owner,
      'validate',
      claims[0]!.attemptId,
      'validation-worker',
    )

    const rebooted = await createHarness(first.dataDir, () => false)
    await rebooted.coordinator.preload([rebooted.owner])

    await expect(rebooted.coordinator.getSnapshot(rebooted.owner)).resolves.toMatchObject({
      revision: 4,
      plan: [{ step: 'Run final validation', status: 'pending' }],
      workGraph: { nodes: [{
        id: 'validate',
        status: 'blocked',
        attempts: [{
          status: 'blocked',
          workerId: 'validation-worker',
          summary: expect.stringContaining('worker stopped'),
        }],
      }] },
    })
  })

  it('persists one graph-backed plan through dispatch, result review, acceptance, and fan-in release', async () => {
    const harness = await createHarness()
    const created = await harness.coordinator.updateWorkGraph(harness.owner, {
      explanation: 'Parallel evidence before synthesis.',
      maxConcurrency: 2,
      nodes: [
        {
          id: 'research',
          title: 'Research current behavior',
          task: 'Inspect current behavior and return evidence.',
          kind: 'research',
          status: 'pending',
          acceptanceCriteria: 'Evidence cites the inspected path.',
        },
        {
          id: 'synthesize',
          title: 'Synthesize the recommendation',
          task: 'Synthesize the accepted evidence.',
          kind: 'synthesis',
          status: 'pending',
          dependsOn: ['research'],
        },
      ],
    })
    expect(created.snapshot).toMatchObject({
      coordinationMode: 'graph',
      workGraph: { maxConcurrency: 2 },
      plan: [
        { step: 'Research current behavior', status: 'pending' },
        { step: 'Synthesize the recommendation', status: 'pending' },
      ],
    })

    const claims = await harness.coordinator.claimReadyWorkGraphNodes(harness.owner)
    expect(claims).toMatchObject([{
      nodeId: 'research',
      behaviorMode: 'research',
      requestedRoute: 'auto',
    }])
    await harness.coordinator.recordWorkGraphWorkerStarted(
      harness.owner,
      'research',
      claims[0]!.attemptId,
      'research-worker',
      {
        model: {
          provider: 'openai-codex',
          modelId: 'gpt-5.6-terra',
          thinkingLevel: 'medium',
        },
      },
    )
    await harness.coordinator.recordWorkGraphWorkerModelReroute(
      harness.owner,
      'research-worker',
      {
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-20250514',
        thinkingLevel: 'high',
      },
    )
    const reroutedSnapshot = await harness.coordinator.getSnapshot(harness.owner)
    expect(reroutedSnapshot.workGraph?.nodes.find((node) => node.id === 'research'))
      .toMatchObject({
        attempts: [{
          workerId: 'research-worker',
          model: {
            provider: 'anthropic',
            modelId: 'claude-sonnet-4-20250514',
            thinkingLevel: 'high',
          },
        }],
      })
    await expect(harness.coordinator.recordWorkGraphWorkerResult(
      harness.owner,
      'research-worker',
      'status: done\nsummary: inspected evidence',
    )).resolves.toBe('research')
    await expect(harness.coordinator.getSnapshot(harness.owner)).resolves.toMatchObject({
      workGraph: { nodes: [
        { id: 'research', status: 'awaiting_review' },
        { id: 'synthesize', status: 'pending' },
      ] },
    })
    await expect(harness.coordinator.claimReadyWorkGraphNodes(harness.owner)).resolves.toEqual([])

    const accepted = await harness.coordinator.acceptWorkGraphNode(
      harness.owner,
      'research',
    )
    expect(accepted).toMatchObject({
      nodeId: 'research',
      alreadyAccepted: false,
      snapshot: {
        revision: 6,
        workGraph: { nodes: [
          {
            id: 'research',
            status: 'completed',
            task: 'Inspect current behavior and return evidence.',
            acceptanceCriteria: 'Evidence cites the inspected path.',
            attempts: [{ workerId: 'research-worker', status: 'succeeded' }],
          },
          { id: 'synthesize', status: 'pending', dependsOn: ['research'] },
        ] },
      },
    })
    const repeated = await harness.coordinator.acceptWorkGraphNode(
      harness.owner,
      'research',
    )
    expect(repeated.alreadyAccepted).toBe(true)
    expect(repeated.snapshot.revision).toBe(6)
    const synthesis = await harness.coordinator.claimReadyWorkGraphNodes(harness.owner)
    expect(synthesis.map((claim) => claim.nodeId)).toEqual(['synthesize'])

    harness.coordinator.forget(harness.owner.agentId)
    await expect(harness.coordinator.getSnapshot(harness.owner)).resolves.toMatchObject({
      coordinationMode: 'graph',
      workGraph: { nodes: [
        { id: 'research', status: 'completed', attempts: [{ workerId: 'research-worker' }] },
        { id: 'synthesize', status: 'running' },
      ] },
    })
  })

  it('serializes concurrent graph lifecycle updates without losing a worker result', async () => {
    const harness = await createHarness()
    await harness.coordinator.updateWorkGraph(harness.owner, {
      maxConcurrency: 2,
      nodes: [
        {
          id: 'first',
          title: 'Inspect first source',
          task: 'Return the first evidence set.',
          kind: 'research',
          status: 'pending',
        },
        {
          id: 'second',
          title: 'Inspect second source',
          task: 'Return the second evidence set.',
          kind: 'research',
          status: 'pending',
        },
      ],
    })
    const claims = await harness.coordinator.claimReadyWorkGraphNodes(harness.owner)
    await Promise.all(claims.map((claim, index) => (
      harness.coordinator.recordWorkGraphWorkerStarted(
        harness.owner,
        claim.nodeId,
        claim.attemptId,
        `worker-${index + 1}`,
      )
    )))
    await Promise.all(claims.map((_, index) => (
      harness.coordinator.recordWorkGraphWorkerResult(
        harness.owner,
        `worker-${index + 1}`,
        `status: done\nsummary: evidence ${index + 1}`,
      )
    )))

    const snapshot = await harness.coordinator.getSnapshot(harness.owner)
    expect(snapshot.workGraph?.nodes).toMatchObject([
      { id: 'first', status: 'awaiting_review', attempts: [{ workerId: 'worker-1' }] },
      { id: 'second', status: 'awaiting_review', attempts: [{ workerId: 'worker-2' }] },
    ])
  })

  it('reloads a graph whose projection exceeds the light-plan step limit', async () => {
    const harness = await createHarness()
    const nodes = Array.from({ length: 21 }, (_, index) => ({
      id: `node-${index + 1}`,
      title: `Graph node ${index + 1}`,
      task: `Complete graph node ${index + 1}.`,
      status: 'pending' as const,
    }))
    await harness.coordinator.updateWorkGraph(harness.owner, { nodes })

    harness.coordinator.forget(harness.owner.agentId)
    const reloaded = await harness.coordinator.getSnapshot(harness.owner)
    expect(reloaded.coordinationMode).toBe('graph')
    expect(reloaded.workGraph?.nodes).toHaveLength(21)
    expect(reloaded.plan).toHaveLength(21)
  })
})

async function createHarness(
  existingDataDir?: string,
  isWorkerActive?: (workerId: string) => boolean,
  now: () => string = () => new Date().toISOString(),
): Promise<{
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
    now,
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
    isWorkerActive,
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
