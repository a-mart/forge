/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationMessageEvent } from '@forge/protocol'
import { ConversationMessageRow } from './ConversationMessageRow'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

function buildMessage(): ConversationMessageEvent {
  return {
    type: 'conversation_message',
    agentId: 'manager-1',
    id: 'msg-1',
    role: 'system',
    text: '',
    timestamp: '2026-05-30T10:30:00.000Z',
    source: 'system',
    externalThreadContext: {
      type: 'codex_app_server',
      sidecarAgentId: 'manager-1--codex',
      requestId: 'req-1',
      turnCorrelationId: 'turn-1',
      status: 'completed',
      promptPreview: 'Summarize my calendar',
      resultPreview: 'You have two meetings today.',
      excludeFromModelContext: true,
    },
  }
}

function buildNoOpDiagnosticMessage(): ConversationMessageEvent {
  return {
    type: 'conversation_message',
    agentId: 'manager-1',
    id: 'noop-diagnostic-1',
    role: 'system',
    text: 'Manager returned no visible action after a worker update. Forge sent an internal recovery nudge.',
    timestamp: '2026-05-30T10:31:00.000Z',
    source: 'system',
  }
}

describe('ConversationMessageRow', () => {
  it('renders manager no-op diagnostics as visible system notes without feedback controls', () => {
    const onFeedbackVote = vi.fn().mockResolvedValue(undefined)

    flushSync(() => {
      root.render(
        createElement(ConversationMessageRow, {
          message: buildNoOpDiagnosticMessage(),
          onFeedbackVote,
        }),
      )
    })

    const systemNote = container.querySelector('[role="note"][aria-label="System message"]')
    expect(systemNote).toBeTruthy()
    expect(systemNote!.textContent).toContain('System')
    expect(systemNote!.textContent).toContain('Manager returned no visible action after a worker update')
    expect(systemNote!.className).toContain('amber')
    expect(container.querySelector('[aria-label="Thumbs up"]')).toBeNull()
    expect(container.querySelector('[aria-label="Thumbs down"]')).toBeNull()
  })

  it('renders external-thread card even when system message text is empty', () => {
    flushSync(() => {
      root.render(
        createElement(ConversationMessageRow, {
          message: buildMessage(),
        }),
      )
    })

    expect(container.querySelector('[data-external-thread-status="completed"]')).toBeTruthy()
    expect(container.textContent).toContain('Prompt: Summarize my calendar')
    expect(container.textContent).toContain('Result: You have two meetings today.')
  })

  it('forwards sidecar agent id to onStopExternalThread when stop is clicked', () => {
    const onStopExternalThread = vi.fn()
    const message = {
      ...buildMessage(),
      externalThreadContext: {
        ...buildMessage().externalThreadContext!,
        status: 'running' as const,
      },
    }

    flushSync(() => {
      root.render(
        createElement(ConversationMessageRow, {
          message,
          onStopExternalThread,
          canStopExternalThread: true,
        }),
      )
    })

    const stopButton = container.querySelector('button')
    expect(stopButton?.disabled).toBe(false)
    stopButton?.click()

    expect(onStopExternalThread).toHaveBeenCalledTimes(1)
    expect(onStopExternalThread).toHaveBeenCalledWith('manager-1--codex')
  })

  it('keeps stop hidden on stale historical sent cards', () => {
    const onStopExternalThread = vi.fn()
    const message = {
      ...buildMessage(),
      externalThreadContext: {
        ...buildMessage().externalThreadContext!,
        status: 'sent' as const,
      },
    }

    flushSync(() => {
      root.render(
        createElement(ConversationMessageRow, {
          message,
          onStopExternalThread,
          canStopExternalThread: false,
        }),
      )
    })

    expect(container.querySelector('button')).toBeNull()
  })
})
