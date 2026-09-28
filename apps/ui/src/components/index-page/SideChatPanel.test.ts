/** @vitest-environment jsdom */

import { act, createElement, forwardRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'
import { createInitialManagerWsState, type ConversationHistoryEntry, type ManagerWsState } from '@/lib/ws-state'
import { SideChatPanel, type SideChatPanelProps } from './SideChatPanel'

const fake = vi.hoisted(() => {
  const makeState = { current: null as null | ((agentId: string) => ManagerWsState) }
  const clients: FakeClient[] = []

  class FakeClient {
    readonly listeners = new Set<(state: ManagerWsState) => void>()
    state: ManagerWsState
    readonly start = vi.fn()
    readonly destroy = vi.fn()
    readonly sendUserMessage = vi.fn()

    constructor(
      readonly url: string,
      readonly initialAgentId: string,
      readonly options: { originId?: string },
    ) {
      this.state = makeState.current!(initialAgentId)
      clients.push(this)
    }

    getState() {
      return this.state
    }

    subscribe(listener: (state: ManagerWsState) => void) {
      this.listeners.add(listener)
      listener(this.state)
      return () => this.listeners.delete(listener)
    }

    emit(patch: Partial<ManagerWsState>) {
      this.state = { ...this.state, ...patch }
      for (const listener of this.listeners) listener(this.state)
    }
  }

  return { FakeClient, clients, makeState }
})
fake.makeState.current = createInitialManagerWsState
const clients = fake.clients

vi.mock('@/lib/ws-client', () => ({ ManagerWsClient: fake.FakeClient }))
vi.mock('@/components/chat/MessageList', () => ({
  MessageList: forwardRef(function MessageList(props: { messages: ConversationEntry[] }, _ref) {
    return createElement('ol', { 'data-testid': 'messages' }, props.messages.map((message, index) =>
      createElement('li', { key: index }, message.type === 'conversation_message' ? message.text : message.type),
    ))
  }),
}))
vi.mock('@/components/chat/MessageInput', () => ({
  MessageInput: forwardRef(function MessageInput(props: { onSend: (text: string) => void; disabled?: boolean }, _ref) {
    return createElement('button', { 'data-testid': 'send', disabled: props.disabled, onClick: () => props.onSend('follow-up') }, 'send')
  }),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  clients.splice(0)
  document.body.innerHTML = ''
})

const now = new Date(0).toISOString()
const sideChat: AgentDescriptor = {
  agentId: 'main--s2',
  managerId: 'main--s2',
  displayName: 'Side chat',
  role: 'manager',
  status: 'idle',
  createdAt: now,
  updatedAt: now,
  cwd: '/tmp',
  model: { provider: 'test', modelId: 'test', thinkingLevel: 'none' },
  sessionFile: '/tmp/side.jsonl',
  profileId: 'main',
  sessionPurpose: 'side_chat',
  sideChatSourceAgentId: 'main',
}

function message(agentId: string, text: string): ConversationHistoryEntry {
  return { type: 'conversation_message', agentId, role: 'assistant', text, timestamp: now, source: 'speak_to_user' }
}

function render(overrides: Partial<SideChatPanelProps> = {}) {
  const props: SideChatPanelProps = {
    wsUrl: 'ws://remote.example/ws',
    originId: 'remote-1',
    sideChatAgentId: 'main--s2',
    sourceLabel: 'Project › Main',
    isExpanded: true,
    initialMessage: null,
    onInitialMessageSent: vi.fn(),
    onExpand: vi.fn(),
    onCollapse: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(SideChatPanel, props)))
  return { container, props, rerender: (next: Partial<SideChatPanelProps>) => act(() => root.render(createElement(SideChatPanel, { ...props, ...next }))) }
}

const readyPatch = (agentId = 'main--s2'): Partial<ManagerWsState> => ({
  connected: true,
  hasReceivedAgentsSnapshot: true,
  targetAgentId: agentId,
  subscribedAgentId: agentId,
  agents: [sideChat],
})

describe('SideChatPanel', () => {
  it('shows a loading state without connecting while the fork is created', () => {
    const { container } = render({ sideChatAgentId: null })
    expect(container.textContent).toContain('Starting side chat…')
    expect(container.textContent).toContain('Forked from Project › Main')
    expect(clients).toHaveLength(0)
  })

  it('connects a panel-scoped client on the active origin and destroys it on discard/unmount', () => {
    const { container, props, rerender } = render()
    expect(clients).toHaveLength(1)
    expect(clients[0]).toMatchObject({ url: 'ws://remote.example/ws', initialAgentId: 'main--s2', options: { originId: 'remote-1' } })
    expect(clients[0]?.start).toHaveBeenCalledTimes(1)

    act(() => (container.querySelector('[aria-label="Discard side chat"]') as HTMLButtonElement).click())
    expect(props.onDiscard).toHaveBeenCalledTimes(1)

    rerender({ sideChatAgentId: null })
    expect(clients[0]?.destroy).toHaveBeenCalledTimes(1)
  })

  it('sends the /side question once the side chat subscription is ready, then follow-ups', () => {
    const onInitialMessageSent = vi.fn()
    const { container } = render({ initialMessage: { agentId: 'main--s2', text: 'why?' }, onInitialMessageSent })
    const client = clients[0]!
    expect(client.sendUserMessage).not.toHaveBeenCalled()
    expect((container.querySelector('[data-testid="send"]') as HTMLButtonElement).disabled).toBe(true)

    act(() => client.emit(readyPatch()))
    expect(onInitialMessageSent).toHaveBeenCalledTimes(1)
    expect(client.sendUserMessage).toHaveBeenCalledWith('why?', expect.objectContaining({ agentId: 'main--s2', delivery: 'steer' }))

    act(() => (container.querySelector('[data-testid="send"]') as HTMLButtonElement).click())
    expect(client.sendUserMessage).toHaveBeenLastCalledWith('follow-up', expect.objectContaining({ agentId: 'main--s2' }))
  })

  it('renders only the side chat conversation, never a fallback session', () => {
    const { container } = render()
    const client = clients[0]!
    act(() => client.emit({ ...readyPatch(), messages: [message('main--s2', 'side answer')] }))
    expect(container.querySelector('[data-testid="messages"]')?.textContent).toBe('side answer')

    act(() => client.emit({ ...readyPatch('main'), messages: [message('main', 'main transcript')] }))
    expect(container.textContent).not.toContain('main transcript')
  })

  it('collapses to a reopen affordance without holding a connection', () => {
    const onExpand = vi.fn()
    const { container } = render({ isExpanded: false, onExpand })
    expect(clients).toHaveLength(0)
    act(() => (container.querySelector('[aria-label="Open side chat"]') as HTMLButtonElement).click())
    expect(onExpand).toHaveBeenCalledTimes(1)
  })
})
