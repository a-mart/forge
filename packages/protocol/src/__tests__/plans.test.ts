import { describe, expect, it } from 'vitest'
import { normalizePlanSummaryEntries, type PlanSummaryEvent } from '../plans.js'

describe('plan protocol', () => {
  it('normalizes polluted active anchors while preserving completed plan history', () => {
    const summary = (
      id: string,
      revision: number,
      state: 'active' | 'completed',
    ): PlanSummaryEvent => ({
      type: 'plan_summary',
      id,
      agentId: 'session-1',
      timestamp: `2026-07-13T01:00:0${revision}.000Z`,
      state,
      revision,
      updatedAt: `2026-07-13T01:00:0${revision}.000Z`,
      plan: [{ step: `Plan ${id}`, status: state === 'completed' ? 'completed' : 'in_progress' }],
    })
    const historical = summary('historical', 1, 'completed')
    const staleActive = summary('stale-active', 2, 'active')
    const currentActive = summary('current', 3, 'active')
    const currentCompleted = summary('current', 4, 'completed')
    const nextCompleted = summary('next-historical', 5, 'completed')

    expect(normalizePlanSummaryEntries([
      historical,
      { type: 'other', value: 1 },
      staleActive,
      currentActive,
      currentCompleted,
      nextCompleted,
    ])).toEqual([
      historical,
      { type: 'other', value: 1 },
      currentCompleted,
      nextCompleted,
    ])
  })

  it('retains only the newest of multiple distinct active anchors', () => {
    const makeActive = (id: string, revision: number): PlanSummaryEvent => ({
      type: 'plan_summary',
      id,
      agentId: 'session-1',
      timestamp: `2026-07-13T01:00:0${revision}.000Z`,
      state: 'active',
      revision,
      updatedAt: `2026-07-13T01:00:0${revision}.000Z`,
      plan: [{ step: id, status: 'in_progress' }],
    })

    expect(normalizePlanSummaryEntries([
      makeActive('polluted-1', 1),
      makeActive('polluted-2', 2),
      makeActive('authoritative', 3),
    ]).map((entry) => entry.id)).toEqual(['authoritative'])
  })
})
