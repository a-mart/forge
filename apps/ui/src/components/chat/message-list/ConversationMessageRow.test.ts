/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

describe('ConversationMessageRow', () => {
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
})
