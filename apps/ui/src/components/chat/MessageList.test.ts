/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationEntry } from '@forge/protocol'
import { MessageList } from './MessageList'
import {
  installVirtualizationHarness,
  type VirtualizationHarness,
} from './message-list/test-virtualization-harness'

let root: Root
let container: HTMLDivElement
let virt: VirtualizationHarness
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
  // Tall viewport so these small fixtures fully render through the virtualizer.
  virt = installVirtualizationHarness()
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  virt.restore()
  globalThis.ResizeObserver = originalResizeObserver
  globalThis.requestAnimationFrame = originalRequestAnimationFrame
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  vi.restoreAllMocks()
})

function makeChoiceRequest(
  overrides: Partial<Extract<ConversationEntry, { type: 'choice_request' }>> = {},
): Extract<ConversationEntry, { type: 'choice_request' }> {
  return {
    type: 'choice_request',
    agentId: 'session-1',
    choiceId: 'choice-1',
    questions: [
      {
        id: 'q1',
        question: 'Pick one',
        options: [{ id: 'a', label: 'Alpha' }],
      },
    ],
    status: 'pending',
    timestamp: now,
    ...overrides,
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

describe('MessageList choice requests', () => {
  it('submits and cancels manager-active worker-origin session choices with the session agent id', () => {
    const onChoiceSubmit = vi.fn()
    const onChoiceCancel = vi.fn()
    render([makeChoiceRequest({ agentId: 'worker-1', sessionAgentId: 'session-1' })], {
      activeAgentId: 'session-1',
      pendingChoiceIds: new Set(['choice-1']),
      onChoiceSubmit,
      onChoiceCancel,
    })

    const option = container.querySelector<HTMLButtonElement>('button[aria-pressed]')
    expect(option).toBeTruthy()
    flushSync(() => option?.click())

    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Submit',
    )
    expect(submit).toBeTruthy()
    flushSync(() => submit?.click())

    expect(onChoiceSubmit).toHaveBeenCalledWith('session-1', 'choice-1', [
      { questionId: 'q1', selectedOptionIds: ['a'], text: undefined },
    ])

    render([makeChoiceRequest({ choiceId: 'choice-2', agentId: 'worker-1', sessionAgentId: 'session-1' })], {
      activeAgentId: 'session-1',
      pendingChoiceIds: new Set(['choice-2']),
      onChoiceSubmit,
      onChoiceCancel,
    })

    const skip = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Skip',
    )
    expect(skip).toBeTruthy()
    flushSync(() => skip?.click())

    expect(onChoiceCancel).toHaveBeenCalledWith('session-1', 'choice-2')
  })

  it('submits and cancels worker-active worker-origin session choices with the worker agent id', () => {
    const onChoiceSubmit = vi.fn()
    const onChoiceCancel = vi.fn()
    render([makeChoiceRequest({ agentId: 'worker-1', sessionAgentId: 'session-1' })], {
      activeAgentId: 'worker-1',
      pendingChoiceIds: new Set(['choice-1']),
      onChoiceSubmit,
      onChoiceCancel,
    })

    const option = container.querySelector<HTMLButtonElement>('button[aria-pressed]')
    expect(option).toBeTruthy()
    flushSync(() => option?.click())

    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Submit',
    )
    expect(submit).toBeTruthy()
    flushSync(() => submit?.click())

    expect(onChoiceSubmit).toHaveBeenCalledWith('worker-1', 'choice-1', [
      { questionId: 'q1', selectedOptionIds: ['a'], text: undefined },
    ])

    render([makeChoiceRequest({ choiceId: 'choice-2', agentId: 'worker-1', sessionAgentId: 'session-1' })], {
      activeAgentId: 'worker-1',
      pendingChoiceIds: new Set(['choice-2']),
      onChoiceSubmit,
      onChoiceCancel,
    })

    const skip = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Skip',
    )
    expect(skip).toBeTruthy()
    flushSync(() => skip?.click())

    expect(onChoiceCancel).toHaveBeenCalledWith('worker-1', 'choice-2')
  })

  it('submits legacy manager-origin choices with the manager agent id', () => {
    const onChoiceSubmit = vi.fn()
    render([makeChoiceRequest({ agentId: 'session-1', sessionAgentId: undefined })], {
      activeAgentId: 'session-1',
      pendingChoiceIds: new Set(['choice-1']),
      onChoiceSubmit,
    })

    const option = container.querySelector<HTMLButtonElement>('button[aria-pressed]')
    flushSync(() => option?.click())
    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Submit',
    )
    flushSync(() => submit?.click())

    expect(onChoiceSubmit).toHaveBeenCalledWith('session-1', 'choice-1', [
      { questionId: 'q1', selectedOptionIds: ['a'], text: undefined },
    ])
  })

  it('renders missing-details fallback and cancels against active session id', () => {
    const onChoiceCancel = vi.fn()
    render([], {
      pendingChoiceIds: new Set(['missing-choice']),
      missingPendingChoiceIds: ['missing-choice'],
      onChoiceCancel,
    })

    expect(container.textContent).toContain('Input request details unavailable')
    expect(container.textContent).toContain('Choice ID: missing-choice')

    const skip = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Skip',
    )
    expect(skip).toBeTruthy()
    flushSync(() => skip?.click())

    expect(onChoiceCancel).toHaveBeenCalledWith('session-1', 'missing-choice')
  })

  it('keeps a pending choice row visible after submit until backend clears it', () => {
    const onChoiceSubmit = vi.fn()
    render([makeChoiceRequest()], {
      pendingChoiceIds: new Set(['choice-1']),
      onChoiceSubmit,
    })

    const option = container.querySelector<HTMLButtonElement>('button[aria-pressed]')
    flushSync(() => option?.click())
    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Submit',
    )
    flushSync(() => submit?.click())

    expect(onChoiceSubmit).toHaveBeenCalled()
    expect(container.textContent).toContain('Input requested')
    expect(container.textContent).toContain('Pick one')
  })
})

describe('MessageList plan summaries', () => {
  it('renders a durable completed-plan card in transcript order', () => {
    render([{
      type: 'plan_summary',
      id: 'summary-1',
      agentId: 'session-1',
      timestamp: now,
      revision: 2,
      updatedAt: now,
      explanation: 'The first plan is complete.',
      plan: [{ step: 'Finish the first plan', status: 'completed' }],
    }])

    expect(container.textContent).toContain('Plan complete')
    expect(container.textContent).toContain('The first plan is complete.')
  })

  it('keeps one inline row at its original position while an anchored plan updates', () => {
    render([
      {
        type: 'plan_summary',
        id: 'plan-card-1',
        agentId: 'session-1',
        timestamp: now,
        state: 'active',
        revision: 1,
        updatedAt: now,
        plan: [{ step: 'Start implementation', status: 'in_progress' }],
      },
      {
        type: 'plan_summary',
        id: 'plan-card-1',
        agentId: 'session-1',
        timestamp: now,
        state: 'completed',
        revision: 2,
        updatedAt: now,
        explanation: 'Implementation is complete.',
        plan: [{ step: 'Start implementation', status: 'completed' }],
      },
    ], {
      planSnapshot: {
        type: 'session_plan_snapshot',
        sessionAgentId: 'session-1',
        profileId: 'profile-1',
        revision: 2,
        updatedAt: now,
        explanation: 'Implementation is complete.',
        plan: [{ step: 'Start implementation', status: 'completed' }],
      },
    })

    expect(container.querySelectorAll('section[aria-label="Completed plan"]')).toHaveLength(1)
    expect(container.textContent).toContain('Implementation is complete.')
  })
})

describe('MessageList paged activity', () => {
  it('renders the bounded canonical summary without raw tool output', () => {
    render([{
      type: 'activity_summary',
      schemaVersion: 1,
      itemId: 'tool:session-1:tool-1',
      agentId: 'session-1',
      actorAgentId: 'session-1',
      timestamp: now,
      kind: 'tool_activity',
      status: 'completed',
      toolName: 'unmapped_provider_tool',
      correlationId: 'tool-1',
      displaySummary: 'Completed provider activity',
    }])

    expect(container.textContent).toContain('Completed provider activity')
    expect(container.textContent).not.toContain('raw tool output')
  })

  it('keeps richer live tool detail and failure wording when a summary converges', () => {
    render([
      {
        type: 'conversation_log',
        agentId: 'session-1',
        timestamp: now,
        source: 'runtime_log',
        kind: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'tool-1',
        text: JSON.stringify({ command: 'pnpm test' }),
      },
      {
        type: 'conversation_log',
        agentId: 'session-1',
        timestamp: now,
        source: 'runtime_log',
        kind: 'tool_execution_end',
        toolName: 'bash',
        toolCallId: 'tool-1',
        text: 'test failed',
        isError: true,
      },
      {
        type: 'activity_summary',
        schemaVersion: 1,
        itemId: 'tool:session-1:tool-1',
        agentId: 'session-1',
        actorAgentId: 'session-1',
        timestamp: now,
        kind: 'tool_activity',
        status: 'failed',
        toolName: 'bash',
        correlationId: 'tool-1',
        displaySummary: 'Ran command',
        isError: true,
      },
    ])

    expect(container.textContent).toContain('Command failed: pnpm test')
  })

  it('lets richer live tool detail replace a summary that arrived first', () => {
    render([
      {
        type: 'activity_summary',
        schemaVersion: 1,
        itemId: 'tool:session-1:tool-1',
        agentId: 'session-1',
        actorAgentId: 'session-1',
        timestamp: now,
        kind: 'tool_activity',
        status: 'completed',
        toolName: 'bash',
        correlationId: 'tool-1',
        displaySummary: 'Completed provider activity',
      },
      {
        type: 'conversation_log',
        agentId: 'session-1',
        timestamp: now,
        source: 'runtime_log',
        kind: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'tool-1',
        text: JSON.stringify({ command: 'pnpm test' }),
      },
      {
        type: 'conversation_log',
        agentId: 'session-1',
        timestamp: now,
        source: 'runtime_log',
        kind: 'tool_execution_end',
        toolName: 'bash',
        toolCallId: 'tool-1',
        text: 'tests passed',
      },
    ])

    expect(container.textContent).toContain('Ran command: pnpm test')
    expect(container.textContent).not.toContain('Completed provider activity')
  })

  it('offers a manual fallback when automatic observation is unavailable', () => {
    const onLoadOlder = vi.fn()
    render([], { hasOlder: true, olderCursor: 'cursor-1', onLoadOlder })

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Load older conversation items"]')
    expect(button).toBeTruthy()
    flushSync(() => button?.click())
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('never renders the ordinary empty state while a cold bootstrap is pending', () => {
    render([], { conversationBootstrapPhase: 'pending' })
    expect(container.textContent).toContain('Loading conversation…')
    expect(container.textContent).not.toContain('Start a conversation')
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  it('keeps stale rows visible with an accessible refresh failure and Retry', () => {
    const onRetryBootstrap = vi.fn()
    render([{
      type: 'conversation_message', agentId: 'session-1', id: 'cached', role: 'assistant',
      text: 'Previous cached row', timestamp: now, source: 'speak_to_user',
    }], {
      conversationBootstrapPhase: 'error',
      hasStalePresentation: true,
      onRetryBootstrap,
    })
    expect(container.textContent).toContain('Previous cached row')
    expect(container.textContent).toContain('Couldn’t refresh. Showing previous messages.')
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry')
    flushSync(() => retry?.click())
    expect(onRetryBootstrap).toHaveBeenCalledOnce()
  })

  it('keeps the timeline refresh action enabled after the source changes', () => {
    const onLoadOlder = vi.fn()
    render([], {
      hasOlder: true,
      historyCompleteness: 'source_changed',
      onLoadOlder,
    })

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh changed conversation timeline"]')
    expect(button?.disabled).toBe(false)
    expect(button?.textContent).toContain('refresh')
    flushSync(() => button?.click())
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })
})
