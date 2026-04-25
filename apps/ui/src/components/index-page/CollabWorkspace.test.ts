/** @vitest-environment jsdom */

import { createElement, forwardRef, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialCollabWsState, type CollabWsState } from '@/lib/collab-ws-state'

const collabContextMock = vi.hoisted(() => ({
  value: {
    clientRef: { current: null as Record<string, unknown> | null },
    state: null as unknown as CollabWsState,
  },
}))

const messageInputCapture = vi.hoisted(() => ({
  lastPropsRef: { current: null as Record<string, unknown> | null },
  restoreLastSubmission: vi.fn(() => true),
}))

const messageListCapture = vi.hoisted(() => ({
  lastPropsRef: { current: null as Record<string, unknown> | null },
}))

vi.mock('@/components/chat/MessageInput', () => {
  const MockMessageInput = forwardRef(function MockMessageInput(props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) {
    // eslint-disable-next-line react-hooks/immutability -- test-only mock capture
    messageInputCapture.lastPropsRef.current = props
    useImperativeHandle(ref, () => ({
      setInput: vi.fn(),
      focus: vi.fn(),
      addFiles: vi.fn(),
      addTerminalContext: vi.fn(),
      restoreLastSubmission: messageInputCapture.restoreLastSubmission,
    }))
    return createElement('div', { 'data-testid': 'message-input', 'data-draft-key': props.draftKey })
  })
  return { MessageInput: MockMessageInput }
})

vi.mock('@/components/chat/collab/CollabEmptyState', () => ({
  CollabEmptyState: ({ variant }: { variant: string }) => createElement('div', { 'data-testid': 'collab-empty' }, variant),
}))

vi.mock('@/components/chat/collab/CollabHeader', () => ({
  CollabHeader: () => createElement('div', { 'data-testid': 'collab-header' }),
}))

const workerPillBarCapture = vi.hoisted(() => ({
  rendered: false,
  lastProps: null as Record<string, unknown> | null,
}))

const collabAdapterCapture = vi.hoisted(() => ({
  entries: [] as unknown[],
}))

vi.mock('@/components/chat/WorkerPillBar', () => ({
  WorkerPillBar: (props: Record<string, unknown>) => {
    workerPillBarCapture.rendered = true
    workerPillBarCapture.lastProps = props
    return createElement('div', { 'data-testid': 'worker-pill-bar' })
  },
}))

vi.mock('@/components/chat/collab/collab-conversation-adapter', () => ({
  adaptCollabToConversationEntries: () => collabAdapterCapture.entries,
}))

vi.mock('@/components/chat/MessageList', () => ({
  MessageList: (props: Record<string, unknown>) => {
    messageListCapture.lastPropsRef.current = props
    return createElement('div', { 'data-testid': 'collab-message-list' })
  },
}))

vi.mock('@/hooks/index-page/use-collab-ws-connection', () => ({
  useCollabWsContext: () => collabContextMock.value,
}))

vi.mock('@/lib/collab-local-channel-state', () => ({
  subscribeToMuteChanges: () => () => {},
  toggleMute: vi.fn(),
}))

vi.mock('@/lib/collab-selectors', () => ({
  isChannelMuted: () => false,
}))

vi.mock('@/lib/collaboration-api', () => ({
  archiveChannel: vi.fn(),
}))

vi.mock('@/components/settings/collaboration/CollaborationAuthError', () => ({
  CollaborationAuthError: ({ message }: { message?: string }) =>
    createElement('div', { 'data-testid': 'collab-auth-error' }, message ?? 'Session ended'),
}))

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'http://localhost:47187',
}))

const { CollabWorkspace } = await import('./CollabWorkspace')

let container: HTMLDivElement
let root: Root | null = null

function renderWorkspace(props: { wsUrl?: string; channelId?: string; onSelectChannel?: (channelId?: string) => void }): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(CollabWorkspace, { wsUrl: props.wsUrl ?? 'ws://test', ...props }))
  })
}

function rerenderWorkspace(props: { wsUrl?: string; channelId?: string; onSelectChannel?: (channelId?: string) => void }): void {
  flushSync(() => {
    root?.render(createElement(CollabWorkspace, { wsUrl: props.wsUrl ?? 'ws://test', ...props }))
  })
}

function buildState(overrides: Partial<CollabWsState> = {}): CollabWsState {
  return {
    ...createInitialCollabWsState(),
    hasBootstrapped: true,
    workspace: {
      workspaceId: 'workspace-1',
      displayName: 'Workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  }
}

function buildStateWithChannel(overrides: Partial<CollabWsState> = {}): CollabWsState {
  return buildState({
    connected: true,
    activeChannelId: 'channel-1',
    channelHistoryLoaded: true,
    channels: [
      {
        channelId: 'channel-1',
        workspaceId: 'workspace-1',
        categoryId: undefined,
        sessionAgentId: 'session-1',
        name: 'general',
        slug: 'general',
        aiEnabled: true,
        position: 1,
        archived: false,
        lastMessageSeq: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  messageInputCapture.lastPropsRef.current = null
  messageInputCapture.restoreLastSubmission.mockClear()
  messageListCapture.lastPropsRef.current = null
  workerPillBarCapture.rendered = false
  collabAdapterCapture.entries = []
  workerPillBarCapture.lastProps = null
  collabContextMock.value = {
    clientRef: { current: null },
    state: buildState(),
  }
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
})

describe('CollabWorkspace channel recovery', () => {
  it('falls back to the first unarchived channel ordered by category then channel position', async () => {
    const onSelectChannel = vi.fn()

    collabContextMock.value = {
      clientRef: { current: null },
      state: buildState({
        categories: [
          {
            categoryId: 'category-b',
            workspaceId: 'workspace-1',
            name: 'Later',
            position: 20,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            categoryId: 'category-a',
            workspaceId: 'workspace-1',
            name: 'Earlier',
            position: 10,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        channels: [
          {
            channelId: 'channel-3',
            workspaceId: 'workspace-1',
            categoryId: 'category-b',
            sessionAgentId: 'session-3',
            name: 'gamma',
            slug: 'gamma',
            aiEnabled: true,
            position: 1,
            archived: false,
            lastMessageSeq: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            channelId: 'channel-2',
            workspaceId: 'workspace-1',
            categoryId: 'category-a',
            sessionAgentId: 'session-2',
            name: 'beta',
            slug: 'beta',
            aiEnabled: true,
            position: 2,
            archived: false,
            lastMessageSeq: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            channelId: 'channel-1',
            workspaceId: 'workspace-1',
            categoryId: 'category-a',
            sessionAgentId: 'session-1',
            name: 'alpha',
            slug: 'alpha',
            aiEnabled: true,
            position: 1,
            archived: false,
            lastMessageSeq: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    }

    renderWorkspace({ channelId: 'missing-channel', onSelectChannel })
    await Promise.resolve()

    expect(onSelectChannel).toHaveBeenCalledWith('channel-1')
  })

  it('clears to no-channel only when there are no channels left', async () => {
    const onSelectChannel = vi.fn()

    collabContextMock.value = {
      clientRef: { current: null },
      state: buildState({
        categories: [],
        channels: [],
      }),
    }

    renderWorkspace({ channelId: 'missing-channel', onSelectChannel })
    await Promise.resolve()

    expect(onSelectChannel).toHaveBeenCalledWith(undefined)
  })
})

describe('CollabWorkspace MessageList integration', () => {
  it('passes onPinMessage through to MessageList and targets the active channel', () => {
    const pinMessage = vi.fn()

    collabAdapterCapture.entries = [
      {
        type: 'conversation_message',
        agentId: 'session-1',
        id: 'msg-1',
        role: 'assistant',
        text: 'Hello',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'speak_to_user',
      },
    ]

    collabContextMock.value = {
      clientRef: { current: { pinMessage, setActiveChannel: vi.fn(), markChannelRead: vi.fn() } },
      state: buildStateWithChannel(),
    }

    renderWorkspace({ channelId: 'channel-1' })

    const onPinMessage = messageListCapture.lastPropsRef.current?.onPinMessage as
      | ((messageId: string, pinned: boolean) => void)
      | undefined

    expect(onPinMessage).toBeDefined()
    onPinMessage?.('msg-1', true)

    expect(pinMessage).toHaveBeenCalledWith('channel-1', 'msg-1', true)
  })
})

describe('CollabWorkspace MessageInput integration', () => {
  it('renders MessageInput with the correct channel-scoped draftKey', () => {
    collabContextMock.value = {
      clientRef: { current: null },
      state: buildStateWithChannel(),
    }

    renderWorkspace({ channelId: 'channel-1' })

    const inputEl = container.querySelector('[data-testid="message-input"]')
    expect(inputEl).not.toBeNull()
    expect(inputEl?.getAttribute('data-draft-key')).toBe('collab:channel:channel-1')
  })

  it('returns false from onSend when disconnected, preserving the draft', () => {
    collabContextMock.value = {
      clientRef: { current: null },
      state: buildStateWithChannel({ connected: false }),
    }

    renderWorkspace({ channelId: 'channel-1' })

    const onSend = messageInputCapture.lastPropsRef.current?.onSend as (text: string) => boolean
    expect(onSend).toBeDefined()

    const result = onSend('hello')
    expect(result).toBe(false)
  })

  it('calls restoreLastSubmission when COLLAB_USER_MESSAGE_FAILED fires', async () => {
    const sendMessage = vi.fn(() => true)

    collabContextMock.value = {
      clientRef: { current: { sendMessage, setActiveChannel: vi.fn(), markChannelRead: vi.fn() } },
      state: buildStateWithChannel(),
    }

    renderWorkspace({ channelId: 'channel-1' })

    expect(messageInputCapture.restoreLastSubmission).not.toHaveBeenCalled()

    // Simulate a failure event from the WS state
    collabContextMock.value = {
      ...collabContextMock.value,
      state: buildStateWithChannel({
        lastError: 'Message dispatch failed.',
        lastErrorCode: 'COLLAB_USER_MESSAGE_FAILED',
      }),
    }

    await act(async () => {
      rerenderWorkspace({ channelId: 'channel-1' })
      await Promise.resolve()
    })

    expect(messageInputCapture.restoreLastSubmission).toHaveBeenCalledTimes(1)
  })
})

describe('CollabWorkspace WorkerPillBar', () => {
  function makeWorker(overrides: Partial<{ agentId: string; displayName: string; status: string }> = {}) {
    return {
      agentId: overrides.agentId ?? 'worker-1',
      managerId: 'session-1',
      displayName: overrides.displayName ?? 'Test Worker',
      role: 'worker' as const,
      status: (overrides.status ?? 'streaming') as 'streaming',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      model: { provider: 'anthropic' as const, modelId: 'claude-sonnet-4-20250514', thinkingLevel: 'none' as const },
      sessionFile: '/tmp/session.jsonl',
    }
  }

  it('renders WorkerPillBar when sessionWorkers has entries', () => {
    collabContextMock.value = {
      clientRef: { current: null },
      state: buildStateWithChannel({
        sessionWorkers: [makeWorker()],
        sessionAgentStatuses: {
          'worker-1': {
            status: 'streaming' as const,
            pendingCount: 0,
            streamingStartedAt: Date.now(),
          },
        },
      }),
    }

    renderWorkspace({ channelId: 'channel-1' })

    const pillBar = container.querySelector('[data-testid="worker-pill-bar"]')
    expect(pillBar).not.toBeNull()
    expect(workerPillBarCapture.rendered).toBe(true)
    expect((workerPillBarCapture.lastProps?.workers as unknown[])?.length).toBe(1)
  })

  it('does not render WorkerPillBar when sessionWorkers is empty', () => {
    collabContextMock.value = {
      clientRef: { current: null },
      state: buildStateWithChannel({
        sessionWorkers: [],
      }),
    }

    renderWorkspace({ channelId: 'channel-1' })

    const pillBar = container.querySelector('[data-testid="worker-pill-bar"]')
    expect(pillBar).toBeNull()
  })

  it('does not render WorkerPillBar when no channel is selected', () => {
    collabContextMock.value = {
      clientRef: { current: null },
      state: buildState({
        sessionWorkers: [makeWorker()],
      }),
    }

    renderWorkspace({})

    const pillBar = container.querySelector('[data-testid="worker-pill-bar"]')
    expect(pillBar).toBeNull()
  })

  it('passes onNavigateToWorker callback to WorkerPillBar', () => {
    collabContextMock.value = {
      clientRef: { current: null },
      state: buildStateWithChannel({
        sessionWorkers: [makeWorker()],
        sessionAgentStatuses: {
          'worker-1': {
            status: 'streaming' as const,
            pendingCount: 0,
          },
        },
      }),
    }

    renderWorkspace({ channelId: 'channel-1' })

    expect(typeof workerPillBarCapture.lastProps?.onNavigateToWorker).toBe('function')
  })
})

describe('CollabWorkspace session invalidation (4001)', () => {
  it('shows auth error recovery UI instead of loading spinner when session is invalidated', () => {
    collabContextMock.value = {
      clientRef: { current: null },
      state: buildState({
        hasBootstrapped: false,
        lastError: 'Your session has been invalidated. Please sign in again.',
        lastErrorCode: 'COLLAB_SESSION_INVALIDATED',
      }),
    }

    renderWorkspace({})

    // Should NOT show loading spinner
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).toBeNull()

    // Should show auth error with sign-in recovery
    const authError = container.querySelector('[data-testid="collab-auth-error"]')
    expect(authError).not.toBeNull()
    expect(authError!.textContent).toContain('sign in again')
  })

  it('still shows loading spinner for normal pre-bootstrap state (no invalidation)', () => {
    collabContextMock.value = {
      clientRef: { current: null },
      state: buildState({
        hasBootstrapped: false,
        lastError: null,
        lastErrorCode: null,
      }),
    }

    renderWorkspace({})

    // Should show loading spinner
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).not.toBeNull()
    expect(container.textContent).toContain('Loading workspace')

    // Should NOT show auth error
    const authError = container.querySelector('[data-testid="collab-auth-error"]')
    expect(authError).toBeNull()
  })
})
