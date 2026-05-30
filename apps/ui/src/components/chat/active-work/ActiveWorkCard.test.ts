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
    expect(container.textContent).toContain('+5 more in plan')
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

  it('shows recent-plan truncation metadata for terminal receipts', () => {
    const snapshot = makeSnapshot({
      activeWorkPlan: null,
      recentWorkPlans: [makeRecentPlan(1)],
      recentWorkPlanCount: 4,
      recentWorkPlansTruncated: true,
    })

    render(snapshot)

    expect(container.textContent).toContain('Completed plan 1')
    expect(container.textContent).toContain('+3 more recent Work Plans not shown')
  })

  it('counts all recent plans as hidden when an active plan is rendered', () => {
    const snapshot = makeSnapshot({
      recentWorkPlans: [1, 2, 3, 4, 5].map(makeRecentPlan),
      recentWorkPlanCount: 8,
      recentWorkPlansTruncated: true,
    })

    render(snapshot)

    expect(container.textContent).toContain('Ship Active Work UI')
    expect(container.textContent).not.toContain('Completed plan 1')
    expect(container.textContent).toContain('+8 more recent Work Plans not shown')
  })

  it('counts returned-but-not-rendered recent plans when no active plan exists', () => {
    const snapshot = makeSnapshot({
      activeWorkPlan: null,
      recentWorkPlans: [1, 2, 3, 4].map(makeRecentPlan),
      recentWorkPlanCount: 4,
      recentWorkPlansTruncated: false,
    })

    render(snapshot)

    expect(container.textContent).toContain('Completed plan 1')
    expect(container.textContent).not.toContain('Completed plan 2')
    expect(container.textContent).toContain('+3 more recent Work Plans not shown')
  })

  it('formats attention header summaries', () => {
    expect(getHeaderSummary(makeSnapshot())).toBe('Blocked · 1 needs review')
  })
})
