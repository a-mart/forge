/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const routeStateMock = vi.hoisted(() => ({
  value: {
    routeState: {
      view: 'chat' as string,
      agentId: '__default__' as string | undefined,
      surface: 'builder' as 'builder' | 'collab',
    },
    activeView: 'chat' as string,
    activeSurface: 'builder' as 'builder' | 'collab',
    navigateToRoute: vi.fn(),
  },
}))

const collabSessionHookMock = vi.hoisted(() => vi.fn())
const defaultSurfaceMock = vi.hoisted(() => ({
  value: 'builder' as 'builder' | 'collab',
}))
const builderSurfacePropsMock = vi.hoisted(() => ({
  value: null as null | Record<string, unknown>,
}))
const collabServerUrlMock = vi.hoisted(() => ({
  value: null as string | null,
}))
const isElectronMock = vi.hoisted(() => ({
  value: false,
}))

vi.mock('@/components/index-page/BuilderSurface', () => ({
  BuilderSurface: (props: Record<string, unknown>) => {
    builderSurfacePropsMock.value = props
    return createElement('div', { 'data-testid': 'builder-surface' }, 'Builder surface')
  },
}))

vi.mock('@/components/index-page/CollabSurface', () => ({
  CollabSurface: () => createElement('div', { 'data-testid': 'collab-surface' }, 'Collab surface'),
}))

vi.mock('@/hooks/index-page/use-route-state', () => ({
  DEFAULT_MANAGER_AGENT_ID: '__default__',
  useRouteState: () => routeStateMock.value,
}))

vi.mock('@/hooks/use-collaboration-session', () => ({
  useCollaborationSession: collabSessionHookMock,
}))

vi.mock('@/lib/backend-url', () => ({
  resolveBackendWsUrl: () => 'ws://forge.test/ws',
}))

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationWsUrl: () => 'ws://forge.test/ws',
  getCollabServerUrl: () => collabServerUrlMock.value,
  isCollabServerRemote: () => {
    const url = collabServerUrlMock.value
    if (!url) return false
    try {
      const normalize = (u: string): string => {
        const httpUrl = u.replace(/^ws(s?):\/\//, 'http$1://')
        const parsed = new URL(httpUrl)
        if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1'
        return parsed.origin
      }
      // Backend is mocked at ws://forge.test/ws
      return normalize(url) !== normalize('ws://forge.test/ws')
    } catch {
      return false
    }
  },
}))

vi.mock('@/lib/electron-bridge', () => ({
  isElectron: () => isElectronMock.value,
}))

vi.mock('@/lib/web-runtime-flags', () => ({
  getConfiguredDefaultSurface: () => defaultSurfaceMock.value,
}))

const { IndexPage } = await import('./index')

let container: HTMLDivElement
let root: Root | null = null

function renderPage(): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(IndexPage))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  routeStateMock.value = {
    routeState: {
      view: 'chat',
      agentId: '__default__',
      surface: 'builder',
    },
    activeView: 'chat',
    activeSurface: 'builder',
    navigateToRoute: vi.fn(),
  }
  collabSessionHookMock.mockReset()
  builderSurfacePropsMock.value = null
  defaultSurfaceMock.value = 'builder'
  collabServerUrlMock.value = null
  isElectronMock.value = false
  collabSessionHookMock.mockReturnValue({
    isCollabEnabled: false,
    isAdmin: false,
    isMember: false,
    isLoading: false,
    hasLoaded: false,
    refresh: vi.fn(),
  })
  window.history.replaceState(null, '', '/')
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

describe('IndexPage collab bootstrap gating', () => {
  it('blocks on a loading screen while collab session state is still loading', () => {
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: false,
      isAdmin: false,
      isMember: false,
      isLoading: true,
      hasLoaded: false,
      refresh: vi.fn(),
    })

    renderPage()

    expect(container.textContent).toContain('Loading…')
    expect(container.querySelector('[data-testid="builder-surface"]')).toBeNull()
    expect(collabSessionHookMock).toHaveBeenCalledWith({
      enabled: true,
    })
  })

  it('passes a builder/collab mode switch to the builder surface for collab admins', () => {
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: true,
      isAdmin: true,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    expect(container.querySelector('[data-testid="builder-surface"]')?.textContent).toContain('Builder surface')
    expect(builderSurfacePropsMock.value).toMatchObject({
      collaborationModeSwitch: {
        activeSurface: 'builder',
      },
    })
  })

  it('redirects member-only users onto the collab surface even from the builder route', () => {
    const navigateToRoute = vi.fn()
    routeStateMock.value = {
      routeState: {
        view: 'chat',
        agentId: '__default__',
        surface: 'builder',
      },
      activeView: 'chat',
      activeSurface: 'builder',
      navigateToRoute,
    }
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: true,
      isAdmin: false,
      isMember: true,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    expect(navigateToRoute).toHaveBeenCalledWith({
      view: 'chat',
      agentId: '__default__',
      surface: 'collab',
      channel: undefined,
    }, true)
  })

  it('keeps Builder accessible when collab is enabled but user is not authenticated', () => {
    const navigateToRoute = vi.fn()
    routeStateMock.value = {
      routeState: {
        view: 'chat',
        agentId: '__default__',
        surface: 'collab',
      },
      activeView: 'chat',
      activeSurface: 'collab',
      navigateToRoute,
    }
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: true,
      isAdmin: false,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    expect(container.querySelector('[data-testid="builder-surface"]')?.textContent).toContain('Builder surface')
    expect(container.querySelector('[data-testid="collab-surface"]')).toBeNull()
    expect(navigateToRoute).toHaveBeenCalledWith({
      view: 'chat',
      agentId: '__default__',
      surface: 'builder',
    }, true)
  })

  it('does not redirect a member away from forced collab settings route', () => {
    const navigateToRoute = vi.fn()
    routeStateMock.value = {
      routeState: {
        view: 'settings',
        agentId: undefined,
        surface: 'collab',
      },
      activeView: 'settings',
      activeSurface: 'collab',
      navigateToRoute,
    }
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: true,
      isAdmin: false,
      isMember: true,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    // Member at forced collab settings should NOT be redirected to chat
    expect(navigateToRoute).not.toHaveBeenCalled()
    // Should render collab surface (which shows admin-required state)
    expect(container.querySelector('[data-testid="collab-surface"]')?.textContent).toContain('Collab surface')
  })

  it('renders collab surface for forced collab settings when unauthenticated', () => {
    const navigateToRoute = vi.fn()
    routeStateMock.value = {
      routeState: {
        view: 'settings',
        agentId: undefined,
        surface: 'collab',
      },
      activeView: 'settings',
      activeSurface: 'collab',
      navigateToRoute,
    }
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: true,
      isAdmin: false,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    // Should render collab surface (which shows auth-required state), NOT builder
    expect(container.querySelector('[data-testid="collab-surface"]')?.textContent).toContain('Collab surface')
    expect(container.querySelector('[data-testid="builder-surface"]')).toBeNull()
  })

  it('keeps unauthenticated users on the collab surface when collab is the configured default', () => {
    const navigateToRoute = vi.fn()
    defaultSurfaceMock.value = 'collab'
    routeStateMock.value = {
      routeState: {
        view: 'chat',
        agentId: '__default__',
        surface: 'collab',
      },
      activeView: 'chat',
      activeSurface: 'collab',
      navigateToRoute,
    }
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: true,
      isAdmin: false,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    expect(container.querySelector('[data-testid="collab-surface"]')?.textContent).toContain('Collab surface')
    expect(container.querySelector('[data-testid="builder-surface"]')).toBeNull()
    expect(navigateToRoute).not.toHaveBeenCalled()
  })

  it('renders collab surface for admin at collab settings', () => {
    const navigateToRoute = vi.fn()
    routeStateMock.value = {
      routeState: {
        view: 'settings',
        agentId: undefined,
        surface: 'collab',
      },
      activeView: 'settings',
      activeSurface: 'collab',
      navigateToRoute,
    }
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: true,
      isAdmin: true,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    // Admin should see collab surface with settings
    expect(container.querySelector('[data-testid="collab-surface"]')?.textContent).toContain('Collab surface')
    expect(container.querySelector('[data-testid="builder-surface"]')).toBeNull()
  })

  it('shows collab mode switch when server URL is configured but server is offline', () => {
    collabServerUrlMock.value = 'https://collab.example.com'
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: false,
      isAdmin: false,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    expect(container.querySelector('[data-testid="builder-surface"]')?.textContent).toContain('Builder surface')
    expect(builderSurfacePropsMock.value).toMatchObject({
      collaborationModeSwitch: {
        activeSurface: 'builder',
      },
    })
  })

  it('renders collab surface when server URL is configured but offline and user navigates to collab', () => {
    collabServerUrlMock.value = 'https://collab.example.com'
    routeStateMock.value = {
      routeState: {
        view: 'chat',
        agentId: '__default__',
        surface: 'collab',
      },
      activeView: 'chat',
      activeSurface: 'collab',
      navigateToRoute: vi.fn(),
    }
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: false,
      isAdmin: false,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    expect(container.querySelector('[data-testid="collab-surface"]')?.textContent).toContain('Collab surface')
    expect(container.querySelector('[data-testid="builder-surface"]')).toBeNull()
  })

  it('renders collab surface when server URL is configured and user is unauthenticated (toggle click regression)', () => {
    // Regression: when hasConfiguredCollabServer is true and the collab backend
    // reports enabled=true but the user is not authenticated, the effectiveSurface
    // check would force the user back to builder — making the toggle click a no-op.
    collabServerUrlMock.value = 'https://collab.example.com'
    const navigateToRoute = vi.fn()
    routeStateMock.value = {
      routeState: {
        view: 'chat',
        agentId: '__default__',
        surface: 'collab',
      },
      activeView: 'chat',
      activeSurface: 'collab',
      navigateToRoute,
    }
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: true,
      isAdmin: false,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    // Must render collab surface, NOT revert to builder
    expect(container.querySelector('[data-testid="collab-surface"]')?.textContent).toContain('Collab surface')
    expect(container.querySelector('[data-testid="builder-surface"]')).toBeNull()
    // Must NOT navigate back to builder
    expect(navigateToRoute).not.toHaveBeenCalled()
  })

  it('still bounces unauthenticated same-origin collab users to builder', () => {
    // When no remote server is configured (same-origin collab), unauthenticated
    // users should still be bounced to builder.
    collabServerUrlMock.value = null
    const navigateToRoute = vi.fn()
    routeStateMock.value = {
      routeState: {
        view: 'chat',
        agentId: '__default__',
        surface: 'collab',
      },
      activeView: 'chat',
      activeSurface: 'collab',
      navigateToRoute,
    }
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: true,
      isAdmin: false,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    // Same-origin unauthenticated: should render builder, not collab
    expect(container.querySelector('[data-testid="builder-surface"]')?.textContent).toContain('Builder surface')
    expect(container.querySelector('[data-testid="collab-surface"]')).toBeNull()
    // Should navigate back to builder surface
    expect(navigateToRoute).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'builder' }),
      true,
    )
  })

  it('bounces unauthenticated users to builder when configured collab URL is same-origin as backend', () => {
    // Regression: an explicitly configured URL that resolves to the same origin
    // as the Forge backend should behave identically to "no configured URL" for
    // the unauthenticated bounce — only truly remote origins bypass the bounce.
    collabServerUrlMock.value = 'http://forge.test'
    const navigateToRoute = vi.fn()
    routeStateMock.value = {
      routeState: {
        view: 'chat',
        agentId: '__default__',
        surface: 'collab',
      },
      activeView: 'chat',
      activeSurface: 'collab',
      navigateToRoute,
    }
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: true,
      isAdmin: false,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    // Same-origin configured URL: unauthenticated users must bounce to builder
    expect(container.querySelector('[data-testid="builder-surface"]')?.textContent).toContain('Builder surface')
    expect(container.querySelector('[data-testid="collab-surface"]')).toBeNull()
    expect(navigateToRoute).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'builder' }),
      true,
    )
  })

  it('disables collab session loading in Electron when configured URL is same-origin', () => {
    // Regression: in Electron with an explicitly configured URL that resolves to
    // the same origin as the embedded backend, collab should not load at all —
    // same-origin in Electron means the user accidentally configured their own
    // embedded backend URL, which doesn't provide a remote collab server.
    isElectronMock.value = true
    collabServerUrlMock.value = 'http://forge.test'
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: false,
      isAdmin: false,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    // Collab session should be disabled (enabled: false)
    expect(collabSessionHookMock).toHaveBeenCalledWith({ enabled: false })
    // Should render builder surface
    expect(container.querySelector('[data-testid="builder-surface"]')?.textContent).toContain('Builder surface')
    expect(container.querySelector('[data-testid="collab-surface"]')).toBeNull()
  })

  it('hides mode switch when configured collab URL is same-origin and collab is not admin-enabled', () => {
    // Same-origin configured URL should not show mode switch by itself
    collabServerUrlMock.value = 'http://forge.test'
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: false,
      isAdmin: false,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    expect(container.querySelector('[data-testid="builder-surface"]')?.textContent).toContain('Builder surface')
    expect(builderSurfacePropsMock.value?.collaborationModeSwitch).toBeUndefined()
  })

  it('hides mode switch when no server URL is configured and collab is not enabled', () => {
    collabSessionHookMock.mockReturnValue({
      isCollabEnabled: false,
      isAdmin: false,
      isMember: false,
      isLoading: false,
      hasLoaded: true,
      refresh: vi.fn(),
    })

    renderPage()

    expect(container.querySelector('[data-testid="builder-surface"]')?.textContent).toContain('Builder surface')
    expect(builderSurfacePropsMock.value?.collaborationModeSwitch).toBeUndefined()
  })
})
