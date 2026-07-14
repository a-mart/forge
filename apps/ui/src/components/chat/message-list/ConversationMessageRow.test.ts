/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationMessageEvent } from '@forge/protocol'
import { TooltipProvider } from '@/components/ui/tooltip'
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

  it('shows a reply action for normal assistant messages', () => {
    const onReplyToMessage = vi.fn()
    const message: ConversationMessageEvent = {
      type: 'conversation_message',
      agentId: 'manager-1',
      id: 'assistant-1',
      role: 'assistant',
      text: 'Assistant answer',
      timestamp: '2026-05-30T10:31:00.000Z',
      source: 'speak_to_user',
    }

    flushSync(() => {
      root.render(
        createElement(ConversationMessageRow, {
          message,
          onReplyToMessage,
        }),
      )
    })

    const replyButton = container.querySelector('button[aria-label="Reply to this message"]') as HTMLButtonElement | null
    expect(replyButton).toBeTruthy()
    replyButton?.click()
    expect(onReplyToMessage).toHaveBeenCalledWith(message)
  })

  it('keeps actor resolution separate from active transcript provenance on artifact clicks', () => {
    const onArtifactClick = vi.fn()
    const message: ConversationMessageEvent = {
      type: 'conversation_message',
      agentId: 'actor-worker',
      id: 'assistant-artifact-1',
      role: 'assistant',
      text: '[artifact:/tmp/result.png]',
      timestamp: '2026-05-30T10:31:00.000Z',
      source: 'speak_to_user',
    }

    flushSync(() => {
      root.render(createElement(
        TooltipProvider,
        null,
        createElement(ConversationMessageRow, {
          message,
          transcriptAgentId: 'viewed-manager',
          onArtifactClick,
        }),
      ))
    })

    ;(container.querySelector('[data-artifact-card="true"]') as HTMLButtonElement | null)?.click()
    expect(onArtifactClick).toHaveBeenCalledWith(expect.objectContaining({
      path: '/tmp/result.png',
      sourceAgentId: 'actor-worker',
      transcriptAgentId: 'viewed-manager',
      messageId: 'assistant-artifact-1',
    }))
  })

  it('renders sent reply previews as disabled when the original is not loaded', () => {
    const message: ConversationMessageEvent = {
      type: 'conversation_message',
      agentId: 'manager-1',
      id: 'user-1',
      role: 'user',
      text: 'My follow up',
      timestamp: '2026-05-30T10:32:00.000Z',
      source: 'user_input',
      replyTo: {
        messageId: 'missing-original',
        role: 'assistant',
        timestamp: '2026-05-30T10:31:00.000Z',
        text: 'Original text',
      },
    }

    flushSync(() => {
      root.render(
        createElement(ConversationMessageRow, {
          message,
          onReplyPreviewClick: vi.fn(),
          isReplyTargetLoaded: () => false,
        }),
      )
    })

    expect(container.textContent).toContain('Replying to Assistant')
    const preview = container.querySelector('button[aria-label="Replying to Assistant. Original message is not loaded."]') as HTMLButtonElement | null
    expect(preview?.disabled).toBe(true)
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

  it('renders project-agent input as a left-side sky conversation bubble', () => {
    const message: ConversationMessageEvent = {
      type: 'conversation_message',
      agentId: 'manager-1',
      role: 'user',
      text: 'The documentation check is complete.',
      timestamp: '2026-07-13T20:01:58.181Z',
      source: 'project_agent_input',
      projectAgentContext: {
        fromAgentId: 'documentation',
        fromDisplayName: 'Documentation',
      },
    }

    flushSync(() => {
      root.render(
        createElement(ConversationMessageRow, {
          message,
          activeAgentDisplayName: 'Manager',
        }),
      )
    })

    const bubble = container.querySelector('[data-project-agent-direction="incoming"]')
    expect(bubble?.getAttribute('data-project-agent-tone')).toBe('sky')
    expect(bubble?.textContent).toContain('Documentation → Manager')
  })
})
