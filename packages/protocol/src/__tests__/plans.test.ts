import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  PLAN_STEP_STATUSES,
  WORK_GRAPH_NODE_STATUSES,
  type PlanSummaryEvent,
  type PlanStepStatus,
  type SessionPlanSnapshotEvent,
} from '../plans.js'

describe('plan protocol', () => {
  it('keeps the status vocabulary intentionally small', () => {
    expect(PLAN_STEP_STATUSES).toEqual(['pending', 'in_progress', 'completed'])
    expectTypeOf<PlanStepStatus>().toEqualTypeOf<'pending' | 'in_progress' | 'completed'>()
  })

  it('represents one complete current snapshot', () => {
    const event = {
      type: 'session_plan_snapshot',
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      revision: 2,
      updatedAt: '2026-07-12T00:00:00.000Z',
      explanation: 'Implementation is ready for verification.',
      plan: [
        { step: 'Inspect the current behavior', status: 'completed' },
        { step: 'Run focused verification', status: 'in_progress' },
      ],
    } satisfies SessionPlanSnapshotEvent

    expect(event.plan).toHaveLength(2)
    expect(event.plan[1]?.status).toBe('in_progress')
  })

  it('represents one frozen completed-plan transcript summary', () => {
    const summary = {
      type: 'plan_summary',
      id: 'summary-1',
      agentId: 'session-1',
      timestamp: '2026-07-13T01:00:00.000Z',
      revision: 3,
      updatedAt: '2026-07-13T00:59:00.000Z',
      plan: [{ step: 'Verify the result', status: 'completed' }],
    } satisfies PlanSummaryEvent

    expect(summary.plan[0]?.status).toBe('completed')
  })

  it('adds graph execution detail without widening the legacy plan-step vocabulary', () => {
    const event = {
      type: 'session_plan_snapshot',
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      revision: 4,
      updatedAt: '2026-07-18T00:00:00.000Z',
      coordinationMode: 'graph',
      plan: [{ step: 'Research behavior', status: 'in_progress' }],
      workGraph: {
        maxConcurrency: 4,
        nodes: [{
          id: 'research',
          title: 'Research behavior',
          task: 'Inspect behavior and return evidence.',
          kind: 'research',
          status: 'running',
          dependsOn: [],
          effort: 'auto',
          attempts: [{
            id: 'attempt-1',
            number: 1,
            status: 'running',
            startedAt: '2026-07-18T00:00:00.000Z',
            workerId: 'graph-research-1',
            behaviorMode: 'research',
            executionPolicy: 'support',
          }],
        }],
      },
    } satisfies SessionPlanSnapshotEvent

    expect(WORK_GRAPH_NODE_STATUSES).toContain(event.workGraph.nodes[0]?.status)
    expect(event.plan[0]?.status).toBe('in_progress')
  })

  it('represents an active inline plan anchor', () => {
    const anchor = {
      type: 'plan_summary',
      id: 'plan-card-1',
      agentId: 'session-1',
      timestamp: '2026-07-13T01:00:00.000Z',
      state: 'active',
      revision: 1,
      updatedAt: '2026-07-13T01:00:00.000Z',
      plan: [{ step: 'Implement the change', status: 'in_progress' }],
    } satisfies PlanSummaryEvent

    expect(anchor.state).toBe('active')
  })
})
