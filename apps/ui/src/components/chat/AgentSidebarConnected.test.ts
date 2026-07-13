/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentDescriptor,
  BuilderSidebarOrderState,
  ManagerProfile,
} from '@forge/protocol'
import { AgentSidebarConnected } from './AgentSidebarConnected'
import { HelpProvider } from '@/components/help/HelpProvider'
import { LOCAL_ORIGIN_ID, originRegistry } from '@/lib/origin-store'
import {
  BuilderSidebarOrderApiUnavailableError,
  type BuilderSidebarOrderApi,
} from '@/lib/builder-sidebar-order-api'

let container: HTMLDivElement
let root: Root | null = null
const storageValues = new Map<string, string>()

beforeEach(() => {
  storageValues.clear()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => storageValues.set(key, value),
      removeItem: (key: string) => storageValues.delete(key),
      clear: () => storageValues.clear(),
      key: (index: number) => [...storageValues.keys()][index] ?? null,
      get length() { return storageValues.size },
    } satisfies Storage,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  originRegistry.destroyAll()
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }
  root = null
  container.remove()
  originRegistry.destroyAll()
})

function manager(agentId: string, profileId: string): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    profileId,
    sessionLabel: agentId,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function profile(profileId: string): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: `${profileId}--main`,
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function registerRemoteConnections(originIds: string[]): void {
  window.localStorage.setItem('forge:collab:connections:v1', JSON.stringify({
    version: 1,
    connections: originIds.map((id) => ({
      id,
      kind: 'remote',
      label: id,
      serverUrl: `https://${id}.test`,
      apiBaseUrl: `https://${id}.test/`,
      wsUrl: `wss://${id}.test`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
  }))
}

function renderConnectedSidebar(overrides: {
  onDeleteManager?: (managerId: string) => void
  builderSidebarOrderApi?: BuilderSidebarOrderApi
  withRemoteCollision?: boolean
} = {}) {
  const store = originRegistry.createOrigin({
    originId: LOCAL_ORIGIN_ID,
    wsUrl: 'ws://local.test',
    offline: true,
  })
  store.ingest({
    type: 'snapshot',
    state: {
      agents: [manager('profile-a--main', 'profile-a')],
      profiles: [profile('profile-a')],
      statuses: {},
      unreadCounts: {},
      connected: true,
      hasReceivedAgentsSnapshot: true,
      hasReceivedProfilesSnapshot: true,
    },
  })

  if (overrides.withRemoteCollision) {
    registerRemoteConnections(['remote-a', 'remote-offline'])
  }
  const remoteStore = overrides.withRemoteCollision
    ? originRegistry.createOrigin({
        originId: 'remote-a',
        wsUrl: 'ws://remote.test',
        offline: true,
      })
    : null
  remoteStore?.ingest({
    type: 'snapshot',
    state: {
      agents: [manager('remote-session', 'profile-a')],
      profiles: [{ ...profile('profile-a'), displayName: 'Remote profile-a', defaultSessionAgentId: 'remote-session' }],
      statuses: {},
      unreadCounts: {},
      connected: true,
      hasReceivedAgentsSnapshot: true,
      hasReceivedProfilesSnapshot: true,
    },
  })
  remoteStore?.patchMeta({
    connectionStatus: 'connected',
    authState: 'authenticated',
    instanceName: 'Remote A',
  })
  if (overrides.withRemoteCollision) {
    originRegistry.createOrigin({
      originId: 'remote-offline',
      wsUrl: 'ws://remote-offline.test',
      offline: true,
    })
  }

  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(
        HelpProvider,
        null,
        createElement(AgentSidebarConnected, {
          wsUrl: 'ws://local.test',
          builderSidebarOrderApi: overrides.builderSidebarOrderApi,
          selectedAgentId: 'remote-session',
          activeOriginId: 'remote-a',
          isSettingsActive: false,
          onAddManager: vi.fn(),
          onSelectAgent: vi.fn(),
          onDeleteAgent: vi.fn(),
          onDeleteManager: overrides.onDeleteManager ?? vi.fn(),
          onOpenSettings: vi.fn(),
          onCreateSession: vi.fn(),
          onRenameSession: vi.fn(),
          onForkSession: vi.fn(),
          onUpdateSessionModel: vi.fn(),
        }),
      ),
    )
  })
  return { localStore: store, remoteStore }
}

describe('AgentSidebarConnected', () => {
  it('routes the local profile Delete Manager context-menu action while a remote origin is active', () => {
    const onDeleteManager = vi.fn()
    renderConnectedSidebar({ onDeleteManager })

    const profileButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('profile-a') && !button.textContent?.includes('profile-a--main'),
    )
    const trigger = profileButton?.closest('[data-slot="context-menu-trigger"]')
    expect(trigger).not.toBeNull()
    flushSync(() => {
      trigger!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    })

    const deleteItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Delete Manager'),
    ) as HTMLElement | undefined
    expect(deleteItem).toBeDefined()
    flushSync(() => {
      deleteItem!.click()
    })

    expect(onDeleteManager).toHaveBeenCalledTimes(1)
    expect(onDeleteManager).toHaveBeenCalledWith('profile-a')
  })

  it('reconciles raw-id collisions through the local preference without calling either origin reorder API', async () => {
    let current: BuilderSidebarOrderState = {
      version: 1,
      revision: 2,
      order: [
        { originId: 'remote-a', profileId: 'profile-a' },
        { originId: 'remote-offline', profileId: 'hidden-anchor' },
      ],
      updatedAt: '2026-07-09T12:00:00.000Z',
    }
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => current),
      put: vi.fn(async (request) => {
        current = {
          version: 1,
          revision: current.revision + 1,
          order: request.order,
          updatedAt: '2026-07-09T12:00:01.000Z',
        }
        return current
      }),
    }
    const { localStore, remoteStore } = renderConnectedSidebar({
      builderSidebarOrderApi: api,
      withRemoteCollision: true,
    })
    const localLegacyReorder = vi.spyOn(localStore.getClient(), 'reorderProfiles')
    const remoteLegacyReorder = vi.spyOn(remoteStore!.getClient(), 'reorderProfiles')

    await vi.waitFor(() => expect(api.put).toHaveBeenCalledOnce())

    expect(api.put).toHaveBeenCalledWith({
      baseRevision: 2,
      order: [
        { originId: 'remote-a', profileId: 'profile-a' },
        { originId: 'remote-offline', profileId: 'hidden-anchor' },
        { originId: 'local', profileId: 'profile-a' },
      ],
    })
    const listText = container.querySelector('aside [data-testid="unified-project-list"]')?.textContent ?? ''
    expect(listText.startsWith('Remote profile-a')).toBe(true)
    expect(listText).toContain('profile-a--main')
    expect(localLegacyReorder).not.toHaveBeenCalled()
    expect(remoteLegacyReorder).not.toHaveBeenCalled()
  })

  it('keeps local session context menu actions when a remote origin is active', () => {
    renderConnectedSidebar()

    const sessionButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('profile-a--main'),
    )
    const trigger = sessionButton?.closest('[data-slot="context-menu-trigger"]')
    expect(trigger).not.toBeNull()
    flushSync(() => {
      trigger!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    })

    const text = document.body.textContent ?? ''
    expect(text).toContain('Rename')
    expect(text).toContain('Fork')
    expect(text).toContain('Override Session Model')
  })

  it('refetches local authority after an offline window reconnects and observes another window write', async () => {
    let current: BuilderSidebarOrderState = {
      version: 1,
      revision: 1,
      order: [
        { originId: 'local', profileId: 'profile-a' },
        { originId: 'remote-a', profileId: 'profile-a' },
      ],
      updatedAt: '2026-07-09T12:00:00.000Z',
    }
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => current),
      put: vi.fn(async () => current),
    }
    const { localStore } = renderConnectedSidebar({
      builderSidebarOrderApi: api,
      withRemoteCollision: true,
    })
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce())

    // Window B disconnects. Window A writes while B cannot receive the WS
    // invalidation; reconnect must recover solely from the local GET. Both
    // transport states are deliberately React-batched, so only the monotonic
    // connection epoch can prove a reconnect happened.
    current = {
      ...current,
      revision: 2,
      order: [
        { originId: 'remote-a', profileId: 'profile-a' },
        { originId: 'local', profileId: 'profile-a' },
      ],
      updatedAt: '2026-07-09T12:01:00.000Z',
    }
    const nextConnectionEpoch = localStore.getSnapshot().connectionEpoch + 1
    flushSync(() => {
      localStore.ingest({
        type: 'snapshot',
        state: {
          connected: false,
          hasReceivedAgentsSnapshot: false,
          hasReceivedProfilesSnapshot: false,
        },
      })
      localStore.ingest({
        type: 'snapshot',
        state: { connected: true, connectionEpoch: nextConnectionEpoch },
      })
    })

    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      const text = container.querySelector('aside [data-testid="unified-project-list"]')?.textContent ?? ''
      expect(text.startsWith('Remote profile-a')).toBe(true)
    })
    expect(api.put).not.toHaveBeenCalled()
  })

  it('accepts a new R1 invalidation after reconnect resets old R5 authority to R0', async () => {
    const naturalOrder = [
      { originId: 'local', profileId: 'profile-a' },
      { originId: 'remote-a', profileId: 'profile-a' },
    ]
    let current: BuilderSidebarOrderState = {
      version: 1,
      revision: 5,
      order: naturalOrder,
      updatedAt: '2026-07-09T12:00:00.000Z',
    }
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => current),
      put: vi.fn(async () => current),
    }
    const { localStore } = renderConnectedSidebar({
      builderSidebarOrderApi: api,
      withRemoteCollision: true,
    })
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce())

    current = { version: 1, revision: 0, order: naturalOrder, updatedAt: null }
    flushSync(() => {
      localStore.ingest({
        type: 'snapshot',
        state: {
          connected: true,
          connectionEpoch: localStore.getSnapshot().connectionEpoch + 1,
          builderSidebarOrderRevision: null,
        },
      })
    })
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))

    current = {
      version: 1,
      revision: 1,
      order: [...naturalOrder].reverse(),
      updatedAt: '2026-07-09T12:01:00.000Z',
    }
    flushSync(() => {
      localStore.ingest({
        type: 'snapshot',
        state: { builderSidebarOrderRevision: 1 },
      })
    })

    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => {
      const text = container.querySelector('aside [data-testid="unified-project-list"]')?.textContent ?? ''
      expect(text.startsWith('Remote profile-a')).toBe(true)
    })
    expect(api.put).not.toHaveBeenCalled()
  })

  it('refetches when a revision-only local WS invalidation arrives', async () => {
    let current: BuilderSidebarOrderState = {
      version: 1,
      revision: 1,
      order: [
        { originId: 'local', profileId: 'profile-a' },
        { originId: 'remote-a', profileId: 'profile-a' },
      ],
      updatedAt: '2026-07-09T12:00:00.000Z',
    }
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => current),
      put: vi.fn(async () => current),
    }
    const { localStore } = renderConnectedSidebar({
      builderSidebarOrderApi: api,
      withRemoteCollision: true,
    })
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce())

    current = {
      ...current,
      revision: 2,
      order: [
        { originId: 'remote-a', profileId: 'profile-a' },
        { originId: 'local', profileId: 'profile-a' },
      ],
      updatedAt: '2026-07-09T12:02:00.000Z',
    }
    flushSync(() => {
      localStore.ingest({
        type: 'snapshot',
        state: { builderSidebarOrderRevision: 2 },
      })
    })

    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      const text = container.querySelector('aside [data-testid="unified-project-list"]')?.textContent ?? ''
      expect(text.startsWith('Remote profile-a')).toBe(true)
    })
  })

  it('never treats this browser registry omission as instance-global removal authority', async () => {
    let current: BuilderSidebarOrderState = {
      version: 1,
      revision: 5,
      order: [
        { originId: 'local', profileId: 'profile-a' },
        { originId: 'remote-a', profileId: 'profile-a' },
      ],
      updatedAt: '2026-07-09T12:00:00.000Z',
    }
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => current),
      put: vi.fn(async (request) => {
        current = {
          version: 1,
          revision: current.revision + 1,
          order: request.order,
          updatedAt: '2026-07-09T12:01:00.000Z',
        }
        return current
      }),
    }
    renderConnectedSidebar({ builderSidebarOrderApi: api, withRemoteCollision: true })
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce())

    registerRemoteConnections([])
    flushSync(() => window.dispatchEvent(new Event('forge-collab-connections-change')))

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(api.put).not.toHaveBeenCalled()
    expect(current.order).toEqual([
      { originId: 'local', profileId: 'profile-a' },
      { originId: 'remote-a', profileId: 'profile-a' },
    ])
    // The stale store is still a live rendering concern, but localStorage
    // membership can neither hide it nor mutate shared durable order.
    expect(container.textContent).toContain('Remote profile-a')

    registerRemoteConnections(['remote-a'])
    flushSync(() => window.dispatchEvent(new Event('forge-collab-connections-change')))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(api.put).not.toHaveBeenCalled()
  })

  it('becomes quiescent after a persistent automatic reconciliation PUT failure', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => ({
        version: 1 as const,
        revision: 0,
        order: [],
        updatedAt: null,
      })),
      put: vi.fn(async () => { throw new Error('persistent write failure') }),
    }
    const { localStore } = renderConnectedSidebar({ builderSidebarOrderApi: api })

    await vi.waitFor(() => expect(api.put).toHaveBeenCalledOnce())
    for (let count = 1; count <= 3; count += 1) {
      flushSync(() => {
        localStore.ingest({
          type: 'snapshot',
          state: {
            statuses: {
              'profile-a--main': { status: 'idle', pendingCount: count },
            },
          },
        })
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(api.put).toHaveBeenCalledOnce()
    expect(api.get).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(
      '[builder-sidebar-order] Unable to reconcile local preference:',
      expect.any(Error),
    )
    warning.mockRestore()
  })

  it('feature-disables DnD when the local backend does not expose the preference API', async () => {
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => { throw new BuilderSidebarOrderApiUnavailableError() }),
      put: vi.fn(),
    }
    renderConnectedSidebar({ builderSidebarOrderApi: api })
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce())

    const projectButtons = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === 'profile-a',
    )
    expect(projectButtons.length).toBeGreaterThan(0)
    expect(projectButtons.every((button) => button.getAttribute('aria-label') === 'Collapse project profile-a')).toBe(true)
    expect(api.put).not.toHaveBeenCalled()
  })

  it('feature-disables DnD when discovery finds a read-only API without PUT support', async () => {
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => ({
        version: 1 as const,
        revision: 0,
        order: [],
        updatedAt: null,
      })),
      put: vi.fn(async () => { throw new BuilderSidebarOrderApiUnavailableError() }),
    }
    renderConnectedSidebar({ builderSidebarOrderApi: api, withRemoteCollision: true })

    await vi.waitFor(() => expect(api.put).toHaveBeenCalledOnce())
    await vi.waitFor(() => {
      expect(container.querySelector('button[aria-roledescription="sortable"]')).toBeNull()
    })
    expect(container.textContent).toContain('profile-a')
  })
})
