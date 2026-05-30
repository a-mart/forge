/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationEntry } from '@forge/protocol'
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
      items: [{ itemId: 'item-1', title: 'Timeline item', status: 'todo', workerLinks: [], workerLinkCount: 0, workerLinksTruncated: false }],
      itemCount: 1,
      itemsTruncated: false,
      warnings: [],
      warningCount: 0,
      warningsTruncated: false,
    },
  }
}

function render(messages: ConversationEntry[]) {
  flushSync(() => {
    root.render(createElement(MessageList, {
      messages,
      isLoading: false,
      activeAgentId: 'session-1',
      pendingChoiceIds: new Set<string>(),
      agents: [],
      statuses: {},
    }))
  })
}

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
})
