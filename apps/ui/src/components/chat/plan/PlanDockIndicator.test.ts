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
  it('shows completed progress rather than the active item ordinal', () => {
    act(() => root.render(createElement(PlanDockIndicator, {
      snapshot: {
        ...snapshot,
        plan: Array.from({ length: 13 }, (_, index) => ({
          step: `Step ${index + 1}`,
          status: index < 11
            ? 'completed' as const
            : index === 12
              ? 'in_progress' as const
              : 'pending' as const,
        })),
      },
    })))

    expect(container.textContent).toContain('11/13 done')
    expect(container.textContent).not.toContain('Step 13/13')
    expect(container.querySelector('button')?.getAttribute('aria-label'))
      .toBe('Open working plan, 11/13 done')
    expect(container.firstElementChild?.className).toBe('relative z-20 h-0 shrink-0')
    expect(container.firstElementChild?.firstElementChild?.className)
      .toBe('absolute inset-x-0 bottom-1 flex justify-center px-3')
  })

  it('shows zero completed progress when no items are done', () => {
    act(() => root.render(createElement(PlanDockIndicator, {
      snapshot: {
        ...snapshot,
        plan: snapshot.plan.map((step, index) => ({
          ...step,
          status: index === 0 ? 'in_progress' as const : 'pending' as const,
        })),
      },
    })))

    expect(container.textContent).toContain('0/3 done')
    expect(container.querySelector('button')?.getAttribute('aria-label'))
      .toBe('Open working plan, 0/3 done')
  })

  it('preserves completed plan labeling and hides when no plan exists', () => {
    act(() => root.render(createElement(PlanDockIndicator, {
      snapshot: {
        ...snapshot,
        plan: snapshot.plan.map((step) => ({ ...step, status: 'completed' as const })),
      },
    })))
    expect(container.textContent).toContain('Plan complete')
    expect(container.querySelector('button')?.getAttribute('aria-label'))
      .toBe('Open working plan, Plan complete')

    act(() => root.render(createElement(PlanDockIndicator, { snapshot: null })))
    expect(container.textContent).toBe('')
  })
})
