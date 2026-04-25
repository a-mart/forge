/** @vitest-environment jsdom */

import { createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRouteState, type AppRouteState, type ActiveSurface, type ActiveView } from './use-route-state'

let container: HTMLDivElement
let root: Root | null = null

// Mutable capture target — written from effects, not render
const captured: {
  current: {
    routeState: AppRouteState
    activeView: ActiveView
    activeSurface: ActiveSurface
    navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void
  } | null
} = { current: null }

function RouteStateCapture({ pathname, search, navigate, onCapture }: {
  pathname: string
  search: unknown
  navigate: (options: { to: string; search?: Record<string, string | undefined>; replace?: boolean; resetScroll?: boolean }) => void | Promise<void>
  onCapture: (result: NonNullable<typeof captured.current>) => void
}) {
  const result = useRouteState({ pathname, search, navigate })

  useEffect(() => {
    onCapture(result)
  })

  return createElement('div', null, `view=${result.activeView} surface=${result.activeSurface}`)
}

function renderWith(props: {
  pathname: string
  search: unknown
  navigate: ReturnType<typeof vi.fn>
}) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(RouteStateCapture, {
      ...props,
      onCapture: (result) => { captured.current = result },
    }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  captured.current = null
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

describe('useRouteState — settings surface', () => {
  it('defaults settings to builder surface when surface param is absent', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/', search: { view: 'settings' }, navigate })

    expect(captured.current?.routeState).toEqual({ view: 'settings', surface: 'builder' })
    expect(captured.current?.activeView).toBe('settings')
    expect(captured.current?.activeSurface).toBe('builder')
  })

  it('parses collab settings surface', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/', search: { view: 'settings', surface: 'collab' }, navigate })

    expect(captured.current?.routeState).toEqual({ view: 'settings', surface: 'collab' })
    expect(captured.current?.activeView).toBe('settings')
    expect(captured.current?.activeSurface).toBe('collab')
  })

  it('preserves channel as sticky param through collab settings navigation', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'chat', surface: 'collab', channel: 'general', agent: 'mgr1' },
      navigate,
    })

    // Navigate to collab settings from collab chat
    flushSync(() => {
      captured.current?.navigateToRoute({ view: 'settings', surface: 'collab' })
    })

    const call = navigate.mock.calls[0]?.[0]
    expect(call?.search?.view).toBe('settings')
    expect(call?.search?.surface).toBe('collab')
    expect(call?.search?.channel).toBe('general')
    expect(call?.search?.agent).toBe('mgr1')
  })

  it('treats builder and collab settings as different states', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/', search: { view: 'settings' }, navigate })

    expect(captured.current?.routeState).toEqual({ view: 'settings', surface: 'builder' })

    // Navigate to collab settings — should not be treated as a no-op
    flushSync(() => {
      captured.current?.navigateToRoute({ view: 'settings', surface: 'collab' })
    })

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ view: 'settings', surface: 'collab' }),
      }),
    )
  })

  it('emits surface=collab in search for collab settings', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/', search: { view: 'chat', surface: 'builder' }, navigate })

    flushSync(() => {
      captured.current?.navigateToRoute({ view: 'settings', surface: 'collab' })
    })

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ view: 'settings', surface: 'collab' }),
      }),
    )
  })

  it('omits surface from search for builder settings', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/', search: { view: 'chat', surface: 'collab' }, navigate })

    flushSync(() => {
      captured.current?.navigateToRoute({ view: 'settings', surface: 'builder' })
    })

    const call = navigate.mock.calls[0]?.[0]
    expect(call?.search?.view).toBe('settings')
    expect(call?.search?.surface).toBeUndefined()
  })

  it('parses /settings pathname as builder settings', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/settings', search: {}, navigate })

    expect(captured.current?.routeState).toEqual({ view: 'settings', surface: 'builder' })
  })

  it('stats and playwright views remain builder-only surface', () => {
    const navigate = vi.fn()

    renderWith({ pathname: '/', search: { view: 'stats' }, navigate })
    expect(captured.current?.activeSurface).toBe('builder')

    if (root) {
      flushSync(() => root?.unmount())
      root = null
    }

    renderWith({ pathname: '/', search: { view: 'playwright' }, navigate })
    expect(captured.current?.activeSurface).toBe('builder')
  })
})
