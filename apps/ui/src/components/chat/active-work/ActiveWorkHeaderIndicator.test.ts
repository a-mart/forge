/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionTaskStateSnapshotEvent } from '@forge/protocol'
import { ActiveWorkHeaderIndicator } from './ActiveWorkHeaderIndicator'

let root: Root
let container: HTMLDivElement

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function makeSnapshot(overrides: Partial<SessionTaskStateSnapshotEvent> = {}): SessionTaskStateSnapshotEvent {
  return {
    type: 'session_task_state_snapshot',
    sessionAgentId: 'session-1',
    profileId: 'profile-1',
    revision: 1,
    activeWorkPlan: null,
    recentWorkPlans: [
      {
        planId: 'plan-1',
        title: 'Completed header plan',
        goal: 'Verify the header shows details without moving the transcript',
        status: 'completed',
        createdAt: '2026-05-29T00:00:00Z',
        updatedAt: '2026-05-29T00:01:00Z',
        completedAt: '2026-05-29T00:02:00Z',
        revision: 1,
        items: [
          { itemId: 'item-1', title: 'Keep scroll position stable', status: 'done', workerLinks: [], workerLinkCount: 0, workerLinksTruncated: false },
        ],
        itemCount: 1,
        itemsTruncated: false,
        warnings: [],
        warningCount: 0,
        warningsTruncated: false,
      },
    ],
    recentWorkPlanCount: 1,
    recentWorkPlansTruncated: false,
    ...overrides,
  }
}

function render(snapshot = makeSnapshot()) {
  act(() => {
    root.render(createElement(ActiveWorkHeaderIndicator, {
      snapshot,
      agents: [],
      statuses: {},
    }))
  })
}

describe('ActiveWorkHeaderIndicator', () => {
  it('opens an anchored popover instead of using transcript scroll/focus behavior', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render()

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open Active Work plan"]')
    expect(trigger).toBeTruthy()
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')

    act(() => trigger?.click())

    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[data-slot="popover-content"]')?.getAttribute('aria-label')).toBe('Active Work plan details')
    expect(document.body.textContent).toContain('Completed header plan')
    expect(document.body.textContent).toContain('Keep scroll position stable')
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('closes from the popover close button without scrolling the transcript', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render()

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open Active Work plan"]')
    act(() => trigger?.click())
    expect(document.body.textContent).toContain('Completed header plan')

    const close = document.body.querySelector<HTMLButtonElement>('button[aria-label="Close Active Work plan"]')
    expect(close).toBeTruthy()
    act(() => close?.click())

    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.textContent).not.toContain('Keep scroll position stable')
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
