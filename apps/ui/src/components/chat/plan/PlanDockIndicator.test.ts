/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionPlanSnapshotEvent } from '@forge/protocol'
import { PlanDockIndicator } from './PlanDockIndicator'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

const snapshot: SessionPlanSnapshotEvent = {
  type: 'session_plan_snapshot',
  sessionAgentId: 'session-1',
  profileId: 'profile-1',
  revision: 2,
  updatedAt: '2026-07-13T00:00:00.000Z',
  plan: [
    { step: 'Inspect behavior', status: 'completed' },
    { step: 'Implement the dock', status: 'in_progress' },
    { step: 'Verify the result', status: 'pending' },
  ],
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PlanDockIndicator', () => {
  it('shows the current step position in a persistent compact trigger', () => {
    act(() => root.render(createElement(PlanDockIndicator, { snapshot })))

    expect(container.textContent).toContain('Step 2/3')
    expect(container.querySelector('button')?.getAttribute('aria-label'))
      .toBe('Open working plan, Step 2/3')
    expect(container.firstElementChild?.className).toContain('pb-1')
  })

  it('shows a completed state and hides when no plan exists', () => {
    act(() => root.render(createElement(PlanDockIndicator, {
      snapshot: {
        ...snapshot,
        plan: snapshot.plan.map((step) => ({ ...step, status: 'completed' as const })),
      },
    })))
    expect(container.textContent).toContain('3/3 complete')

    act(() => root.render(createElement(PlanDockIndicator, { snapshot: null })))
    expect(container.textContent).toBe('')
  })

  it('summarizes multiple active steps and completed progress', () => {
    act(() => root.render(createElement(PlanDockIndicator, {
      snapshot: {
        ...snapshot,
        plan: snapshot.plan.map((step, index) => index === 2
          ? { ...step, status: 'in_progress' as const }
          : step),
      },
    })))

    expect(container.textContent).toContain('2 active · 1/3 complete')
    expect(container.querySelector('button')?.getAttribute('aria-label'))
      .toBe('Open working plan, 2 active · 1/3 complete')
  })
})
