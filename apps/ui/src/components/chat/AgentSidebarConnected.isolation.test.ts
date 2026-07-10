/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { LOCAL_ORIGIN_ID, originRegistry } from '@/lib/origin-store'
import type { BuilderSidebarOrderApi } from '@/lib/builder-sidebar-order-api'
import { BuilderSidebarOrderStore } from '@/lib/builder-sidebar-order-store'
import type { AgentSidebarProps } from './agent-sidebar/types'

const { sidebarRenderSpy } = vi.hoisted(() => ({ sidebarRenderSpy: vi.fn() }))
vi.mock('./AgentSidebar', () => ({
  AgentSidebar: (props: unknown) => {
    sidebarRenderSpy(props)
    return null
  },
}))

import { AgentSidebarConnected } from './AgentSidebarConnected'

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
  sidebarRenderSpy.mockReset()
  originRegistry.destroyAll()
  window.localStorage.setItem('forge:collab:connections:v1', JSON.stringify({
    version: 1,
    connections: [{
      id: 'remote-a',
      kind: 'remote',
      label: 'Remote A',
      serverUrl: 'https://remote.test',
      apiBaseUrl: 'https://remote.test/',
      wsUrl: 'wss://remote.test',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  container?.remove()
  originRegistry.destroyAll()
  vi.restoreAllMocks()
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
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function worker(agentId: string, managerId: string, profileId: string): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    profileId,
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function profile(profileId: string, sessionId: string): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: sessionId,
    defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function emitProductionAgentStatus(
  store: ReturnType<typeof originRegistry.createOrigin>,
  event: {
    type: 'agent_status'
    agentId: string
    managerId: string
    status: 'idle' | 'streaming'
    pendingCount: number
  },
): void {
  // Exercise the same reduceAgentStatus path used by a live socket rather
  // than patching only the derived statuses map.
  store.ingest({ type: 'event', event })
}

describe('AgentSidebarConnected origin isolation', () => {
  it('ignores production worker-status descriptor churn and isolates local A from remote B', async () => {
    const discoverySyncSpy = vi.spyOn(BuilderSidebarOrderStore.prototype, 'ensureDiscovered')
    const local = originRegistry.createOrigin({
      originId: LOCAL_ORIGIN_ID,
      wsUrl: 'ws://local.test',
      offline: true,
    })
    local.ingest({
      type: 'snapshot',
      state: {
        connected: true,
        agents: [
          manager('local-session', 'local-project'),
          worker('local-worker', 'local-session', 'local-project'),
        ],
        profiles: [profile('local-project', 'local-session')],
        hasReceivedAgentsSnapshot: true,
        hasReceivedProfilesSnapshot: true,
      },
    })
    const remote = originRegistry.createOrigin({
      originId: 'remote-a',
      wsUrl: 'ws://remote.test',
      offline: true,
    })
    remote.ingest({
      type: 'snapshot',
      state: {
        connected: true,
        agents: [
          manager('remote-session', 'remote-project'),
          worker('remote-worker', 'remote-session', 'remote-project'),
        ],
        profiles: [profile('remote-project', 'remote-session')],
        hasReceivedAgentsSnapshot: true,
        hasReceivedProfilesSnapshot: true,
      },
    })

    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => ({
        version: 1 as const,
        revision: 1,
        order: [
          { originId: 'local', profileId: 'local-project' },
          { originId: 'remote-a', profileId: 'remote-project' },
        ],
        updatedAt: '2026-07-09T12:00:00.000Z',
      })),
      put: vi.fn(),
    }
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(AgentSidebarConnected, {
        builderSidebarOrderApi: api,
        selectedAgentId: null,
        isSettingsActive: false,
        onAddManager: vi.fn(),
        onSelectAgent: vi.fn(),
        onDeleteAgent: vi.fn(),
        onDeleteManager: vi.fn(),
        onOpenSettings: vi.fn(),
      }))
    })
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(discoverySyncSpy).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    const initialProps = sidebarRenderSpy.mock.calls.at(-1)?.[0] as AgentSidebarProps
    const initialRemoteOrigins = initialProps.remoteOrigins ?? []
    const initialRemoteTreeRows = initialRemoteOrigins[0]?.treeRows
    sidebarRenderSpy.mockClear()
    discoverySyncSpy.mockClear()

    const remoteAgentsBefore = remote.getSnapshot().agents
    flushSync(() => {
      emitProductionAgentStatus(remote, {
        type: 'agent_status',
        agentId: 'remote-worker',
        managerId: 'remote-session',
        status: 'streaming',
        pendingCount: 1,
      })
    })
    await Promise.resolve()

    expect(remote.getSnapshot().agents).not.toBe(remoteAgentsBefore)
    expect(remote.getSnapshot().agents.find((agent) => agent.agentId === 'remote-worker')?.status).toBe('streaming')
    expect(sidebarRenderSpy).not.toHaveBeenCalled()
    expect(discoverySyncSpy).not.toHaveBeenCalled()
    expect(api.put).not.toHaveBeenCalled()

    // Local volatile state legitimately updates local props, but the remote
    // structural container/tree identities remain unchanged for memoized rows.
    flushSync(() => {
      emitProductionAgentStatus(local, {
        type: 'agent_status',
        agentId: 'local-worker',
        managerId: 'local-session',
        status: 'streaming',
        pendingCount: 1,
      })
    })
    const localTickProps = sidebarRenderSpy.mock.calls.at(-1)?.[0] as AgentSidebarProps
    expect(localTickProps.remoteOrigins).toBe(initialRemoteOrigins)
    expect(localTickProps.remoteOrigins?.[0]?.treeRows).toBe(initialRemoteTreeRows)
    expect(discoverySyncSpy).not.toHaveBeenCalled()
    expect(api.put).not.toHaveBeenCalled()

    sidebarRenderSpy.mockClear()
    flushSync(() => {
      remote.ingest({
        type: 'snapshot',
        state: { profiles: [{ ...profile('remote-project', 'remote-session'), displayName: 'Changed' }] },
      })
    })
    expect(sidebarRenderSpy).toHaveBeenCalled()
    expect(api.put).not.toHaveBeenCalled()
  })

  it('routes a unified DnD callback only to the local preference API, never either reorderProfiles command', async () => {
    const local = originRegistry.createOrigin({
      originId: LOCAL_ORIGIN_ID,
      wsUrl: 'ws://local.test',
      offline: true,
    })
    local.ingest({
      type: 'snapshot',
      state: {
        connected: true,
        agents: [manager('local-session', 'local-project')],
        profiles: [profile('local-project', 'local-session')],
        hasReceivedAgentsSnapshot: true,
        hasReceivedProfilesSnapshot: true,
      },
    })
    const remote = originRegistry.createOrigin({
      originId: 'remote-a',
      wsUrl: 'ws://remote.test',
      offline: true,
    })
    remote.ingest({
      type: 'snapshot',
      state: {
        connected: true,
        agents: [manager('remote-session', 'remote-project')],
        profiles: [profile('remote-project', 'remote-session')],
        hasReceivedAgentsSnapshot: true,
        hasReceivedProfilesSnapshot: true,
      },
    })
    const localLegacyReorder = vi.spyOn(local.getClient(), 'reorderProfiles')
    const remoteLegacyReorder = vi.spyOn(remote.getClient(), 'reorderProfiles')
    let current = {
      version: 1 as const,
      revision: 1,
      order: [
        { originId: 'local', profileId: 'local-project' },
        { originId: 'remote-a', profileId: 'remote-project' },
      ],
      updatedAt: '2026-07-09T12:00:00.000Z',
    }
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => current),
      put: vi.fn(async (request) => {
        current = {
          version: 1,
          revision: 2,
          order: request.order,
          updatedAt: '2026-07-09T12:01:00.000Z',
        }
        return current
      }),
    }
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(AgentSidebarConnected, {
        builderSidebarOrderApi: api,
        selectedAgentId: null,
        isSettingsActive: false,
        onAddManager: vi.fn(),
        onSelectAgent: vi.fn(),
        onDeleteAgent: vi.fn(),
        onDeleteManager: vi.fn(),
        onOpenSettings: vi.fn(),
      }))
    })
    await vi.waitFor(() => {
      const props = sidebarRenderSpy.mock.calls.at(-1)?.[0] as AgentSidebarProps | undefined
      expect(props?.onMoveBuilderProject).toBeTypeOf('function')
    })
    const props = sidebarRenderSpy.mock.calls.at(-1)![0] as AgentSidebarProps

    props.onMoveBuilderProject?.(
      { originId: 'remote-a', profileId: 'remote-project' },
      { originId: 'local', profileId: 'local-project' },
    )
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledOnce())

    expect(api.put).toHaveBeenCalledWith({
      baseRevision: 1,
      order: [
        { originId: 'remote-a', profileId: 'remote-project' },
        { originId: 'local', profileId: 'local-project' },
      ],
    })
    expect(localLegacyReorder).not.toHaveBeenCalled()
    expect(remoteLegacyReorder).not.toHaveBeenCalled()
  })
})
