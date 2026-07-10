/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { HelpProvider } from '@/components/help/HelpProvider'
import { LOCAL_ORIGIN_ID, originRegistry } from '@/lib/origin-store'
import type { BuilderSidebarOrderApi } from '@/lib/builder-sidebar-order-api'

const { remoteRowRenderSpy } = vi.hoisted(() => ({ remoteRowRenderSpy: vi.fn() }))
vi.mock('./agent-sidebar/RemoteOriginSections', async () => {
  const actual = await vi.importActual<typeof import('./agent-sidebar/RemoteOriginSections')>(
    './agent-sidebar/RemoteOriginSections',
  )
  const React = await import('react')
  const rowProps = await import('./agent-sidebar/remote-profile-row-props')
  return {
    ...actual,
    RemoteProfileRow: React.memo((props: Parameters<typeof rowProps.equalRemoteProfileRowProps>[0]) => {
      remoteRowRenderSpy(props)
      return React.createElement('div', { 'data-testid': 'remote-row-probe' })
    }, rowProps.equalRemoteProfileRowProps),
  }
})

import { AgentSidebarConnected } from './AgentSidebarConnected'

let container: HTMLDivElement
let root: Root | null = null

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
    ...manager(agentId, profileId),
    managerId,
    role: 'worker',
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

beforeEach(() => {
  remoteRowRenderSpy.mockReset()
  originRegistry.destroyAll()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  container.remove()
  originRegistry.destroyAll()
})

describe('AgentSidebarConnected remote row isolation', () => {
  it('does not rerender an unrelated remote row for a production-shaped remote worker status event', async () => {
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
      },
    })
    const remoteA = originRegistry.createOrigin({
      originId: 'remote-a',
      wsUrl: 'ws://remote-a.test',
      offline: true,
    })
    remoteA.ingest({
      type: 'snapshot',
      state: {
        connected: true,
        agents: [manager('remote-a-session', 'remote-a-project'), worker('remote-a-worker', 'remote-a-session', 'remote-a-project')],
        profiles: [profile('remote-a-project', 'remote-a-session')],
      },
    })
    const remoteB = originRegistry.createOrigin({
      originId: 'remote-b',
      wsUrl: 'ws://remote-b.test',
      offline: true,
    })
    remoteB.ingest({
      type: 'snapshot',
      state: {
        connected: true,
        agents: [manager('remote-session', 'remote-project')],
        profiles: [profile('remote-project', 'remote-session')],
      },
    })

    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => ({
        version: 1 as const,
        revision: 1,
        order: [
          { originId: 'local', profileId: 'local-project' },
          { originId: 'remote-a', profileId: 'remote-a-project' },
          { originId: 'remote-b', profileId: 'remote-project' },
        ],
        updatedAt: '2026-07-09T12:00:00.000Z',
      })),
      put: vi.fn(),
    }
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(HelpProvider, null, createElement(AgentSidebarConnected, {
        builderSidebarOrderApi: api,
        selectedAgentId: 'local-session',
        activeOriginId: LOCAL_ORIGIN_ID,
        isSettingsActive: false,
        onAddManager: vi.fn(),
        onSelectAgent: vi.fn(),
        onSelectRemoteAgent: vi.fn(),
        onDeleteAgent: vi.fn(),
        onDeleteManager: vi.fn(),
        onOpenSettings: vi.fn(),
      })))
    })
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(remoteRowRenderSpy).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    remoteRowRenderSpy.mockClear()

    flushSync(() => {
      remoteA.ingest({
        type: 'event',
        event: {
          type: 'agent_status',
          agentId: 'remote-a-worker',
          managerId: 'remote-a-session',
          status: 'streaming',
          pendingCount: 1,
        },
      })
    })
    await Promise.resolve()

    expect(remoteRowRenderSpy.mock.calls.filter(([props]) => props.originId === 'remote-b')).toHaveLength(0)
    expect(api.put).not.toHaveBeenCalled()
  })
})
