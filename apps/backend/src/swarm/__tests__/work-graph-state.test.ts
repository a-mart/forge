import type { WorkGraphNode, WorkGraphSnapshot } from '@forge/protocol'
import { describe, expect, it } from 'vitest'
import {
  blockInterruptedWorkGraphWorkers,
  claimReadyWorkGraphNodes,
  findRunningWorkersToCancel,
  isWorkGraphComplete,
  normalizePersistedWorkGraphSnapshot,
  normalizeWorkGraphInput,
  projectWorkGraphPlan,
  recordWorkGraphDispatchFailure,
  recordWorkGraphWorkerResult,
  recordWorkGraphWorkerStarted,
  recoverInterruptedWorkGraphDispatches,
  resolveWorkGraphRoute,
} from '../planning/work-graph-state.js'

const now = () => '2026-07-18T12:00:00.000Z'

describe('progressive work graph scenarios', () => {
  it('1. leaves direct and light-plan work outside the executable graph', () => {
    const graph = graphOf([
      node('implement', 'Implement the focused change', { kind: 'implementation' }),
    ])
    expect(projectWorkGraphPlan(graph)).toEqual([
      { step: 'Implement the focused change', status: 'pending' },
    ])
    expect(graph).not.toHaveProperty('plan')
  })

  it('2. dispatches one bounded implementation on routine policy', () => {
    const claimed = claim(graphOf([
      node('implement', 'Implement the focused change', { kind: 'implementation' }),
    ]))
    expect(claimed.claims).toMatchObject([{
      nodeId: 'implement',
      behaviorMode: 'general',
      executionPolicy: 'routine',
    }])
  })

  it('3. keeps dependent verification pending while implementation runs', () => {
    const claimed = claim(graphOf([
      node('implement', 'Implement protocol support', { kind: 'implementation' }),
      node('verify', 'Verify protocol support', { kind: 'review', dependsOn: ['implement'] }),
    ]))
    expect(claimed.claims.map((entry) => entry.nodeId)).toEqual(['implement'])
    expect(claimed.graph.nodes.find((entry) => entry.id === 'verify')?.status).toBe('pending')
  })

  it('4. fans independent research leaves out on support policy', () => {
    const claimed = claim(graphOf([
      node('docs', 'Inspect primary documentation', { kind: 'research' }),
      node('runtime', 'Inspect runtime behavior', { kind: 'research' }),
      node('history', 'Inspect sanitized history evidence', { kind: 'research' }),
    ]))
    expect(claimed.claims).toHaveLength(3)
    expect(new Set(claimed.claims.map((entry) => entry.executionPolicy))).toEqual(new Set(['support']))
  })

  it('5. uses routine rather than deep for ordinary correctness review', () => {
    expect(resolveWorkGraphRoute(node('review', 'Review the patch', {
      kind: 'review',
    }))).toEqual({ behaviorMode: 'correctness-review', executionPolicy: 'routine' })
  })

  it('6. keeps topology-only synthesis routine and honors explicit deep risk', () => {
    expect(resolveWorkGraphRoute(node('synthesize', 'Synthesize findings', {
      kind: 'synthesis',
      dependsOn: ['one', 'two', 'three'],
    }))).toEqual({ behaviorMode: 'general', executionPolicy: 'routine' })
    expect(resolveWorkGraphRoute(node('high-risk', 'Resolve high-risk synthesis', {
      kind: 'synthesis',
      dependsOn: ['one', 'two', 'three'],
      effort: 'deep',
    })).executionPolicy).toBe('deep')
  })

  it('7. moves successful workers to manager acceptance before releasing dependents', () => {
    const first = claim(graphOf([
      node('research', 'Research behavior', { kind: 'research' }),
      node('synthesis', 'Synthesize answer', { kind: 'synthesis', dependsOn: ['research'] }),
    ]))
    const started = recordWorkGraphWorkerStarted(
      first.graph,
      'research',
      first.claims[0]!.attemptId,
      'research-worker',
    )
    const settled = recordWorkGraphWorkerResult(started, 'research-worker', 'status: done\nsummary: Evidence.', now)
    expect(settled.graph.nodes[0]?.status).toBe('awaiting_review')
    expect(claim(settled.graph).claims).toEqual([])

    const accepted = normalizeWorkGraphInput({ nodes: [
      inputNode(settled.graph.nodes[0]!, 'completed'),
      inputNode(settled.graph.nodes[1]!, 'pending'),
    ] }, settled.graph)
    const dependentClaim = claim(accepted).claims[0]
    expect(dependentClaim?.nodeId).toBe('synthesis')
    expect(dependentClaim?.dependencyContext).toContain('[research: Research behavior]')
    expect(dependentClaim?.dependencyContext).toContain('summary: Evidence.')
  })

  it('bounds accepted dependency result handoff for downstream workers', () => {
    const dependencies = Array.from({ length: 8 }, (_, index) => node(
      `source-${index + 1}`,
      `Accepted source ${index + 1}`,
      {
        status: 'completed',
        attempts: [{
          id: `source-attempt-${index + 1}`,
          number: 1,
          status: 'succeeded',
          startedAt: now(),
          completedAt: now(),
          behaviorMode: 'research',
          executionPolicy: 'support',
          summary: `status: done\nsummary: ${'evidence '.repeat(200)}`,
        }],
      },
    ))
    const downstream = node('synthesize', 'Synthesize accepted sources', {
      kind: 'synthesis',
      dependsOn: dependencies.map((entry) => entry.id),
    })

    const downstreamClaim = claim(graphOf([...dependencies, downstream])).claims[0]
    expect(downstreamClaim?.nodeId).toBe('synthesize')
    expect(downstreamClaim?.dependencyContext?.length).toBeLessThanOrEqual(6_000)
    expect(downstreamClaim?.dependencyContext).toContain('[source-1: Accepted source 1]')
    expect(downstreamClaim?.dependencyContext).toContain('[source-8: Accepted source 8]')
  })

  it('preserves every accepted dependency within the bounded fan-in handoff', () => {
    const dependencies = Array.from({ length: 31 }, (_, index) => node(
      `source-${String(index + 1).padStart(2, '0')}-${'x'.repeat(50)}`,
      `Accepted source ${index + 1} ${'T'.repeat(130)}`,
      {
        status: 'completed',
        attempts: [{
          id: `source-attempt-${index + 1}`,
          number: 1,
          status: 'succeeded',
          startedAt: now(),
          completedAt: now(),
          behaviorMode: 'research',
          executionPolicy: 'support',
          summary: `status: done\nsummary: ${'evidence '.repeat(200)}`,
        }],
      },
    ))
    const downstream = node('synthesize', 'Synthesize all accepted sources', {
      kind: 'synthesis',
      dependsOn: dependencies.map((entry) => entry.id),
    })

    const dependencyContext = claim(graphOf([...dependencies, downstream])).claims[0]
      ?.dependencyContext
    expect(dependencyContext?.length).toBeLessThanOrEqual(6_000)
    for (const dependency of dependencies) {
      expect(dependencyContext).toContain(`[${dependency.id}:`)
    }
  })

  it('creates distinct bounded worker ids for node ids with the same normalized prefix', () => {
    const claimed = claim(graphOf([
      node('same_prefix', 'Underscore source'),
      node('same-prefix', 'Hyphen source'),
      node(`same-prefix-${'a'.repeat(52)}`, 'Long source one'),
      node(`same-prefix-${'a'.repeat(51)}b`, 'Long source two'),
    ]))
    const workerIds = claimed.claims.map((entry) => entry.agentId)
    expect(new Set(workerIds)).toHaveProperty('size', workerIds.length)
    expect(workerIds.every((workerId) => workerId.length <= 48)).toBe(true)
  })

  it('rejects changing execution fields while a node worker is running', () => {
    const initial = claim(graphOf([
      node('active', 'Active work', { kind: 'implementation' }),
    ]))
    const running = recordWorkGraphWorkerStarted(
      initial.graph,
      'active',
      initial.claims[0]!.attemptId,
      'active-worker',
    )

    expect(() => normalizeWorkGraphInput({ nodes: [{
      ...inputNode(running.nodes[0]!, 'running'),
      task: 'Silently replace the task already assigned to the active worker.',
    }] }, running)).toThrow('cannot change execution fields while status=running')
    expect(() => normalizeWorkGraphInput({ nodes: [{
      ...inputNode(running.nodes[0]!, 'pending'),
      task: 'Replace the task after cancelling the active attempt.',
    }] }, running)).not.toThrow()
  })

  it('8. retries a blocked node with automatic deep escalation', () => {
    const initial = claim(graphOf([node('hard', 'Resolve the hard abstraction')]))
    const failed = recordWorkGraphDispatchFailure(
      initial.graph,
      'hard',
      initial.claims[0]!.attemptId,
      new Error('first approach failed'),
      now,
    )
    const retry = normalizeWorkGraphInput({ nodes: [inputNode(failed.nodes[0]!, 'pending')] }, failed)
    const retried = claim(retry)
    expect(retried.claims[0]).toMatchObject({ nodeId: 'hard', executionPolicy: 'deep' })
    expect(retried.graph.nodes[0]?.attempts).toHaveLength(2)
  })

  it('9. identifies running workers cancelled by user steering', () => {
    const initial = claim(graphOf([
      node('old', 'Investigate the old direction'),
      node('keep', 'Preserve useful work'),
    ]))
    let running = recordWorkGraphWorkerStarted(
      initial.graph,
      'old',
      initial.claims[0]!.attemptId,
      'old-worker',
    )
    running = recordWorkGraphWorkerStarted(
      running,
      'keep',
      initial.claims[1]!.attemptId,
      'keep-worker',
    )
    const revised = normalizeWorkGraphInput({ nodes: [
      inputNode(running.nodes.find((entry) => entry.id === 'old')!, 'cancelled'),
      inputNode(running.nodes.find((entry) => entry.id === 'keep')!, 'running'),
      inputNode(node('new', 'Investigate the steered direction'), 'pending'),
    ] }, running)
    expect(findRunningWorkersToCancel(running, revised)).toEqual(['old-worker'])
    expect(revised.nodes.find((entry) => entry.id === 'old')?.attempts.at(-1)?.status).toBe(
      'cancelled',
    )
  })

  it('10. never auto-dispatches a waiting human decision gate', () => {
    const waiting = graphOf([
      node('choose', 'Choose migration strategy', { kind: 'decision', status: 'waiting' }),
      node('implement', 'Implement selected strategy', { dependsOn: ['choose'] }),
    ])
    expect(claim(waiting).claims).toEqual([])
    expect(() => normalizeWorkGraphInput({ nodes: [
      inputNode(node('bad', 'Invalid gate', { kind: 'decision' }), 'pending'),
    ] })).toThrow('decision gate')
  })

  it('11. enforces the concurrency cap and releases capacity deterministically', () => {
    const first = claim({ ...graphOf([
      node('one', 'First stream'),
      node('two', 'Second stream'),
      node('three', 'Third stream'),
    ]), maxConcurrency: 2 })
    expect(first.claims.map((entry) => entry.nodeId)).toEqual(['one', 'two'])
    const oneStarted = recordWorkGraphWorkerStarted(
      first.graph,
      'one',
      first.claims[0]!.attemptId,
      'one-worker',
    )
    const twoStarted = recordWorkGraphWorkerStarted(
      oneStarted,
      'two',
      first.claims[1]!.attemptId,
      'two-worker',
    )
    const oneSettled = recordWorkGraphWorkerResult(
      twoStarted,
      'one-worker',
      'status: done\nsummary: complete',
      now,
    ).graph
    expect(claim(oneSettled).claims.map((entry) => entry.nodeId)).toEqual(['three'])
  })

  it('12. restores running workers and blocks only interrupted dispatch windows on restart', () => {
    const first = claim(graphOf([
      node('confirmed', 'Confirmed dispatch'),
      node('interrupted', 'Interrupted dispatch'),
    ]))
    const running = recordWorkGraphWorkerStarted(
      first.graph,
      'confirmed',
      first.claims[0]!.attemptId,
      'confirmed-worker',
    )
    const persisted = normalizePersistedWorkGraphSnapshot(JSON.parse(JSON.stringify(running)))
    const recovered = recoverInterruptedWorkGraphDispatches(persisted, now)
    expect(recovered.graph.nodes.find((entry) => entry.id === 'confirmed')?.status).toBe('running')
    expect(recovered.graph.nodes.find((entry) => entry.id === 'interrupted')?.status).toBe('blocked')
    expect(claim(recovered.graph).claims).toEqual([])
  })

  it('blocks a persisted running attempt when its worker is no longer active', () => {
    const first = claim(graphOf([node('validate', 'Run final validation')]))
    const running = recordWorkGraphWorkerStarted(
      first.graph,
      'validate',
      first.claims[0]!.attemptId,
      'validation-worker',
    )

    const recovered = recoverInterruptedWorkGraphDispatches(running, now, {
      isWorkerActive: () => false,
    })
    expect(recovered.changed).toBe(true)
    expect(recovered.graph.nodes[0]).toMatchObject({
      status: 'blocked',
      attempts: [{
        status: 'blocked',
        workerId: 'validation-worker',
        completedAt: now(),
        summary: expect.stringContaining('worker stopped'),
      }],
    })

    const dismissed = blockInterruptedWorkGraphWorkers(
      running,
      new Set(['validation-worker']),
      now,
    )
    expect(dismissed.changedNodeIds).toEqual(['validate'])
    expect(dismissed.graph.nodes[0]).toMatchObject({
      status: 'blocked',
      attempts: [{ summary: expect.stringContaining('recovery was dismissed') }],
    })
  })

  it('13. models the conversation-derived logic-app review as cheap breadth plus one synthesis', () => {
    const researchNodes = Array.from({ length: 9 }, (_, index) => node(
      `logic_app_${index + 1}`,
      `Inspect logic app ${index + 1}`,
      { kind: 'research' },
    ))
    const graph = graphOf([
      ...researchNodes,
      node('logic_synthesis', 'Synthesize logic-app findings', {
        kind: 'synthesis',
        dependsOn: researchNodes.map((entry) => entry.id),
      }),
    ])
    const first = claim({ ...graph, maxConcurrency: 8 })
    expect(first.claims).toHaveLength(8)
    expect(first.claims.every((entry) => entry.executionPolicy === 'support')).toBe(true)
    expect(resolveWorkGraphRoute(graph.nodes.at(-1)!).executionPolicy).toBe('routine')
  })

  it('14. models the specialist redesign with mixed routing rather than all-deep workers', () => {
    const graph = graphOf([
      node('history', 'Inspect delegation history', { kind: 'research' }),
      node('runtime', 'Design runtime mechanics', { kind: 'implementation' }),
      node('ui', 'Design graph presentation', { kind: 'implementation' }),
      node('review', 'Review correctness boundaries', { kind: 'review' }),
      node('converge', 'Converge on the redesign', {
        kind: 'synthesis',
        dependsOn: ['history', 'runtime', 'ui', 'review'],
        effort: 'deep',
      }),
    ])
    expect(graph.nodes.map((entry) => resolveWorkGraphRoute(entry).executionPolicy)).toEqual([
      'support',
      'routine',
      'routine',
      'routine',
      'deep',
    ])
  })

  it('rejects cycles and reports completion without cancelled nodes', () => {
    expect(() => normalizeWorkGraphInput({ nodes: [
      inputNode(node('one', 'One', { dependsOn: ['two'] }), 'pending'),
      inputNode(node('two', 'Two', { dependsOn: ['one'] }), 'pending'),
    ] })).toThrow('cycle')
    expect(isWorkGraphComplete(graphOf([
      node('done', 'Accepted outcome', { status: 'completed' }),
      node('removed', 'Removed outcome', { status: 'cancelled' }),
    ]))).toBe(true)
  })
})

function node(
  id: string,
  title: string,
  overrides: Partial<WorkGraphNode> = {},
): WorkGraphNode {
  return {
    id,
    title,
    task: `Complete ${title.toLowerCase()} and return evidence.`,
    kind: 'task',
    status: 'pending',
    dependsOn: [],
    effort: 'auto',
    attempts: [],
    ...overrides,
  }
}

function graphOf(nodes: WorkGraphNode[]): WorkGraphSnapshot {
  return { maxConcurrency: 4, nodes }
}

function claim(graph: WorkGraphSnapshot) {
  let id = 0
  return claimReadyWorkGraphNodes(graph, { now, randomId: () => `attempt-${++id}` })
}

function inputNode(node: WorkGraphNode, status: WorkGraphNode['status']) {
  return {
    id: node.id,
    title: node.title,
    task: node.task,
    kind: node.kind,
    status,
    dependsOn: node.dependsOn,
    acceptanceCriteria: node.acceptanceCriteria,
    effort: node.effort,
  }
}
