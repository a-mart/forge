import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  MAX_RECENT_WORK_PLAN_SNAPSHOTS,
  SESSION_TASK_DIAGNOSTIC_STATES,
  WORK_PLAN_ITEM_RESULT_STATUSES,
  WORK_PLAN_ITEM_STATUSES,
  WORK_PLAN_LIFECYCLE_REASONS,
  WORK_PLAN_LINK_TYPES,
  WORK_PLAN_MODES,
  WORK_PLAN_MUTABLE_STATUSES,
  WORK_PLAN_STATUSES,
  WORK_PLAN_TERMINAL_STATUSES,
  type SessionTaskDiagnosticState,
  type SessionTaskStateSnapshotEvent,
  type WorkPlanItemResultStatus,
  type WorkPlanItemStatus,
  type WorkPlanLifecycleReason,
  type WorkPlanLinkType,
  type WorkPlanMode,
  type WorkPlanMutableStatus,
  type WorkPlanStatus,
  type WorkPlanTerminalStatus,
} from '../index.js'

describe('tasks protocol contracts', () => {
  it('exports the locked v1 task status vocabularies from the root barrel', () => {
    expect(WORK_PLAN_STATUSES).toEqual([
      'active',
      'blocked',
      'needs_attention',
      'stopped',
      'completed',
      'completed_with_warnings',
      'failed',
      'interrupted',
    ])
    expect(WORK_PLAN_MUTABLE_STATUSES).toEqual(['active', 'blocked', 'needs_attention'])
    expect(WORK_PLAN_TERMINAL_STATUSES).toEqual([
      'completed',
      'completed_with_warnings',
      'failed',
      'stopped',
      'interrupted',
    ])
    expect(WORK_PLAN_ITEM_STATUSES).toEqual([
      'todo',
      'up_next',
      'active',
      'blocked',
      'needs_attention',
      'done',
      'skipped',
      'failed',
      'unknown',
    ])
    expect(WORK_PLAN_ITEM_RESULT_STATUSES).toEqual(['done', 'partial', 'failed', 'skipped', 'unknown'])
    expect(WORK_PLAN_MODES).toEqual(['quick', 'standard', 'deep'])
    expect(WORK_PLAN_LIFECYCLE_REASONS).toEqual(['manual_stop', 'archived', 'conversation_cleared'])
    expect(WORK_PLAN_LINK_TYPES).toEqual(['worker'])
    expect(SESSION_TASK_DIAGNOSTIC_STATES).toEqual(['ok', 'defaulted', 'corrupt_recovered', 'unavailable'])
    expect(MAX_RECENT_WORK_PLAN_SNAPSHOTS).toBe(8)
  })

  it('keeps literal union coverage aligned with the exported constants', () => {
    expectTypeOf<Exclude<WorkPlanStatus, (typeof WORK_PLAN_STATUSES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof WORK_PLAN_STATUSES)[number], WorkPlanStatus>>().toEqualTypeOf<never>()

    expectTypeOf<Exclude<WorkPlanMutableStatus, (typeof WORK_PLAN_MUTABLE_STATUSES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof WORK_PLAN_MUTABLE_STATUSES)[number], WorkPlanMutableStatus>>().toEqualTypeOf<never>()

    expectTypeOf<Exclude<WorkPlanTerminalStatus, (typeof WORK_PLAN_TERMINAL_STATUSES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof WORK_PLAN_TERMINAL_STATUSES)[number], WorkPlanTerminalStatus>>().toEqualTypeOf<never>()

    expectTypeOf<Exclude<WorkPlanItemStatus, (typeof WORK_PLAN_ITEM_STATUSES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof WORK_PLAN_ITEM_STATUSES)[number], WorkPlanItemStatus>>().toEqualTypeOf<never>()

    expectTypeOf<Exclude<WorkPlanItemResultStatus, (typeof WORK_PLAN_ITEM_RESULT_STATUSES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof WORK_PLAN_ITEM_RESULT_STATUSES)[number], WorkPlanItemResultStatus>>().toEqualTypeOf<never>()

    expectTypeOf<Exclude<WorkPlanMode, (typeof WORK_PLAN_MODES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof WORK_PLAN_MODES)[number], WorkPlanMode>>().toEqualTypeOf<never>()

    expectTypeOf<Exclude<WorkPlanLifecycleReason, (typeof WORK_PLAN_LIFECYCLE_REASONS)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof WORK_PLAN_LIFECYCLE_REASONS)[number], WorkPlanLifecycleReason>>().toEqualTypeOf<never>()

    expectTypeOf<Exclude<WorkPlanLinkType, (typeof WORK_PLAN_LINK_TYPES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof WORK_PLAN_LINK_TYPES)[number], WorkPlanLinkType>>().toEqualTypeOf<never>()

    expectTypeOf<Exclude<SessionTaskDiagnosticState, (typeof SESSION_TASK_DIAGNOSTIC_STATES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof SESSION_TASK_DIAGNOSTIC_STATES)[number], SessionTaskDiagnosticState>>().toEqualTypeOf<never>()
  })

  it('models the public session task snapshot event as a bounded redacted session-scoped payload', () => {
    const event = {
      type: 'session_task_state_snapshot',
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      revision: 3,
      activeWorkPlan: {
        planId: 'plan-1',
        title: 'Implement WP1 foundation',
        goal: 'Land protocol and backend scaffolding only',
        mode: 'standard',
        status: 'active',
        createdAt: '2026-05-29T00:00:00.000Z',
        updatedAt: '2026-05-29T00:10:00.000Z',
        revision: 2,
        items: [
          {
            itemId: 'item-1',
            title: 'Define protocol DTOs',
            phase: 'protocol',
            status: 'active',
            note: 'No tool wiring yet.',
            blocker: { reason: 'Waiting for final naming', needsUser: false },
            result: { summary: 'Contracts drafted', status: 'partial' },
            workerLinks: [
              {
                type: 'worker',
                linkId: 'link-1',
                agentId: 'worker-1',
                label: 'backend specialist',
                specialistId: 'backend-specialist',
                linkedAt: '2026-05-29T00:05:00.000Z',
              },
            ],
            workerLinkCount: 3,
            workerLinksTruncated: true,
          },
        ],
        itemCount: 4,
        itemsTruncated: true,
        latestRevisionNote: { revision: 2, note: 'Narrowed scope to WP1 only', createdAt: '2026-05-29T00:10:00.000Z' },
        warnings: ['Validation still pending'],
        warningCount: 2,
        warningsTruncated: true,
        lifecycle: { reason: 'manual_stop', changedAt: '2026-05-29T00:11:00.000Z' },
      },
      recentWorkPlans: [],
      recentWorkPlanCount: 2,
      recentWorkPlansTruncated: true,
      diagnostics: { state: 'ok' },
      requestId: 'request-1',
    } satisfies SessionTaskStateSnapshotEvent

    expect(event.type).toBe('session_task_state_snapshot')
    expect(event.activeWorkPlan?.items[0]?.workerLinks[0]?.type).toBe('worker')
    expect(event.activeWorkPlan?.items[0]?.workerLinks[0]?.specialistId).toBe('backend-specialist')
    expect(event.activeWorkPlan?.itemCount).toBeGreaterThan(event.activeWorkPlan?.items.length ?? 0)
    expect(event.activeWorkPlan?.items[0]?.workerLinkCount).toBeGreaterThan(event.activeWorkPlan?.items[0]?.workerLinks.length ?? 0)
    expect(event.activeWorkPlan?.warningCount).toBeGreaterThan(event.activeWorkPlan?.warnings.length ?? 0)
    expect(event.recentWorkPlanCount).toBeGreaterThan(event.recentWorkPlans.length)
    expect(event.activeWorkPlan?.latestRevisionNote?.note).toBe('Narrowed scope to WP1 only')
    expect(event.diagnostics?.state).toBe('ok')
  })
})
