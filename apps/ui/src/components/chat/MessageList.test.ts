/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationEntry, SessionTaskStateSnapshotEvent } from '@forge/protocol'
import { MessageList } from './MessageList'

let root: Root
let container: HTMLDivElement
const now = '2026-05-30T00:00:00.000Z'
const originalResizeObserver = globalThis.ResizeObserver
const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0)) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => window.clearTimeout(id)) as typeof cancelAnimationFrame
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  globalThis.ResizeObserver = originalResizeObserver
  globalThis.requestAnimationFrame = originalRequestAnimationFrame
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  vi.restoreAllMocks()
})

function makeWorkPlanCreated(): Extract<ConversationEntry, { type: 'work_plan_created' }> {
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
      title: 'Timeline plan',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
      items: [{
        itemId: 'item-1',
        title: 'Timeline item',
        status: 'todo',
        workerLinks: [{
          type: 'worker',
          linkId: 'link-1',
          agentId: 'worker-1',
          label: 'Frontend worker',
          linkedAt: now,
        }],
        workerLinkCount: 1,
        workerLinksTruncated: false,
      }],
      itemCount: 1,
      itemsTruncated: false,
      warnings: [],
      warningCount: 0,
      warningsTruncated: false,
    },
  }
}

function render(messages: ConversationEntry[], extraProps: Record<string, unknown> = {}) {
  flushSync(() => {
    root.render(createElement(MessageList, {
      messages,
      isLoading: false,
      activeAgentId: 'session-1',
      pendingChoiceIds: new Set<string>(),
      agents: [],
      statuses: {},
      ...extraProps,
    }))
  })
}

function makeActiveWorkSnapshot(overrides: Partial<SessionTaskStateSnapshotEvent> = {}): SessionTaskStateSnapshotEvent {
  return {
    type: 'session_task_state_snapshot',
    sessionAgentId: 'session-1',
    profileId: 'profile-1',
    revision: 1,
    activeWorkPlan: {
      planId: 'plan-1',
      title: 'Live plan',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
      items: [{
        itemId: 'item-1',
        title: 'Live item',
        status: 'active',
        workerLinks: [{ type: 'worker', linkId: 'link-1', agentId: 'worker-1', label: 'Frontend worker', linkedAt: now }],
        workerLinkCount: 1,
        workerLinksTruncated: false,
      }],
      itemCount: 1,
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

describe('MessageList system diagnostic rows', () => {
  it('replays manager no-op diagnostics as normal non-assistant system messages', () => {
    const onFeedbackVote = vi.fn().mockResolvedValue(undefined)
    render([
      {
        type: 'conversation_message',
        agentId: 'session-1',
        id: 'noop-diagnostic-1',
        role: 'system',
        text: 'Manager returned no visible action after a worker update. Forge sent an internal recovery nudge.',
        timestamp: now,
        source: 'system',
      },
    ], { onFeedbackVote })

    const systemNote = container.querySelector('[role="note"][aria-label="System message"]')
    expect(systemNote).toBeTruthy()
    expect(systemNote!.textContent).toContain('Manager returned no visible action after a worker update')
    expect(container.querySelector('[aria-label="Thumbs up"]')).toBeNull()
    expect(onFeedbackVote).not.toHaveBeenCalled()
  })
})

describe('MessageList work_plan_created rows', () => {
  it('renders the creation receipt chronologically between adjacent conversation entries', () => {
    render([
      { type: 'conversation_message', agentId: 'session-1', role: 'user', text: 'before work plan', timestamp: now, source: 'user_input' },
      makeWorkPlanCreated(),
      { type: 'conversation_message', agentId: 'session-1', role: 'assistant', text: 'after work plan', timestamp: now, source: 'speak_to_user' },
    ])

    const text = container.textContent ?? ''
    const beforeIndex = text.indexOf('before work plan')
    const rowIndex = text.indexOf('Work Plan created: Timeline plan')
    const afterIndex = text.indexOf('after work plan')

    expect(beforeIndex).toBeGreaterThanOrEqual(0)
    expect(rowIndex).toBeGreaterThan(beforeIndex)
    expect(afterIndex).toBeGreaterThan(rowIndex)
    expect(container.querySelector('[data-message-id="work-plan-created-1"]')).toBeTruthy()
  })

  it('hydrates timeline receipts from matching latest task snapshot state', () => {
    render([makeWorkPlanCreated()], {
      activeWorkSnapshot: makeActiveWorkSnapshot({
        activeWorkPlan: {
          ...makeActiveWorkSnapshot().activeWorkPlan!,
          title: 'Timeline plan',
          status: 'completed',
          revision: 3,
          finalSummary: 'The plan is now complete.',
          items: [{
            ...makeActiveWorkSnapshot().activeWorkPlan!.items[0],
            title: 'Completed timeline item',
            status: 'done',
          }],
        },
      }),
    })

    const receiptRow = container.querySelector('[data-message-id="work-plan-created-1"]')
    expect(receiptRow).toBeTruthy()
    expect(receiptRow!.textContent).toContain('Work Plan created: Timeline plan')
    expect(receiptRow!.textContent).toContain('Completed')
    expect(receiptRow!.textContent).not.toContain('Timeline item')

    const receiptToggle = receiptRow!.querySelector<HTMLButtonElement>('button[aria-label^="Expand Work Plan created"]')
    flushSync(() => receiptToggle?.click())

    expect(receiptRow!.textContent).toContain('Completed timeline item')
    expect(receiptRow!.textContent).toContain('The plan is now complete.')
    expect(receiptRow!.textContent).toContain('Done')
    expect(receiptRow!.textContent).not.toContain('Todo')
    expect(receiptRow!.textContent).not.toContain('In progress')
  })

  it('falls back to the creation snapshot when no matching latest task state exists', () => {
    render([makeWorkPlanCreated()], {
      activeWorkSnapshot: makeActiveWorkSnapshot({
        activeWorkPlan: {
          ...makeActiveWorkSnapshot().activeWorkPlan!,
          planId: 'other-plan',
          title: 'Different live plan',
          status: 'completed',
        },
      }),
    })

    const receiptRow = container.querySelector('[data-message-id="work-plan-created-1"]')
    expect(receiptRow).toBeTruthy()
    expect(receiptRow!.textContent).toContain('Work Plan created: Timeline plan')
    expect(receiptRow!.textContent).toContain('Active Work')

    const receiptToggle = receiptRow!.querySelector<HTMLButtonElement>('button[aria-label^="Expand Work Plan created"]')
    flushSync(() => receiptToggle?.click())

    expect(receiptRow!.textContent).toContain('Timeline item')
    expect(receiptRow!.textContent).toContain('Todo')
  })

  it('forwards onNavigateToWorker to timeline receipts', () => {
    const onNavigateToWorker = vi.fn()
    render([makeWorkPlanCreated()], {
      onNavigateToWorker,
      agents: [
        { agentId: 'worker-1', displayName: 'Frontend worker', role: 'worker', managerId: 'session-1', status: 'idle' } as never,
      ],
      statuses: { 'worker-1': { status: 'idle' } },
    })

    const receiptRow = container.querySelector('[data-message-id="work-plan-created-1"]')
    expect(receiptRow).toBeTruthy()

    const receiptToggle = receiptRow!.querySelector<HTMLButtonElement>('button[aria-label^="Expand Work Plan created"]')
    flushSync(() => receiptToggle?.click())

    const receiptItemButton = Array.from(receiptRow!.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Timeline item'))
    expect(receiptItemButton).toBeTruthy()
    flushSync(() => receiptItemButton?.click())

    const receiptWorkerButton = Array.from(receiptRow!.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.getAttribute('aria-label')?.includes('Frontend worker'))
    expect(receiptWorkerButton).toBeTruthy()
    flushSync(() => receiptWorkerButton?.click())
    expect(onNavigateToWorker).toHaveBeenCalledWith('worker-1')
  })

  it('forwards onNavigateToWorker to the Active Work card', () => {
    const onNavigateToWorker = vi.fn()
    render([], {
      onNavigateToWorker,
      agents: [
        { agentId: 'worker-1', displayName: 'Frontend worker', role: 'worker', managerId: 'session-1', status: 'idle' } as never,
      ],
      statuses: { 'worker-1': { status: 'idle' } },
      activeWorkSnapshot: makeActiveWorkSnapshot(),
      activeWorkExpanded: true,
    })

    const activeWorkSection = container.querySelector('[aria-label="Active Work plan"]')
    expect(activeWorkSection).toBeTruthy()

    const liveItemButton = Array.from(activeWorkSection!.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Live item'))
    expect(liveItemButton).toBeTruthy()
    flushSync(() => liveItemButton?.click())

    const liveWorkerButton = Array.from(activeWorkSection!.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.getAttribute('aria-label')?.includes('Frontend worker'))
    expect(liveWorkerButton).toBeTruthy()
    flushSync(() => liveWorkerButton?.click())
    expect(onNavigateToWorker).toHaveBeenCalledWith('worker-1')
  })
})
