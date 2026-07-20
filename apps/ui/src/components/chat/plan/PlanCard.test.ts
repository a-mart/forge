/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionPlanSnapshotEvent } from '@forge/protocol'
import { PlanCard } from './PlanCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

const snapshot: SessionPlanSnapshotEvent = {
  type: 'session_plan_snapshot',
  sessionAgentId: 'session-1',
  profileId: 'profile-1',
  revision: 2,
  updatedAt: '2026-07-12T00:00:00.000Z',
  explanation: 'Implementation is ready for verification.',
  plan: [
    { step: 'Inspect existing behavior', status: 'completed' },
    { step: 'Run focused verification', status: 'in_progress' },
    { step: 'Summarize the result', status: 'pending' },
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

describe('PlanCard', () => {
  it('shows the current step and expands into the complete plan', () => {
    act(() => root.render(createElement(PlanCard, {
      snapshot,
      expanded: false,
      onExpandedChange: () => {},
    })))

    expect(container.textContent).toContain('Working plan')
    expect(container.textContent).toContain('Run focused verification')
    expect(container.textContent).toContain('1/3')

    act(() => root.render(createElement(PlanCard, {
      snapshot,
      expanded: true,
      onExpandedChange: () => {},
    })))

    expect(container.textContent).toContain('Inspect existing behavior')
    expect(container.textContent).toContain('Summarize the result')
    expect(container.textContent).toContain('1 of 3 completed')
  })

  it('summarizes multiple concurrently active steps when collapsed', () => {
    act(() => root.render(createElement(PlanCard, {
      snapshot: {
        ...snapshot,
        plan: snapshot.plan.map((step, index) => index === 2
          ? { ...step, status: 'in_progress' as const }
          : step),
      },
      expanded: false,
      onExpandedChange: () => {},
    })))

    expect(container.textContent).toContain('2 steps in progress')
  })

  it('opens a live work graph in graph view by default', () => {
    act(() => root.render(createElement(PlanCard, {
      snapshot: graphSnapshot(),
      expanded: true,
      onExpandedChange: () => {},
    })))

    expect(container.textContent).toContain('Dynamic work graph')
    expect(container.querySelector('[data-work-graph-view="graph"]')).not.toBeNull()
    const graphButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Graph')
    expect(graphButton?.getAttribute('aria-pressed')).toBe('true')
  })
})

function graphSnapshot(): SessionPlanSnapshotEvent {
  return {
    ...snapshot,
    coordinationMode: 'graph',
    plan: [
      { step: 'Inspect existing behavior', status: 'completed' },
      { step: 'Run focused verification', status: 'in_progress' },
    ],
    workGraph: {
      maxConcurrency: 2,
      nodes: [
        {
          id: 'inspect',
          title: 'Inspect existing behavior',
          task: 'Inspect the current implementation.',
          kind: 'research',
          status: 'completed',
          dependsOn: [],
          effort: 'support',
          attempts: [],
        },
        {
          id: 'verify',
          title: 'Run focused verification',
          task: 'Verify the accepted implementation.',
          kind: 'review',
          status: 'running',
          dependsOn: ['inspect'],
          effort: 'routine',
          attempts: [],
        },
      ],
    },
  }
}
