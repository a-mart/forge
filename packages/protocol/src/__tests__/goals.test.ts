import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  SESSION_GOAL_STATUSES,
  type SessionGoalControlAction,
  type SessionGoalSnapshotEvent,
  type SessionGoalStatus,
} from '../goals.js'

describe('goal protocol', () => {
  it('keeps the lifecycle vocabulary intentionally small', () => {
    expect(SESSION_GOAL_STATUSES).toEqual([
      'active',
      'paused',
      'blocked',
      'completed',
      'cancelled',
    ])
    expectTypeOf<SessionGoalStatus>().toEqualTypeOf<
      'active' | 'paused' | 'blocked' | 'completed' | 'cancelled'
    >()
  })

  it('represents a measured current-goal snapshot', () => {
    const event = {
      type: 'session_goal_snapshot',
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      revision: 4,
      measuredAt: '2026-07-13T10:01:00.000Z',
      goal: {
        id: 'goal-1',
        objective: 'Reach the requested outcome',
        status: 'active',
        createdAt: '2026-07-13T10:00:00.000Z',
        updatedAt: '2026-07-13T10:00:00.000Z',
        tokenBudget: 20_000,
        activeElapsedMs: 60_000,
        turnCount: 4,
        usage: { input: 1_000, output: 200, cacheRead: 300, cacheWrite: 0, total: 1_500 },
        usageCoverage: 'complete',
        remainingTokens: 18_500,
      },
    } satisfies SessionGoalSnapshotEvent

    expect(event.goal.status).toBe('active')
    expect(event.goal.remainingTokens).toBe(18_500)
  })

  it('limits user controls to pause, resume, cancel, and edit', () => {
    const actions: SessionGoalControlAction[] = [
      { action: 'pause' },
      { action: 'resume' },
      { action: 'cancel' },
      { action: 'edit', objective: 'Refined outcome', tokenBudget: null },
    ]
    expect(actions.map((action) => action.action)).toEqual(['pause', 'resume', 'cancel', 'edit'])
  })
})
