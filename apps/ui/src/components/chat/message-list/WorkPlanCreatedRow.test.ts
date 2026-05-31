/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
        {
          itemId: 'item-1',
          title: 'Initial item',
          status: 'active',
          workerLinks: [{
            type: 'worker',
            linkId: 'link-1',
            agentId: 'worker-1',
            label: 'Frontend worker',
            linkedAt: now,
          }],
          workerLinkCount: 1,
          workerLinksTruncated: false,
        },
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

  it('hydrates the receipt display from the latest matching plan when provided', () => {
    const event = makeEvent()
    flushSync(() => {
      root.render(createElement(WorkPlanCreatedRow, {
        event,
        agents: [],
        statuses: {},
        latestPlan: {
          ...event.plan,
          status: 'completed',
          revision: 4,
          updatedAt: '2026-05-30T00:10:00.000Z',
          finalSummary: 'Finished after the receipt was created.',
          items: [{
            ...event.plan.items[0],
            title: 'Completed item',
            status: 'done',
          }],
        },
      }))
    })

    expect(container.textContent).toContain('Work Plan created: Historical receipt plan')
    expect(container.textContent).toContain('Completed')
    expect(container.textContent).not.toContain('Initial item')

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label^="Expand Work Plan created"]')
    flushSync(() => toggle?.click())

    expect(container.textContent).toContain('Completed item')
    expect(container.textContent).toContain('Finished after the receipt was created.')
    expect(container.textContent).toContain('Done')
    expect(container.textContent).not.toContain('In progress')
  })

  it('navigates to same-session worker chips from historical receipts', () => {
    const onNavigateToWorker = vi.fn()
    flushSync(() => {
      root.render(createElement(WorkPlanCreatedRow, {
        event: makeEvent(),
        agents: [
          { agentId: 'worker-1', displayName: 'Frontend worker', role: 'worker', managerId: 'session-1', status: 'idle' } as never,
        ],
        statuses: { 'worker-1': { status: 'idle' } },
        onNavigateToWorker,
      }))
    })

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label^="Expand Work Plan created"]')
    flushSync(() => toggle?.click())

    const itemButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Initial item'))
    flushSync(() => itemButton?.click())

    const workerButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.getAttribute('aria-label')?.includes('Frontend worker'))
    expect(workerButton).toBeTruthy()
    flushSync(() => workerButton?.click())
    expect(onNavigateToWorker).toHaveBeenCalledWith('worker-1')
  })

  it('keeps cross-session receipt worker links static', () => {
    flushSync(() => {
      root.render(createElement(WorkPlanCreatedRow, {
        event: makeEvent({
          plan: {
            ...makeEvent().plan,
            items: [{
              itemId: 'item-1',
              title: 'Initial item',
              status: 'active',
              workerLinks: [{
                type: 'worker',
                linkId: 'link-stale',
                agentId: 'cross-session-worker',
                label: 'Cross session worker',
                linkedAt: now,
              }],
              workerLinkCount: 1,
              workerLinksTruncated: false,
            }],
          },
        }),
        agents: [
          { agentId: 'cross-session-worker', displayName: 'Cross session worker', role: 'worker', managerId: 'other-session', status: 'idle' } as never,
        ],
        statuses: {},
        onNavigateToWorker: vi.fn(),
      }))
    })

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label^="Expand Work Plan created"]')
    flushSync(() => toggle?.click())

    const itemButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Initial item'))
    expect(itemButton).toBeTruthy()
    flushSync(() => itemButton?.click())

    expect(container.textContent).toContain('Worker unavailable')
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.getAttribute('aria-label')?.includes('Cross session worker'))).toBeUndefined()
  })
})
