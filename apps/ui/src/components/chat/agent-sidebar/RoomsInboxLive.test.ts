/** @vitest-environment jsdom */

import { fireEvent, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionAttention, SessionAttentionUpdateEvent } from '@forge/protocol'
import { originRegistry, type OriginStore } from '@/lib/origin-store'
import { RoomsInboxLive } from './RoomsInboxLive'

let root: Root | null = null
let container: HTMLDivElement

function attention(originId: string, sessionAgentId = 'session-a'): SessionAttention {
  return {
    attentionId: `${originId}-attention-a`,
    sessionAgentId,
    profileId: `${originId}-project`,
    reason: 'work_settled',
    raisedAt: '2026-08-03T11:30:00.000Z',
  }
}

function createOrigin(options: {
  originId: string
  attention?: SessionAttention
  attentionAvailable?: boolean
  unreadCount?: number
  pendingChoiceCount?: number
  status?: 'idle' | 'error'
}): OriginStore {
  const { originId } = options
  const store = originRegistry.createOrigin({
    originId,
    wsUrl: `ws://${originId}.example/ws`,
    offline: true,
  })
  const sessionAgentId = options.attention?.sessionAgentId ?? 'session-a'
  const profileId = `${originId}-project`
  store.ingest({
    type: 'snapshot',
    state: {
      connected: true,
      hasReceivedAgentsSnapshot: true,
      hasReceivedProfilesSnapshot: true,
      profiles: [{
        profileId,
        displayName: `${originId} Project`,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      }] as any,
      agents: [{
        agentId: sessionAgentId,
        role: 'manager',
        profileId,
        displayName: `${originId} Session`,
        sessionLabel: `${originId} Session`,
        status: options.status ?? 'idle',
        activeWorkerCount: 0,
        pendingChoiceCount: options.pendingChoiceCount ?? 0,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      }] as any,
      unreadCounts: options.unreadCount ? { [sessionAgentId]: options.unreadCount } : {},
      sessionAttentionAvailable: options.attentionAvailable ?? true,
      sessionAttentionRevision: options.attention ? 1 : 0,
      sessionAttentions: options.attention ? { [sessionAgentId]: options.attention } : {},
    },
  })
  return store
}

function renderInbox(overrides: Record<string, unknown> = {}) {
  const props = {
    mode: 'inbox' as const,
    onModeChange: vi.fn(),
    searchQuery: '',
    hideCliSessions: false,
    onSelectLocal: vi.fn(),
    onSelectRemote: vi.fn(),
    onNewProject: vi.fn(),
    ...overrides,
  }
  flushSync(() => root?.render(createElement(RoomsInboxLive, props)))
  return props
}

beforeEach(() => {
  originRegistry.destroyAll()
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root?.unmount())
  root = null
  container.remove()
  originRegistry.destroyAll()
  localStorage.clear()
})

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function resultEvent(requestId = 'dismiss-request'): SessionAttentionUpdateEvent {
  return { type: 'session_attention_update', revision: 2, changes: [], requestId }
}

describe('RoomsInboxLive server attention', () => {
  it('does not infer Needs You from unread, a pending choice, or an error', async () => {
    createOrigin({
      originId: 'local',
      attentionAvailable: true,
      unreadCount: 3,
      pendingChoiceCount: 1,
      status: 'error',
    })
    renderInbox()
    await flushEffects()

    expect(container.querySelector('[data-inbox-section="needs-you"]')).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('keeps attention sticky through selection and dismisses the exact rendered ID without optimistic removal', async () => {
    const item = attention('local')
    const store = createOrigin({ originId: 'local', attention: item, unreadCount: 2 })
    const dismiss = vi.spyOn(store.getClient(), 'dismissSessionAttention')
      .mockResolvedValue(resultEvent())
    const onSelectLocal = vi.fn()
    renderInbox({ onSelectLocal })
    await flushEffects()

    fireEvent.click(container.querySelector('[data-inbox-row="local::session-a"]') as HTMLButtonElement)
    expect(onSelectLocal).toHaveBeenCalledWith('session-a')
    expect(container.querySelector('[data-inbox-section="needs-you"]')).not.toBeNull()

    fireEvent.click(getByRole(container, 'button', {
      name: 'Mark "local Session" done for local Project on local (session-a)',
    }))
    await flushEffects()
    expect(dismiss).toHaveBeenCalledWith(['local-attention-a'])
    expect(container.querySelector('[data-inbox-section="needs-you"]')).not.toBeNull()

    store.ingest({
      type: 'snapshot',
      state: { sessionAttentionRevision: 2, sessionAttentions: {} },
    })
    await flushEffects()
    expect(container.querySelector('[data-inbox-section="needs-you"]')).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('fans Clear out by owning origin and retains only the failed origin row', async () => {
    const localItem = attention('local')
    const remoteItem = attention('remote')
    const local = createOrigin({ originId: 'local', attention: localItem })
    const remote = createOrigin({ originId: 'remote', attention: remoteItem })
    const localDismiss = vi.spyOn(local.getClient(), 'dismissSessionAttention')
      .mockImplementation(async (_attentionIds) => {
        local.ingest({
          type: 'snapshot',
          state: { sessionAttentionRevision: 2, sessionAttentions: {} },
        })
        return { ...resultEvent(), changes: [{ sessionAgentId: 'session-a', attention: null }] }
      })
    const remoteDismiss = vi.spyOn(remote.getClient(), 'dismissSessionAttention')
      .mockRejectedValue(new Error('remote write failed'))
    renderInbox()
    await flushEffects()

    fireEvent.click(getByRole(container, 'button', { name: 'Clear' }))
    await flushEffects()

    expect(localDismiss).toHaveBeenCalledWith(['local-attention-a'])
    expect(remoteDismiss).toHaveBeenCalledWith(['remote-attention-a'])
    expect(container.querySelector('[data-inbox-row="local::session-a"]')).toBeNull()
    expect(container.querySelector('[data-inbox-row="remote::session-a"]')).not.toBeNull()
    expect(getByRole(container, 'alert').textContent).toContain('could not be cleared')
  })

  it('chunks Clear requests at the protocol limit for one origin', async () => {
    const store = createOrigin({ originId: 'local' })
    const attentions = Array.from({ length: 101 }, (_, index): SessionAttention => ({
      attentionId: `attention-${index}`,
      sessionAgentId: `session-${index}`,
      profileId: 'local-project',
      reason: 'work_settled',
      raisedAt: '2026-08-03T11:30:00.000Z',
    }))
    store.ingest({
      type: 'snapshot',
      state: {
        agents: attentions.map((item) => ({
          agentId: item.sessionAgentId,
          role: 'manager',
          profileId: item.profileId,
          displayName: item.sessionAgentId,
          sessionLabel: item.sessionAgentId,
          status: 'idle',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        })) as any,
        sessionAttentionRevision: 1,
        sessionAttentions: Object.fromEntries(
          attentions.map((item) => [item.sessionAgentId, item]),
        ),
      },
    })
    const dismiss = vi.spyOn(store.getClient(), 'dismissSessionAttention')
      .mockResolvedValue(resultEvent())
    renderInbox()
    await flushEffects()

    fireEvent.click(getByRole(container, 'button', { name: 'Clear' }))
    await flushEffects()

    expect(dismiss).toHaveBeenCalledTimes(2)
    expect(dismiss.mock.calls[0]?.[0]).toHaveLength(100)
    expect(dismiss.mock.calls[1]?.[0]).toHaveLength(1)
    expect(dismiss.mock.calls.flatMap(([ids]) => ids).sort()).toEqual(
      attentions.map((item) => item.attentionId).sort(),
    )
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('hides server-only attention and Done controls for an unsupported origin', async () => {
    createOrigin({
      originId: 'remote',
      attention: attention('remote'),
      attentionAvailable: false,
    })
    renderInbox()
    await flushEffects()

    expect(container.querySelector('[data-inbox-section="needs-you"]')).toBeNull()
    expect(container.querySelector('[aria-label^="Mark "]')).toBeNull()
  })
})
