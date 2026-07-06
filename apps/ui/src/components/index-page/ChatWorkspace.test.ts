/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatWorkspace } from './ChatWorkspace'

const messageListCapture = vi.hoisted(() => ({
  lastProps: null as Record<string, unknown> | null,
}))

vi.mock('@/components/chat/ChatHeader', () => ({
  ChatHeader: () => createElement('div', { 'data-testid': 'chat-header' }),
}))

vi.mock('@/components/chat/ChatSearchBar', () => ({
  ChatSearchBar: () => createElement('div', { 'data-testid': 'chat-search-bar' }),
}))

vi.mock('@/components/chat/MessageList', () => ({
  MessageList: (props: Record<string, unknown>) => {
    messageListCapture.lastProps = props
    return createElement('div', { 'data-testid': 'message-list' })
  },
}))

vi.mock('@/components/chat/WorkerPillBar', () => ({
  WorkerPillBar: () => createElement('div', { 'data-testid': 'worker-pill-bar' }),
}))

vi.mock('@/components/chat/WorkerBackBar', () => ({
  WorkerBackBar: () => createElement('div', { 'data-testid': 'worker-back-bar' }),
}))

vi.mock('@/components/terminal/TerminalPanel', () => ({
  TerminalPanel: () => createElement('div', { 'data-testid': 'terminal-panel' }),
}))

vi.mock('@/components/chat/MessageInput', () => ({
  MessageInput: () => createElement('div', { 'data-testid': 'message-input' }),
}))

vi.mock('@/components/chat/cortex/OnboardingCallout', () => ({
  OnboardingCallout: () => createElement('div', { 'data-testid': 'onboarding-callout' }),
}))

let root: Root
let container: HTMLDivElement

const baseWorkspaceProps = {
  headerProps: { title: 'Test session' } as never,
  lastError: null,
  lastSuccess: null,
  restartRecovery: null,
  onResumeRestartRecovery: vi.fn(),
  onDismissRestartRecovery: vi.fn(),
  chatSearchBarProps: { query: '', onQueryChange: vi.fn() } as never,
  showWelcomeForm: false,
  showCreateManagerState: false,
  welcomeCalloutProps: {} as never,
  readyCalloutProps: {} as never,
  isMessageListHidden: false,
  messageListRef: { current: null },
  terminalPanelProps: {} as never,
  messageInputRef: { current: null },
  messageInputProps: {} as never,
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  messageListCapture.lastProps = null
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('ChatWorkspace MessageList integration', () => {
  it('forwards onNavigateToWorker from messageListProps to MessageList', () => {
    const onNavigateToWorker = vi.fn()

    flushSync(() => {
      root.render(createElement(ChatWorkspace, {
        ...baseWorkspaceProps,
        messageListProps: {
          messages: [],
          isLoading: false,
          pendingChoiceIds: new Set<string>(),
          onNavigateToWorker,
        },
      }))
    })

    expect(messageListCapture.lastProps?.onNavigateToWorker).toBe(onNavigateToWorker)
  })

  it('leaves MessageList without worker navigation when messageListProps omit the callback', () => {
    flushSync(() => {
      root.render(createElement(ChatWorkspace, {
        ...baseWorkspaceProps,
        messageListProps: {
          messages: [],
          isLoading: false,
          pendingChoiceIds: new Set<string>(),
        },
      }))
    })

    expect(messageListCapture.lastProps?.onNavigateToWorker).toBeUndefined()
  })
})
