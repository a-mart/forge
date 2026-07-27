/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlanSummaryEvent } from '@forge/protocol'
import { PlanSummaryRow } from './PlanSummaryRow'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

const summary: PlanSummaryEvent = {
  type: 'plan_summary',
  id: 'summary-1',
  agentId: 'session-1',
  timestamp: '2026-07-13T01:00:00.000Z',
  revision: 3,
  updatedAt: '2026-07-13T00:59:00.000Z',
  explanation: 'The implementation and verification are complete.',
  plan: [
    { step: 'Implement the change', status: 'completed' },
    { step: 'Verify the result', status: 'completed' },
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

describe('PlanSummaryRow', () => {
  it('renders a collapsed completed receipt and expands to the frozen steps', () => {
    act(() => root.render(createElement(PlanSummaryRow, { summary })))

    expect(container.textContent).toContain('Plan complete')
    expect(container.textContent).toContain('2/2')
    expect(container.textContent).not.toContain('Implement the change')

    act(() => container.querySelector('button')?.click())

    expect(container.textContent).toContain('Implement the change')
    expect(container.textContent).toContain('Verify the result')
    expect(container.textContent).toContain('2 of 2 completed')
  })

  it('renders the latest current snapshot inside an active anchored card', () => {
    act(() => root.render(createElement(PlanSummaryRow, {
      summary: {
        ...summary,
        state: 'active',
        revision: 1,
        explanation: 'Starting work.',
        plan: [{ step: 'Implement the change', status: 'in_progress' }],
      },
      currentSnapshot: {
        type: 'session_plan_snapshot',
        sessionAgentId: 'session-1',
        profileId: 'profile-1',
        revision: 2,
        updatedAt: '2026-07-13T01:01:00.000Z',
        explanation: 'Parallel work is underway.',
        plan: [
          { step: 'Implement the change', status: 'in_progress' },
          { step: 'Verify the result', status: 'in_progress' },
        ],
      },
    })))

    expect(container.textContent).toContain('Working plan')
    expect(container.textContent).toContain('2 steps in progress')
    expect(container.textContent).toContain('0/2')
  })

  it('replays a completed graph in graph view with the compact list still available', () => {
    act(() => root.render(createElement(PlanSummaryRow, {
      summary: graphSummary(),
    })))
    act(() => container.querySelector('button')?.click())

    expect(container.querySelector('[data-work-graph-view="graph"]')).not.toBeNull()
    const listButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'List')
    expect(listButton).not.toBeNull()

    act(() => listButton?.click())
    expect(container.querySelector('[data-work-graph-view="list"]')).not.toBeNull()
    expect(container.textContent).toContain('After Inspect implementation')
  })
})

function graphSummary(): PlanSummaryEvent {
  return {
    ...summary,
    coordinationMode: 'graph',
    plan: [
      { step: 'Inspect implementation', status: 'completed' },
      { step: 'Review result', status: 'completed' },
    ],
    workGraph: {
      maxConcurrency: 1,
      nodes: [
        {
          id: 'inspect',
          title: 'Inspect implementation',
          task: 'Inspect the implementation.',
          kind: 'research',
          status: 'completed',
          dependsOn: [],
          route: 'auto',
          effort: 'support',
          attempts: [],
        },
        {
          id: 'review',
          title: 'Review result',
          task: 'Review the accepted result.',
          kind: 'review',
          status: 'completed',
          dependsOn: ['inspect'],
          route: 'auto',
          effort: 'routine',
          attempts: [],
        },
      ],
    },
  }
}
