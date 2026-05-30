import { describe, expect, it } from 'vitest'
import type { WorkPlanSnapshot } from '@forge/protocol'
import {
  ACTIVE_WORK_RUNTIME_CONTEXT_MAX_CHARS,
  ACTIVE_WORK_RUNTIME_CONTEXT_PATH_MARKER,
  ACTIVE_WORK_RUNTIME_CONTEXT_URL_MARKER,
  formatWorkPlanRuntimeContext,
} from '../coordination/work-plan-runtime-context.js'

const BASE_TIME = '2026-05-29T12:00:00.000Z'

describe('work-plan-runtime-context', () => {
  it('returns undefined when there is no active work and only routine recent completions', () => {
    const result = formatWorkPlanRuntimeContext({
      sessionAgentId: 'manager',
      profileId: 'profile',
      revision: 4,
      activeWorkPlan: null,
      recentWorkPlans: [createPlan({ status: 'completed', finalSummary: 'Routine completion.' })],
      recentWorkPlanCount: 1,
      recentWorkPlansTruncated: false,
      diagnostics: { state: 'ok' },
    })

    expect(result).toBeUndefined()
  })

  it('formats blocked, needs-attention, active, and up-next items with latest known worker links', () => {
    const result = formatWorkPlanRuntimeContext({
      sessionAgentId: 'manager',
      profileId: 'profile',
      revision: 7,
      activeWorkPlan: createPlan({
        title: 'Land WP7 formatter',
        goal: 'Create the shared runtime-context formatter and keep it concise.',
        status: 'blocked',
        items: [
          createItem({
            title: 'Finalize lifecycle follow-through',
            status: 'blocked',
            blocker: { reason: 'Waiting on WP6 clear-context decision.' },
            workerLinks: [createWorkerLink('worker-1', 'Backend Specialist')],
          }),
          createItem({
            title: 'Confirm preview section shape',
            status: 'needs_attention',
            note: 'Need a stable dedicated preview section label.',
          }),
          createItem({
            title: 'Implement formatter',
            status: 'active',
            result: { summary: 'Pure formatter module is in progress.', status: 'partial' },
          }),
          createItem({
            title: 'Add prompt-preview wiring',
            status: 'up_next',
          }),
        ],
      }),
      recentWorkPlans: [
        createPlan({
          planId: 'recent-1',
          status: 'completed_with_warnings',
          title: 'WP5 snapshot wiring',
          finalSummary: 'Bootstrap/live transport landed with one follow-up note.',
          warnings: ['Recheck CLI headless review.'],
        }),
      ],
      recentWorkPlanCount: 1,
      recentWorkPlansTruncated: false,
      diagnostics: { state: 'ok' },
    })

    expect(result?.text).toContain('# Active Work Context')
    expect(result?.text).toContain('Current plan: Land WP7 formatter [blocked]')
    expect(result?.text).toContain('Current items:')
    expect(result?.text).toContain('- [blocked] Finalize lifecycle follow-through')
    expect(result?.text).toContain('blocker: Waiting on WP6 clear-context decision.')
    expect(result?.text).toContain('latest known worker links: Backend Specialist (worker-1, latest known link)')
    expect(result?.text).toContain('- [needs_attention] Confirm preview section shape')
    expect(result?.text).toContain('- [active] Implement formatter')
    expect(result?.text).toContain('Up next:')
    expect(result?.text).toContain('- [up_next] Add prompt-preview wiring')
    expect(result?.text).toContain('Recent terminal work receipts:')
    expect(result?.text).toContain('- [completed_with_warnings] WP5 snapshot wiring')
    expect(result?.source).toBe('active_plan')
  })

  it('includes only meaningful recent terminal receipts when there is no active plan', () => {
    const result = formatWorkPlanRuntimeContext({
      sessionAgentId: 'manager',
      profileId: 'profile',
      revision: 9,
      activeWorkPlan: null,
      recentWorkPlans: [
        createPlan({
          status: 'completed_with_warnings',
          title: 'WP5 snapshot wiring',
          finalSummary: 'Bootstrap/live transport landed with one follow-up note.',
          warnings: ['Recheck CLI headless review.'],
        }),
        createPlan({
          status: 'failed',
          title: 'Earlier attempt',
          finalSummary: 'Superseded by the remediated pass.',
        }),
      ],
      recentWorkPlanCount: 2,
      recentWorkPlansTruncated: false,
      diagnostics: { state: 'ok' },
    })

    expect(result?.text).toContain('Recent terminal work receipts:')
    expect(result?.text).toContain('- [completed_with_warnings] WP5 snapshot wiring')
    expect(result?.text).toContain('summary: Bootstrap/live transport landed with one follow-up note.')
    expect(result?.text).toContain('warnings: Recheck CLI headless review.')
    expect(result?.source).toBe('recent_terminal')
  })

  it('returns a safe diagnostic-only block when task state is unavailable', () => {
    const result = formatWorkPlanRuntimeContext({
      sessionAgentId: 'manager',
      profileId: 'profile',
      revision: 0,
      activeWorkPlan: null,
      recentWorkPlans: [],
      recentWorkPlanCount: 0,
      recentWorkPlansTruncated: false,
      diagnostics: { state: 'unavailable', message: 'unsafe raw path should not appear here' },
    })

    expect(result?.text).toContain('Saved Active Work state is currently unavailable.')
    expect(result?.text).not.toContain('unsafe raw path')
    expect(result?.source).toBe('diagnostic_only')
  })

  it('sanitizes unsafe text and enforces the hard context limit', () => {
    const result = formatWorkPlanRuntimeContext({
      sessionAgentId: 'manager',
      profileId: 'profile',
      revision: 11,
      activeWorkPlan: createPlan({
        title: 'Very long active work plan title '.repeat(12),
        goal: 'See https://example.com and /Users/adam/private/notes plus ```rm -rf /tmp``` for details. '.repeat(12),
        items: Array.from({ length: 8 }, (_, index) =>
          createItem({
            itemId: `item-${index + 1}`,
            title: `Item ${index + 1} with path C:/secrets/demo and url https://danger.example.com`.repeat(3),
            status: index < 4 ? 'active' : 'up_next',
            note: 'Bearer abcdefghijklmnop and /tmp/private/output.log should never leak. '.repeat(6),
            workerLinks: [
              createWorkerLink(`worker-${index + 1}`, `Worker ${index + 1}`),
              createWorkerLink(`worker-extra-${index + 1}`, `Extra Worker ${index + 1}`),
              createWorkerLink(`worker-hidden-${index + 1}`, `Hidden Worker ${index + 1}`),
            ],
          }),
        ),
        itemsTruncated: true,
      }),
      recentWorkPlans: [],
      recentWorkPlanCount: 0,
      recentWorkPlansTruncated: false,
      diagnostics: { state: 'ok' },
    })

    expect(result).toBeDefined()
    expect(result!.text.length).toBeLessThanOrEqual(ACTIVE_WORK_RUNTIME_CONTEXT_MAX_CHARS)
    expect(result!.text).not.toContain('https://example.com')
    expect(result!.text).not.toContain('/Users/adam/private/notes')
    expect(result!.text).not.toContain('C:/secrets/demo')
    expect(result!.text).not.toContain('Bearer abcdefghijklmnop')
    expect(result!.text).toContain(ACTIVE_WORK_RUNTIME_CONTEXT_URL_MARKER)
    expect(result!.text).toContain(ACTIVE_WORK_RUNTIME_CONTEXT_PATH_MARKER)
  })
})

function createPlan(overrides: Partial<WorkPlanSnapshot> = {}): WorkPlanSnapshot {
  return {
    planId: overrides.planId ?? 'plan-1',
    title: overrides.title ?? 'Work plan',
    ...(overrides.goal === undefined ? {} : { goal: overrides.goal }),
    ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? BASE_TIME,
    updatedAt: overrides.updatedAt ?? BASE_TIME,
    ...(overrides.completedAt === undefined ? {} : { completedAt: overrides.completedAt }),
    revision: overrides.revision ?? 1,
    items: overrides.items ?? [],
    itemCount: overrides.itemCount ?? (overrides.items?.length ?? 0),
    itemsTruncated: overrides.itemsTruncated ?? false,
    ...(overrides.latestRevisionNote === undefined ? {} : { latestRevisionNote: overrides.latestRevisionNote }),
    warnings: overrides.warnings ?? [],
    warningCount: overrides.warningCount ?? (overrides.warnings?.length ?? 0),
    warningsTruncated: overrides.warningsTruncated ?? false,
    ...(overrides.finalSummary === undefined ? {} : { finalSummary: overrides.finalSummary }),
    ...(overrides.lifecycle === undefined ? {} : { lifecycle: overrides.lifecycle }),
  }
}

function createItem(overrides: Partial<WorkPlanSnapshot['items'][number]> = {}): WorkPlanSnapshot['items'][number] {
  return {
    itemId: overrides.itemId ?? 'item-1',
    title: overrides.title ?? 'Item',
    ...(overrides.phase === undefined ? {} : { phase: overrides.phase }),
    status: overrides.status ?? 'todo',
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
    ...(overrides.blocker === undefined ? {} : { blocker: overrides.blocker }),
    ...(overrides.result === undefined ? {} : { result: overrides.result }),
    workerLinks: overrides.workerLinks ?? [],
    workerLinkCount: overrides.workerLinkCount ?? (overrides.workerLinks?.length ?? 0),
    workerLinksTruncated: overrides.workerLinksTruncated ?? false,
  }
}

function createWorkerLink(agentId: string, label: string) {
  return {
    type: 'worker' as const,
    linkId: `link-${agentId}`,
    agentId,
    label,
    linkedAt: BASE_TIME,
  }
}
