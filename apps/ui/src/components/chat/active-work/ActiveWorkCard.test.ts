/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionTaskStateSnapshotEvent } from '@forge/protocol'
import { ActiveWorkCard } from './ActiveWorkCard'
import { getHeaderSummary } from './active-work-utils'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function makeSnapshot(overrides: Partial<SessionTaskStateSnapshotEvent> = {}): SessionTaskStateSnapshotEvent {
  return {
    type: 'session_task_state_snapshot',
    sessionAgentId: 'session-1',
    profileId: 'profile-1',
    revision: 1,
    activeWorkPlan: {
      planId: 'plan-1',
      title: 'Ship Active Work UI',
      goal: 'Show safe read-only work state in chat',
      status: 'active',
      createdAt: '2026-05-29T00:00:00Z',
      updatedAt: '2026-05-29T00:01:00Z',
      revision: 1,
      items: [
        { itemId: 'item-1', title: 'Blocked item', status: 'blocked', blocker: { reason: 'Needs decision' }, workerLinks: [], workerLinkCount: 0, workerLinksTruncated: false },
        { itemId: 'item-2', title: 'Active item', status: 'active', workerLinks: [{ type: 'worker', linkId: 'link-1', agentId: 'worker-1', label: 'Frontend worker', linkedAt: '2026-05-29T00:02:00Z' }], workerLinkCount: 1, workerLinksTruncated: false },
      ],
      itemCount: 2,
      itemsTruncated: false,
      warnings: [],
      warningCount: 0,
      warningsTruncated: false,
    },
    recentWorkPlans: [],
    recentWorkPlanCount: 0,
    recentWorkPlansTruncated: false,
    ...overrides,
  }
}

function makeRecentPlan(index: number) {
  return {
    ...makeSnapshot().activeWorkPlan!,
    planId: `recent-${index}`,
    title: `Completed plan ${index}`,
    status: 'completed' as const,
    completedAt: '2026-05-29T00:10:00Z',
  }
}

function render(snapshot: SessionTaskStateSnapshotEvent, expanded = true) {
  const onExpandedChange = vi.fn()
  flushSync(() => {
    root.render(createElement(ActiveWorkCard, {
      snapshot,
      agents: [],
      statuses: {},
      expanded,
      onExpandedChange,
    }))
  })
  return { onExpandedChange }
}

describe('ActiveWorkCard', () => {
  it('toggles the work item pane when the header button is clicked', () => {
    const { onExpandedChange } = render(makeSnapshot(), false)

    const headerToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Expand Active Work plan details"]')
    expect(headerToggle).toBeTruthy()
    expect(headerToggle?.getAttribute('aria-expanded')).toBe('false')
    const controlledRegionId = headerToggle?.getAttribute('aria-controls')
    expect(controlledRegionId).toBeTruthy()
    expect(document.getElementById(controlledRegionId!)).toBeTruthy()
    expect(document.getElementById(controlledRegionId!)?.hidden).toBe(true)

    flushSync(() => headerToggle?.click())

    expect(onExpandedChange).toHaveBeenCalledWith(true)
  })

  it('uses a native button for the header toggle', () => {
    const { onExpandedChange } = render(makeSnapshot(), true)

    const headerToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Active Work plan details"]')
    expect(headerToggle).toBeTruthy()
    expect(headerToggle?.tagName).toBe('BUTTON')

    flushSync(() => headerToggle?.click())

    expect(onExpandedChange).toHaveBeenCalledWith(false)
  })

  it('keeps aria-controls valid for diagnostics-only cards without a plan pane', () => {
    render(makeSnapshot({
      activeWorkPlan: null,
      recentWorkPlans: [],
      recentWorkPlanCount: 0,
      diagnostics: { state: 'unavailable', message: 'State file unavailable' },
    }), true)

    const headerToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Expand Active Work plan details"]')
    expect(headerToggle).toBeTruthy()
    expect(headerToggle?.getAttribute('aria-expanded')).toBe('false')
    const controlledRegionId = headerToggle?.getAttribute('aria-controls')
    expect(controlledRegionId).toBeTruthy()
    expect(document.getElementById(controlledRegionId!)).toBeTruthy()
    expect(document.getElementById(controlledRegionId!)?.hidden).toBe(true)
    expect(container.textContent).toContain('Active Work unavailable')
    expect(container.textContent).toContain('State file unavailable')
  })

  it('preserves the Hide control as a separate collapse toggle', () => {
    const { onExpandedChange } = render(makeSnapshot(), true)

    const hideButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Hide'))
    expect(hideButton).toBeTruthy()
    expect(hideButton?.getAttribute('aria-expanded')).toBe('true')

    flushSync(() => hideButton?.click())

    expect(onExpandedChange).toHaveBeenCalledWith(false)
  })

  it('renders blocked state and unavailable worker details without raw ids as the primary label', () => {
    render(makeSnapshot())

    expect(container.textContent).toContain('Ship Active Work UI')
    expect(container.textContent).toContain('Blocked')

    const activeItemButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Active item'))
    expect(activeItemButton).toBeTruthy()
    flushSync(() => activeItemButton?.click())

    expect(container.textContent).toContain('Frontend worker')
    expect(container.textContent).toContain('unavailable')
    expect(container.textContent).not.toContain('worker-1 · unavailable')
  })

  it('uses optional count metadata to avoid implying bounded arrays are complete', () => {
    const snapshot = makeSnapshot()
    snapshot.activeWorkPlan = {
      ...snapshot.activeWorkPlan!,
      itemCount: 7,
      itemsTruncated: true,
    }

    render(snapshot)

    expect(container.textContent).toContain('0/7+')
    expect(container.textContent).toContain('+5 more items not shown')
  })

  it('shows warning truncation metadata instead of implying warnings are complete', () => {
    const snapshot = makeSnapshot()
    snapshot.activeWorkPlan = {
      ...snapshot.activeWorkPlan!,
      warnings: ['First warning'],
      warningCount: 3,
      warningsTruncated: true,
    }

    render(snapshot)

    expect(container.textContent).toContain('First warning')
    expect(container.textContent).toContain('+2 more warnings not shown')
  })

  it('shows retained previous terminal receipts and truncation metadata behind a disclosure', () => {
    const snapshot = makeSnapshot({
      activeWorkPlan: null,
      recentWorkPlans: [makeRecentPlan(1), makeRecentPlan(2)],
      recentWorkPlanCount: 4,
      recentWorkPlansTruncated: true,
    })

    render(snapshot)

    expect(container.textContent).toContain('Completed plan 1')
    expect(container.textContent).not.toContain('Completed plan 2')
    const disclosure = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Show 1 previous completed Work Plan'))
    expect(disclosure).toBeTruthy()
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false')

    flushSync(() => disclosure?.click())

    expect(disclosure?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Completed plan 2')
    expect(container.textContent).toContain('Older Work Plans are outside the retained snapshot.')
  })

  it('collapses previous-plan disclosure when the session snapshot changes', async () => {
    const firstSnapshot = makeSnapshot({
      activeWorkPlan: null,
      recentWorkPlans: [makeRecentPlan(1), makeRecentPlan(2)],
      recentWorkPlanCount: 2,
      recentWorkPlansTruncated: false,
    })
    render(firstSnapshot)

    const disclosure = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Show 1 previous completed Work Plan'))
    expect(disclosure).toBeTruthy()
    flushSync(() => disclosure?.click())
    expect(disclosure?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Completed plan 2')

    const nextSnapshot = makeSnapshot({
      sessionAgentId: 'session-2',
      activeWorkPlan: null,
      recentWorkPlans: [makeRecentPlan(10), makeRecentPlan(11)],
      recentWorkPlanCount: 2,
      recentWorkPlansTruncated: false,
    })
    const onExpandedChange = vi.fn()
    flushSync(() => {
      root.render(createElement(ActiveWorkCard, {
        snapshot: nextSnapshot,
        agents: [],
        statuses: {},
        expanded: true,
        onExpandedChange,
      }))
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const nextDisclosure = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Show 1 previous completed Work Plan'))
    expect(nextDisclosure).toBeTruthy()
    expect(nextDisclosure?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('Completed plan 10')
    expect(container.textContent).not.toContain('Completed plan 11')
  })

  it('treats all retained recent plans as previous when an active plan is rendered', () => {
    const snapshot = makeSnapshot({
      recentWorkPlans: [1, 2, 3, 4, 5].map(makeRecentPlan),
      recentWorkPlanCount: 8,
      recentWorkPlansTruncated: true,
    })

    render(snapshot)

    expect(container.textContent).toContain('Ship Active Work UI')
    expect(container.textContent).not.toContain('Completed plan 1')
    const disclosure = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Show 5 previous completed Work Plans'))
    expect(disclosure).toBeTruthy()

    flushSync(() => disclosure?.click())

    expect(container.textContent).toContain('Completed plan 1')
    expect(container.textContent).toContain('Older Work Plans are outside the retained snapshot.')
  })

  it('starts previous receipts after the displayed terminal plan when no active plan exists', () => {
    const snapshot = makeSnapshot({
      activeWorkPlan: null,
      recentWorkPlans: [1, 2, 3, 4].map(makeRecentPlan),
      recentWorkPlanCount: 4,
      recentWorkPlansTruncated: false,
    })

    render(snapshot)

    expect(container.textContent).toContain('Completed plan 1')
    expect(container.textContent).not.toContain('Completed plan 2')
    const disclosure = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Show 3 previous completed Work Plans'))
    expect(disclosure).toBeTruthy()

    flushSync(() => disclosure?.click())

    expect(container.textContent).toContain('Completed plan 2')
  })

  it('renders terminal completed plans as receipts instead of contradictory 0/N progress', () => {
    const snapshot = makeSnapshot()
    snapshot.activeWorkPlan = {
      ...snapshot.activeWorkPlan!,
      status: 'completed',
      finalSummary: 'Finished the requested work.',
      completedAt: '2026-05-29T00:10:00Z',
    }

    render(snapshot)

    expect(container.textContent).toContain('Completed')
    expect(container.textContent).toContain('Finished')
    expect(container.textContent).not.toContain('Completed · 0/2')
    expect(container.textContent).not.toContain('0/2')
    expect(container.textContent).not.toContain('In progress')
    expect(container.textContent).not.toContain('Todo')
    expect(container.textContent).toContain('Done')
    expect(getHeaderSummary(snapshot)).toBe('Completed')
  })

  it('does not render live active/todo badges inside terminal plans', () => {
    for (const status of ['completed_with_warnings', 'failed', 'stopped', 'interrupted'] as const) {
      const snapshot = makeSnapshot()
      snapshot.activeWorkPlan = {
        ...snapshot.activeWorkPlan!,
        status,
        completedAt: '2026-05-29T00:10:00Z',
      }

      render(snapshot)

      expect(container.textContent).not.toContain('In progress')
      expect(container.textContent).not.toContain('Todo')
    }
  })

  it('formats attention header summaries', () => {
    expect(getHeaderSummary(makeSnapshot())).toBe('Blocked · 1 needs review')
  })
})
