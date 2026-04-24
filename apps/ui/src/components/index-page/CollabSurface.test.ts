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

vi.mock('./CollabWorkspace', () => ({
  CollabWorkspace: () => createElement('div', { 'data-testid': 'collab-workspace' }),
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
  CollabWsProvider: ({ children }: { children: unknown; value: unknown }) =>
    createElement('div', { 'data-testid': 'collab-ws-provider' }, children as string),
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
  createCollabSettingsTarget: (wsUrl: string) => ({
    kind: 'collab',
    label: 'Collab backend',
    description: 'Connected remote collaboration backend.',
    wsUrl,
    apiBaseUrl: 'https://collab.example.com/',
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

describe('CollabSurface — admin settings safety (pre-Package 3)', () => {
  it('does NOT mount SettingsPanel for admin collab settings', () => {
    backendStateMock.value = {
      ready: true,
      blockedReason: null,
      wsState: { agents: [], profiles: [] },
    }

    renderCollabSurface({ activeView: 'settings', isAdmin: true })

    // SettingsPanel must never be mounted — it would fire target-unaware requests
    expect(settingsPanelMountSpy).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="settings-panel"]')).toBeNull()
  })

  it('renders placeholder with informational message for admin', () => {
    backendStateMock.value = {
      ready: true,
      blockedReason: null,
      wsState: { agents: [], profiles: [] },
    }

    renderCollabSurface({ activeView: 'settings', isAdmin: true })

    expect(container.textContent).toContain('Collab backend settings')
    expect(container.textContent).toContain('Remote settings panels are being enabled')
    expect(container.querySelector('[data-testid="back-button"]')).not.toBeNull()
  })

  it('does not fire any fetch/HTTP requests from admin collab settings', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    backendStateMock.value = {
      ready: true,
      blockedReason: null,
      wsState: { agents: [], profiles: [] },
    }

    renderCollabSurface({ activeView: 'settings', isAdmin: true })

    // No fetch calls should be made — no terminal, playwright, cortex, or onboarding requests
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('renders blocked state for members (not placeholder or panels)', () => {
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
