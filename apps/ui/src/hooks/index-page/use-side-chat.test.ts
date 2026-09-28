/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import type { ManagerWsClient } from '@/lib/ws-client'
import { createInitialManagerWsState, type ManagerWsState } from '@/lib/ws-state'
import { useSideChat, type UseSideChatOptions } from './use-side-chat'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
})

const now = new Date(0).toISOString()
function session(agentId: string, extra: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    cwd: '/tmp',
    model: { provider: 'test', modelId: 'test', thinkingLevel: 'none' },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId: 'main',
    ...extra,
  }
}
const sideChat = session('main--s2', { sessionPurpose: 'side_chat', sideChatSourceAgentId: 'main' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup(initial: Partial<UseSideChatOptions>) {
  let latest!: ReturnType<typeof useSideChat>
  let state = createInitialManagerWsState('main')
  const setState = vi.fn((update: ManagerWsState | ((prev: ManagerWsState) => ManagerWsState)) => {
    state = typeof update === 'function' ? update(state) : update
  })
  const fork = deferred<{ sourceAgentId: string; newSessionAgent: AgentDescriptor }>()
  const client = {
    forkSession: vi.fn(() => fork.promise),
    deleteSession: vi.fn(async () => ({ agentId: 'deleted' })),
  }
  const options: UseSideChatOptions = {
    clientRef: { current: client as unknown as ManagerWsClient },
    agents: [session('main')],
    activeAgentId: 'main',
    setState: setState as never,
    ...initial,
  }
  const capture = (value: ReturnType<typeof useSideChat>) => { latest = value }
  function Probe(props: UseSideChatOptions) {
    const value = useSideChat(props)
    return createElement('div', { ref: () => capture(value) })
  }
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  act(() => root.render(createElement(Probe, options)))
  return {
    client,
    fork,
    get current() { return latest },
    get lastError() { return state.lastError },
    rerender: (next: Partial<UseSideChatOptions>) => act(() => root.render(createElement(Probe, { ...options, ...next }))),
  }
}

describe('useSideChat', () => {
  it('restores an existing side chat for the active session as a collapsed panel', () => {
    const hook = setup({ agents: [session('main'), sideChat] })
    expect(hook.current).toMatchObject({ isOpen: true, isExpanded: false, isCreating: false, sideChatAgentId: 'main--s2' })

    hook.rerender({ activeAgentId: 'other' })
    expect(hook.current).toMatchObject({ isOpen: false, sideChatAgentId: null })
  })

  it('forks with the side_chat purpose, expands the result, and carries the first message', async () => {
    const hook = setup({})
    act(() => hook.current.startSideChat('main', 'why?'))
    expect(hook.client.forkSession).toHaveBeenCalledWith('main', undefined, undefined, { sessionPurpose: 'side_chat' })
    expect(hook.current).toMatchObject({ isOpen: true, isExpanded: true, isCreating: true, sideChatAgentId: null })

    await act(async () => hook.fork.resolve({ sourceAgentId: 'main', newSessionAgent: sideChat }))
    expect(hook.current).toMatchObject({ isExpanded: true, isCreating: false, sideChatAgentId: 'main--s2' })
    expect(hook.current.initialMessage).toEqual({ agentId: 'main--s2', text: 'why?' })

    // Once WS state carries the descriptor, it stays the source of truth.
    hook.rerender({ agents: [session('main'), sideChat] })
    expect(hook.current).toMatchObject({ isExpanded: true, sideChatAgentId: 'main--s2' })
  })

  it('deletes a side chat discarded while its fork was still in flight', async () => {
    const hook = setup({})
    act(() => hook.current.startSideChat('main'))
    act(() => hook.current.discardSideChat())
    expect(hook.current.isOpen).toBe(false)

    await act(async () => hook.fork.resolve({ sourceAgentId: 'main', newSessionAgent: sideChat }))
    expect(hook.client.deleteSession).toHaveBeenCalledWith('main--s2')
    expect(hook.current.isOpen).toBe(false)
  })

  it('discards an open side chat with delete_session', () => {
    const hook = setup({ agents: [session('main'), sideChat] })
    act(() => hook.current.discardSideChat())
    expect(hook.client.deleteSession).toHaveBeenCalledWith('main--s2')
  })

  it('closes the loading panel and reports a failed fork', async () => {
    const hook = setup({})
    act(() => hook.current.startSideChat('main'))
    await act(async () => hook.fork.reject(new Error('busy')))
    expect(hook.current.isOpen).toBe(false)
    expect(hook.lastError).toBe('Failed to start side chat: busy')
  })
})
