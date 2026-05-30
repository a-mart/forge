/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkPlanCreatedEvent } from '@forge/protocol'
import { WorkPlanCreatedRow } from './WorkPlanCreatedRow'

let root: Root
let container: HTMLDivElement

const now = '2026-05-30T00:00:00.000Z'

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

function makeEvent(overrides: Partial<WorkPlanCreatedEvent> = {}): WorkPlanCreatedEvent {
  return {
    type: 'work_plan_created',
    agentId: 'session-1',
    id: 'work-plan-created-1',
    timestamp: now,
    planId: 'plan-1',
    stateRevision: 1,
    planRevision: 1,
    plan: {
      planId: 'plan-1',
      title: 'Historical receipt plan',
      goal: 'Show a creation receipt in chat',
      mode: 'standard',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
      items: [
        { itemId: 'item-1', title: 'Initial item', status: 'active', workerLinks: [], workerLinkCount: 0, workerLinksTruncated: false },
      ],
      itemCount: 1,
      itemsTruncated: false,
      warnings: [],
      warningCount: 0,
      warningsTruncated: false,
    },
    ...overrides,
  }
}

function render(event: WorkPlanCreatedEvent = makeEvent()) {
  flushSync(() => {
    root.render(createElement(WorkPlanCreatedRow, { event, agents: [], statuses: {} }))
  })
}

describe('WorkPlanCreatedRow', () => {
  it('renders a collapsed immutable creation receipt with accessible expansion', () => {
    render()

    expect(container.textContent).toContain('Work Plan created: Historical receipt plan')
    expect(container.textContent).toContain('standard mode')
    expect(container.textContent).toContain('1 item')
    expect(container.textContent).not.toContain('Initial item')

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Expand Work Plan created: Historical receipt plan"]')
    expect(toggle).toBeTruthy()
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    const controls = toggle?.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    expect(document.getElementById(controls!)?.hidden).toBe(true)

    flushSync(() => toggle?.click())

    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(controls!)?.hidden).toBe(false)
    expect(container.textContent).toContain('Initial item')
  })

  it('uses terminal status normalization inside expanded receipts', () => {
    render(makeEvent({
      planRevision: 2,
      plan: {
        ...makeEvent().plan,
        status: 'completed',
        revision: 2,
        finalSummary: 'Done at creation time.',
      },
    }))

    const toggle = container.querySelector<HTMLButtonElement>('button')
    flushSync(() => toggle?.click())

    expect(container.textContent).toContain('Done at creation time.')
    expect(container.textContent).toContain('Done')
    expect(container.textContent).not.toContain('In progress')
  })
})
