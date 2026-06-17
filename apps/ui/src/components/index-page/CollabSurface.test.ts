/** @vitest-environment jsdom */

import { createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveView } from '@/hooks/index-page/use-route-state'

/* ------------------------------------------------------------------ */
/*  Track whether SettingsPanel is ever mounted                       */
/* ------------------------------------------------------------------ */

const settingsPanelMountSpy = vi.hoisted(() => vi.fn())

vi.mock('@/components/chat/SettingsDialog', () => ({
  SettingsPanel: (props: Record<string, unknown>) => {
    settingsPanelMountSpy(props)
    return createElement('div', { 'data-testid': 'settings-panel' }, 'Settings panel')
  },
}))

/* ------------------------------------------------------------------ */
/*  Mock dependencies                                                 */
/* ------------------------------------------------------------------ */

vi.mock('@/components/chat/collab-sidebar/CollabSidebar', () => ({
  CollabSidebar: () => createElement('div', { 'data-testid': 'collab-sidebar' }),
}))

const collabWorkspaceMountSpy = vi.hoisted(() => vi.fn())

vi.mock('./CollabWorkspace', () => ({
  CollabWorkspace: (props: Record<string, unknown>) => {
    collabWorkspaceMountSpy(props)
    return createElement('div', { 'data-testid': 'collab-workspace' })
  },
}))

const collabWsProviderMock = vi.hoisted(() => ({
  value: null as null | { clientRef?: { current: unknown } },
}))

vi.mock('@/hooks/index-page/use-collab-ws-connection', () => ({
  useCollabWsConnection: () => ({
    clientRef: createRef(),
    state: {
      connected: false,
      channels: [],
      messages: {},
      members: [],
      activeChannelId: null,
    },
  }),
  CollabWsProvider: ({ children, value }: { children: unknown; value: unknown }) => {
    collabWsProviderMock.value = value as { clientRef?: { current: unknown } }
    return createElement('div', { 'data-testid': 'collab-ws-provider' }, children as string)
  },
}))

const collabConnectionsMock = vi.hoisted(() => ({
  value: {
    connectionStates: {} as Record<string, unknown>,
    connectionIds: [] as string[],
    targets: [] as Array<{ connectionId: string; [key: string]: unknown }>,
    activeConnectionId: null as string | null,
    activeChannelId: null as string | null,
    setActiveChannel: vi.fn(),
    getClient: () => null,
    managerRef: { current: null },
  },
}))

vi.mock('@/hooks/index-page/use-collab-connections', () => ({
  useCollabConnections: () => collabConnectionsMock.value,
  CollabConnectionsProvider: ({ children }: { children: unknown; value: unknown }) =>
    createElement('div', { 'data-testid': 'collab-connections-provider' }, children as string),
}))

const backendStateMock = vi.hoisted(() => ({
  value: {
    ready: false,
    blockedReason: null as string | null,
    wsState: null as null | Record<string, unknown>,
  },
}))

vi.mock('@/components/settings/use-settings-backend-state', () => ({
  useSettingsBackendState: () => backendStateMock.value,
}))

vi.mock('@/components/settings/settings-target', () => ({
  createCollabSettingsTarget: (wsUrl: string, apiBaseUrl?: string) => ({
    kind: 'collab',
    label: 'Collab backend',
    description: 'Connected remote collaboration backend.',
    wsUrl,
    apiBaseUrl: apiBaseUrl ?? 'https://collab.example.com/',
    fetchCredentials: 'include',
    requiresAdmin: true,
    availableTabs: ['general', 'auth', 'models', 'about'],
  }),
}))

vi.mock('@/components/ui/button', () => ({
  Button: (props: Record<string, unknown>) =>
    createElement('button', { 'data-testid': 'back-button', onClick: props.onClick as () => void }, props.children as string),
}))

const { CollabSurface } = await import('./CollabSurface')

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement
let root: Root | null = null

const defaultConnectionState = {
  connected: false,
  workspace: null,
  categories: [],
  channels: [],
  currentUser: null,
  activeChannelId: null,
  channelHistory: [],
  channelHistoryLoaded: false,
  channelStatus: 'idle',
  channelStreamingStartedAt: undefined,
  sessionWorkers: [],
  sessionActivity: [],
  sessionAgentStatuses: {},
  pendingChoiceRequests: [],
  channelReadStates: {},
  channelUnreadCounts: {},
  lastError: null,
  lastErrorCode: null,
  hasBootstrapped: false,
}

const defaultTargets = [
  {
    connectionId: 'conn_test',
    kind: 'remote' as const,
    label: 'Test Server',
    serverUrl: 'https://collab.example.com',
    apiBaseUrl: 'https://collab.example.com/',
    wsUrl: 'wss://collab.example.com',
    isRemote: true,
  },
]

function renderCollabSurface(overrides: Partial<{
  activeView: ActiveView
  isAdmin: boolean
  isMember: boolean
  hasLoaded: boolean
}> = {}) {
  root = createRoot(container)
  act(() => {
    root?.render(
      createElement(CollabSurface, {
        targets: defaultTargets,
        wsUrl: 'wss://collab.example.com',
        activeView: overrides.activeView ?? ('settings' as ActiveView),
        activeSurface: 'collab' as const,
        isAdmin: overrides.isAdmin ?? true,
        isMember: overrides.isMember ?? false,
        hasLoaded: overrides.hasLoaded ?? true,
        onSelectChannel: vi.fn(),
        onSelectSurface: vi.fn(),
        onOpenSettings: vi.fn(),
        onBackToChat: vi.fn(),
      }),
    )
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  settingsPanelMountSpy.mockReset()
  collabWorkspaceMountSpy.mockReset()
  collabWsProviderMock.value = null
  collabConnectionsMock.value = {
    connectionStates: {},
    connectionIds: [],
    targets: [],
    activeConnectionId: null,
    activeChannelId: null,
    setActiveChannel: vi.fn(),
    getClient: () => null,
    managerRef: { current: null },
  }
  backendStateMock.value = {
    ready: false,
    blockedReason: null,
    wsState: null,
  }
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container.remove()
})

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('CollabSurface — admin settings with target-aware panel', () => {
  it('mounts SettingsPanel with collab target for admin', () => {
    backendStateMock.value = {
      ready: true,
      blockedReason: null,
      wsState: { agents: [], profiles: [] },
    }

    renderCollabSurface({ activeView: 'settings', isAdmin: true })

    // Package 3: SettingsPanel IS mounted with collab target
    expect(settingsPanelMountSpy).toHaveBeenCalledTimes(1)
    const props = settingsPanelMountSpy.mock.calls[0][0]
    expect(props.target.kind).toBe('collab')
    expect(props.target.apiBaseUrl).toBe('https://collab.example.com/')
    expect(container.querySelector('[data-testid="settings-panel"]')).not.toBeNull()
  })

  it('passes remote managers and profiles from wsState to SettingsPanel', () => {
    backendStateMock.value = {
      ready: true,
      blockedReason: null,
      wsState: { agents: [{ id: 'mgr-1' }], profiles: [{ id: 'prof-1' }] },
    }

    renderCollabSurface({ activeView: 'settings', isAdmin: true })

    const props = settingsPanelMountSpy.mock.calls[0][0]
    expect(props.managers).toEqual([{ id: 'mgr-1' }])
    expect(props.profiles).toEqual([{ id: 'prof-1' }])
  })
})

describe('CollabSurface — blocked states', () => {
  it('renders blocked state for members (not settings panels)', () => {
    backendStateMock.value = {
      ready: false,
      blockedReason: 'admin_required',
      wsState: null,
    }

    renderCollabSurface({ activeView: 'settings', isAdmin: false, isMember: true })

    expect(settingsPanelMountSpy).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Admin access required')
  })

  it('renders blocked state for unauthenticated users', () => {
    backendStateMock.value = {
      ready: false,
      blockedReason: 'auth_required',
      wsState: null,
    }

    renderCollabSurface({ activeView: 'settings', isAdmin: false, isMember: false })

    expect(settingsPanelMountSpy).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Sign in required')
  })

  it('renders workspace (not settings) when activeView is chat', () => {
    renderCollabSurface({ activeView: 'chat' })

    expect(settingsPanelMountSpy).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="collab-workspace"]')).not.toBeNull()
  })
})

describe('CollabSurface — Blocker 2: settings target uses active apiBaseUrl', () => {
  it('passes the active target apiBaseUrl to createCollabSettingsTarget', () => {
    const targets = [
      {
        connectionId: 'conn_active',
        kind: 'remote' as const,
        label: 'Active Server',
        serverUrl: 'https://active.example.com',
        apiBaseUrl: 'https://active.example.com/',
        wsUrl: 'wss://active.example.com',
        isRemote: true,
      },
    ]

    collabConnectionsMock.value = {
      connectionStates: {},
      connectionIds: ['conn_active'],
      targets: [],
      activeConnectionId: 'conn_active',
      activeChannelId: null,
      setActiveChannel: vi.fn(),
      getClient: () => null,
      managerRef: { current: null },
    }

    backendStateMock.value = {
      ready: true,
      blockedReason: null,
      wsState: { agents: [], profiles: [] },
    }

    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(CollabSurface, {
          targets,
          wsUrl: 'wss://fallback.example.com', // should NOT be used for apiBaseUrl
          collab: 'conn_active',
          activeView: 'settings' as ActiveView,
          activeSurface: 'collab' as const,
          isAdmin: true,
          isMember: false,
          hasLoaded: true,
          onSelectChannel: vi.fn(),
          onSelectSurface: vi.fn(),
          onOpenSettings: vi.fn(),
          onBackToChat: vi.fn(),
        }),
      )
    })

    expect(settingsPanelMountSpy).toHaveBeenCalledTimes(1)
    const props = settingsPanelMountSpy.mock.calls[0][0]
    // Should use the active target's apiBaseUrl, not the fallback wsUrl's
    expect(props.target.apiBaseUrl).toBe('https://active.example.com/')
    expect(props.target.wsUrl).toBe('wss://active.example.com')
  })
})

describe('CollabSurface — Blocker 1: canonical default fallback', () => {
  it('resolves to targets[0] (registry-ordered) when collab param is absent, not connectionIds[0]', () => {
    // Setup: targets has conn_B first (canonical default from registry ordering),
    // but connections mock has conn_A first in insertion order.
    const targets = [
      {
        connectionId: 'conn_B',
        kind: 'remote' as const,
        label: 'Server B',
        serverUrl: 'https://b.example.com',
        apiBaseUrl: 'https://b.example.com/',
        wsUrl: 'wss://b.example.com',
        isRemote: true,
      },
      {
        connectionId: 'conn_A',
        kind: 'remote' as const,
        label: 'Server A',
        serverUrl: 'https://a.example.com',
        apiBaseUrl: 'https://a.example.com/',
        wsUrl: 'wss://a.example.com',
        isRemote: true,
      },
    ]

    collabConnectionsMock.value = {
      connectionStates: {
        conn_A: {
          connected: true,
          workspace: null,
          categories: [],
          channels: [],
          currentUser: null,
          activeChannelId: null,
          channelHistory: [],
          channelHistoryLoaded: false,
          channelStatus: 'idle',
          channelStreamingStartedAt: undefined,
          sessionWorkers: [],
          sessionActivity: [],
          sessionAgentStatuses: {},
          pendingChoiceRequests: [],
          channelReadStates: {},
          channelUnreadCounts: {},
          lastError: null,
          lastErrorCode: null,
          hasBootstrapped: true,
        },
        conn_B: {
          connected: true,
          workspace: null,
          categories: [],
          channels: [],
          currentUser: null,
          activeChannelId: null,
          channelHistory: [],
          channelHistoryLoaded: false,
          channelStatus: 'idle',
          channelStreamingStartedAt: undefined,
          sessionWorkers: [],
          sessionActivity: [],
          sessionAgentStatuses: {},
          pendingChoiceRequests: [],
          channelReadStates: {},
          channelUnreadCounts: {},
          lastError: null,
          lastErrorCode: null,
          hasBootstrapped: true,
        },
      },
      connectionIds: ['conn_A', 'conn_B'], // insertion order differs from targets
      targets: [],
      activeConnectionId: null, // no in-memory selection
      activeChannelId: null,
      setActiveChannel: vi.fn(),
      getClient: () => null,
      managerRef: { current: null },
    }

    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(CollabSurface, {
          targets,
          wsUrl: 'wss://fallback.example.com',
          // collab is absent — no route param
          activeView: 'chat' as ActiveView,
          activeSurface: 'collab' as const,
          isAdmin: true,
          isMember: false,
          hasLoaded: true,
          onSelectChannel: vi.fn(),
          onSelectSurface: vi.fn(),
          onOpenSettings: vi.fn(),
          onBackToChat: vi.fn(),
        }),
      )
    })

    // CollabWorkspace should receive the wsUrl from targets[0] (conn_B),
    // NOT from connectionIds[0] (conn_A).
    expect(collabWorkspaceMountSpy).toHaveBeenCalledTimes(1)
    const wsUrlProp = collabWorkspaceMountSpy.mock.calls[0][0].wsUrl
    expect(wsUrlProp).toBe('wss://b.example.com')
  })
})

describe('CollabSurface — Blocker 3: stale collab param normalization', () => {
  it('calls onSelectChannel to normalize a stale/deleted collab param', () => {
    const onSelectChannel = vi.fn()

    collabConnectionsMock.value = {
      connectionStates: {},
      connectionIds: ['conn_A'],
      targets: [],
      activeConnectionId: null,
      activeChannelId: null,
      setActiveChannel: vi.fn(),
      getClient: () => null,
      managerRef: { current: null },
    }

    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(CollabSurface, {
          targets: [
            {
              connectionId: 'conn_A',
              kind: 'remote' as const,
              label: 'Server A',
              serverUrl: 'https://a.example.com',
              apiBaseUrl: 'https://a.example.com/',
              wsUrl: 'wss://a.example.com',
              isRemote: true,
            },
          ],
          wsUrl: 'wss://a.example.com',
          collab: 'conn_deleted', // stale — doesn't match any live connection
          channel: 'some-channel',
          activeView: 'chat' as ActiveView,
          activeSurface: 'collab' as const,
          isAdmin: true,
          isMember: false,
          hasLoaded: true,
          onSelectChannel,
          onSelectSurface: vi.fn(),
          onOpenSettings: vi.fn(),
          onBackToChat: vi.fn(),
        }),
      )
    })

    // The useEffect should fire to normalize the stale param.
    // Since resolvedConnectionId == defaultConnectionId (conn_A), the
    // normalized connectionId should be undefined (clears param).
    expect(onSelectChannel).toHaveBeenCalledWith('some-channel', undefined)
  })

  it('does NOT call onSelectChannel when activeView is settings (defers normalization)', () => {
    const onSelectChannel = vi.fn()

    collabConnectionsMock.value = {
      connectionStates: {},
      connectionIds: ['conn_A'],
      targets: [],
      activeConnectionId: null,
      activeChannelId: null,
      setActiveChannel: vi.fn(),
      getClient: () => null,
      managerRef: { current: null },
    }

    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(CollabSurface, {
          targets: [
            {
              connectionId: 'conn_A',
              kind: 'remote' as const,
              label: 'Server A',
              serverUrl: 'https://a.example.com',
              apiBaseUrl: 'https://a.example.com/',
              wsUrl: 'wss://a.example.com',
              isRemote: true,
            },
          ],
          wsUrl: 'wss://a.example.com',
          collab: 'conn_deleted', // stale — doesn't match any live connection
          channel: 'some-channel',
          activeView: 'settings' as ActiveView, // <-- settings, not chat
          activeSurface: 'collab' as const,
          isAdmin: true,
          isMember: false,
          hasLoaded: true,
          onSelectChannel,
          onSelectSurface: vi.fn(),
          onOpenSettings: vi.fn(),
          onBackToChat: vi.fn(),
        }),
      )
    })

    // Normalization must NOT fire during settings view — it would
    // kick the user out to chat.  The stale param is harmless during
    // settings; it normalizes when the user returns to chat.
    expect(onSelectChannel).not.toHaveBeenCalled()
  })
})

describe('CollabSurface — Blocker 3: empty connectionIds guard (remount race)', () => {
  it('does NOT normalize a valid collab param when connectionIds is empty (connections not yet synced)', () => {
    // Regression: on remount (e.g., switching builder → collab), the
    // connection manager starts empty.  Without the guard, the normalization
    // effect fires on the first render, treats the valid `collab` param as
    // stale (because connectionIds is []), strips it from the URL, and
    // routes subsequent channel subscriptions to the wrong backend —
    // producing "Unknown collaboration channel" errors.
    const onSelectChannel = vi.fn()

    // Simulate the state BEFORE connections have synced: empty connectionIds
    collabConnectionsMock.value = {
      connectionStates: {},
      connectionIds: [], // <-- empty, as on first render after remount
      targets: [],
      activeConnectionId: null,
      activeChannelId: null,
      setActiveChannel: vi.fn(),
      getClient: () => null,
      managerRef: { current: null },
    }

    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(CollabSurface, {
          targets: [
            {
              connectionId: 'conn_47388',
              kind: 'remote' as const,
              label: 'Server 47388',
              serverUrl: 'https://127.0.0.1:47388',
              apiBaseUrl: 'https://127.0.0.1:47388/',
              wsUrl: 'wss://127.0.0.1:47388',
              isRemote: true,
            },
          ],
          wsUrl: 'wss://127.0.0.1:47388',
          collab: 'conn_47388', // valid — belongs to the target above
          channel: 'channel-uuid-123',
          activeView: 'chat' as ActiveView,
          activeSurface: 'collab' as const,
          isAdmin: true,
          isMember: false,
          hasLoaded: true,
          onSelectChannel,
          onSelectSurface: vi.fn(),
          onOpenSettings: vi.fn(),
          onBackToChat: vi.fn(),
        }),
      )
    })

    // Normalization must NOT fire — connectionIds is empty, so we can't
    // determine whether the param is stale yet.
    expect(onSelectChannel).not.toHaveBeenCalled()
  })

  it('normalizes a stale collab param AFTER connections have synced', () => {
    // Verify that the guard doesn't prevent normalization once connections
    // are populated and the param is genuinely stale.
    const onSelectChannel = vi.fn()

    collabConnectionsMock.value = {
      connectionStates: {},
      connectionIds: ['conn_A'], // connections synced — 'conn_deleted' is not here
      targets: [],
      activeConnectionId: null,
      activeChannelId: null,
      setActiveChannel: vi.fn(),
      getClient: () => null,
      managerRef: { current: null },
    }

    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(CollabSurface, {
          targets: [
            {
              connectionId: 'conn_A',
              kind: 'remote' as const,
              label: 'Server A',
              serverUrl: 'https://a.example.com',
              apiBaseUrl: 'https://a.example.com/',
              wsUrl: 'wss://a.example.com',
              isRemote: true,
            },
          ],
          wsUrl: 'wss://a.example.com',
          collab: 'conn_deleted', // genuinely stale
          channel: 'some-channel',
          activeView: 'chat' as ActiveView,
          activeSurface: 'collab' as const,
          isAdmin: true,
          isMember: false,
          hasLoaded: true,
          onSelectChannel,
          onSelectSurface: vi.fn(),
          onOpenSettings: vi.fn(),
          onBackToChat: vi.fn(),
        }),
      )
    })

    // With connections synced, the stale param should be normalized.
    expect(onSelectChannel).toHaveBeenCalledWith('some-channel', undefined)
  })
})

describe('CollabSurface — async active client attachment', () => {
  it('refreshes CollabWsProvider clientRef when authenticated probe attaches a client after initial render', () => {
    const firstState = { ...defaultConnectionState }
    const attachedState = { ...defaultConnectionState, connected: true }
    const attachedClient = { sendMessage: vi.fn() }
    let currentClient: unknown = null

    collabConnectionsMock.value = {
      connectionStates: { conn_test: firstState },
      connectionIds: ['conn_test'],
      targets: [],
      activeConnectionId: null,
      activeChannelId: null,
      setActiveChannel: vi.fn(),
      getClient: () => currentClient as never,
      managerRef: { current: null },
    }

    root = createRoot(container)
    const props = {
      targets: defaultTargets,
      wsUrl: 'wss://collab.example.com',
      collab: 'conn_test',
      activeView: 'chat' as ActiveView,
      activeSurface: 'collab' as const,
      isAdmin: true,
      isMember: false,
      hasLoaded: true,
      onSelectChannel: vi.fn(),
      onSelectSurface: vi.fn(),
      onOpenSettings: vi.fn(),
      onBackToChat: vi.fn(),
    }

    act(() => {
      root?.render(createElement(CollabSurface, props))
    })

    expect(collabWsProviderMock.value?.clientRef?.current).toBeNull()

    currentClient = attachedClient
    collabConnectionsMock.value = {
      ...collabConnectionsMock.value,
      connectionStates: { conn_test: attachedState },
    }

    act(() => {
      root?.render(createElement(CollabSurface, props))
    })

    expect(collabWsProviderMock.value?.clientRef?.current).toBe(attachedClient)
  })
})

describe('CollabSurface — onSignIn threading', () => {
  it('passes onSignIn callback to CollabWorkspace in chat view', () => {
    const onSignIn = vi.fn()
    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(CollabSurface, {
          targets: defaultTargets,
          wsUrl: 'wss://collab.example.com',
          activeView: 'chat' as ActiveView,
          activeSurface: 'collab' as const,
          isAdmin: true,
          isMember: false,
          hasLoaded: true,
          onSelectChannel: vi.fn(),
          onSelectSurface: vi.fn(),
          onOpenSettings: vi.fn(),
          onBackToChat: vi.fn(),
          onSignIn,
        }),
      )
    })

    expect(collabWorkspaceMountSpy).toHaveBeenCalledTimes(1)
    const props = collabWorkspaceMountSpy.mock.calls[0][0]
    // onSignIn is now wrapped via useCallback to inject the active backend's
    // apiBaseUrl, so it's not identity-equal.  Verify the wrapper forwards.
    expect(typeof props.onSignIn).toBe('function')
    props.onSignIn()
    expect(onSignIn).toHaveBeenCalledTimes(1)
  })

  it('wraps onSignIn to inject active backend apiBaseUrl', () => {
    const onSignIn = vi.fn()
    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(CollabSurface, {
          targets: defaultTargets,
          wsUrl: 'wss://collab.example.com',
          activeView: 'chat' as ActiveView,
          activeSurface: 'collab' as const,
          isAdmin: true,
          isMember: false,
          hasLoaded: true,
          onSelectChannel: vi.fn(),
          onSelectSurface: vi.fn(),
          onOpenSettings: vi.fn(),
          onBackToChat: vi.fn(),
          onSignIn,
        }),
      )
    })

    const props = collabWorkspaceMountSpy.mock.calls[0][0]
    props.onSignIn()

    // The wrapper should forward the active target's apiBaseUrl
    expect(onSignIn).toHaveBeenCalledWith('https://collab.example.com/')
  })
})
