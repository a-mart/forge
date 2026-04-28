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

vi.mock('@/lib/electron-bridge', () => ({
  isElectron: () => false,
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
})
