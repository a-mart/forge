/** @vitest-environment jsdom */

import { createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseRouteStateFromLocation,
  parseRouteStateFromPathname,
  toRouteSearch,
  useRouteState,
  type AppRouteState,
  type ActiveSurface,
  type ActiveView,
} from './use-route-state'

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

describe('useRouteState — archive view', () => {
  it('parses and serializes archive route state as builder-only with sticky chat params', () => {
    const parsed = parseRouteStateFromLocation('/', { view: 'archive', surface: 'collab' }, 'collab')

    expect(parsed).toEqual({ view: 'archive', surface: 'builder' })
    expect(toRouteSearch(parsed, { agent: 'session-a' }, 'collab')).toEqual({
      view: 'archive',
      agent: 'session-a',
    })
  })

  it('exposes archive as builder surface even when default surface is collab', () => {
    const parsed = parseRouteStateFromLocation('/', { view: 'archive' }, 'collab')
    expect(parsed).toEqual({ view: 'archive', surface: 'builder' })

    const navigate = vi.fn()
    renderWith({ pathname: '/', search: { view: 'archive', surface: 'collab' }, navigate })

    expect(captured.current?.routeState).toEqual({ view: 'archive', surface: 'builder' })
    expect(captured.current?.activeView).toBe('archive')
    expect(captured.current?.activeSurface).toBe('builder')
  })

  it('normalizes stale archive surface search params even when parsed route state is unchanged', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/', search: { view: 'archive', surface: 'collab', agent: 'session-a' }, navigate })

    captured.current?.navigateToRoute({ view: 'archive', surface: 'builder' }, true)

    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { view: 'archive', agent: 'session-a' },
      replace: true,
      resetScroll: false,
    })
  })
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

  it('preserves an exact contextual project without changing the sticky task', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { agent: 'session-with-draft', surface: 'builder' },
      navigate,
    })

    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'settings',
        surface: 'builder',
        settingsTab: 'secrets',
        settingsProfileId: 'project-beta',
      })
    })

    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: {
        view: 'settings',
        settingsTab: 'secrets',
        settingsProfileId: 'project-beta',
        agent: 'session-with-draft',
      },
      replace: false,
      resetScroll: false,
    })
    expect(parseRouteStateFromLocation('/', {
      view: 'settings',
      settingsTab: 'secrets',
      settingsProfileId: 'project-beta',
      agent: 'session-with-draft',
    })).toEqual({
      view: 'settings',
      surface: 'builder',
      settingsTab: 'secrets',
      settingsProfileId: 'project-beta',
    })
  })

  it('treats different contextual projects as different Settings states', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: {
        view: 'settings',
        settingsTab: 'secrets',
        settingsProfileId: 'project-alpha',
        agent: 'session-with-draft',
      },
      navigate,
    })

    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'settings',
        surface: 'builder',
        settingsTab: 'secrets',
        settingsProfileId: 'project-beta',
      })
    })

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          settingsProfileId: 'project-beta',
          agent: 'session-with-draft',
        }),
      }),
    )
  })

  it('routes skill import URLs to the skills settings tab on the Builder surface', () => {
    const parsed = parseRouteStateFromLocation('/', {
      view: 'settings',
      surface: 'collab',
      settingsTab: 'models',
      skillImportUrl: 'https://forgeskills.radops.ai/s/token',
    }, 'collab')

    expect(parsed).toEqual({
      view: 'settings',
      surface: 'builder',
      settingsTab: 'skills',
      skillImportUrl: 'https://forgeskills.radops.ai/s/token',
    })
    expect(toRouteSearch(parsed, undefined, 'builder')).toEqual({
      view: 'settings',
      settingsTab: 'skills',
      skillImportUrl: 'https://forgeskills.radops.ai/s/token',
    })
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

  it('stats view remains builder-only surface', () => {
    const navigate = vi.fn()

    renderWith({ pathname: '/', search: { view: 'stats' }, navigate })
    expect(captured.current?.activeSurface).toBe('builder')
  })
})

describe('default surface helpers', () => {
  it('parses chat and settings routes against a collab default surface', () => {
    expect(parseRouteStateFromLocation('/', {}, 'collab')).toEqual({
      view: 'chat',
      agentId: '__default__',
      surface: 'collab',
    })

    expect(parseRouteStateFromPathname('/settings', 'collab')).toEqual({
      view: 'settings',
      surface: 'collab',
    })
  })

  it('omits the surface search param when the route uses the configured default surface', () => {
    expect(toRouteSearch({ view: 'chat', agentId: '__default__', surface: 'collab' }, undefined, 'collab')).toEqual({})

    expect(toRouteSearch({ view: 'settings', surface: 'builder' }, undefined, 'collab')).toEqual({
      view: 'settings',
      surface: 'builder',
    })
  })
})

describe('useRouteState — collab connection param', () => {
  it('parses collab from search params', () => {
    const result = parseRouteStateFromLocation(
      '/',
      { view: 'chat', surface: 'collab', channel: 'general', collab: 'conn_abc' },
      'builder',
    )

    expect(result).toEqual({
      view: 'chat',
      agentId: '__default__',
      surface: 'collab',
      channel: 'general',
      collab: 'conn_abc',
    })
  })

  it('omits collab when not present', () => {
    const result = parseRouteStateFromLocation(
      '/',
      { view: 'chat', surface: 'collab', channel: 'general' },
      'builder',
    )

    expect(result).toEqual({
      view: 'chat',
      agentId: '__default__',
      surface: 'collab',
      channel: 'general',
    })
  })

  it('serialises collab into search params for chat view', () => {
    const search = toRouteSearch(
      { view: 'chat', agentId: '__default__', surface: 'collab', channel: 'general', collab: 'conn_abc' },
      undefined,
      'builder',
    )

    expect(search).toEqual({
      surface: 'collab',
      channel: 'general',
      collab: 'conn_abc',
    })
  })

  it('omits collab from search when absent', () => {
    const search = toRouteSearch(
      { view: 'chat', agentId: '__default__', surface: 'collab', channel: 'general' },
      undefined,
      'builder',
    )

    expect(search.collab).toBeUndefined()
  })

  it('preserves collab as sticky param through settings navigation', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'chat', surface: 'collab', channel: 'general', collab: 'conn_abc', agent: 'mgr1' },
      navigate,
    })

    // Navigate to collab settings
    flushSync(() => {
      captured.current?.navigateToRoute({ view: 'settings', surface: 'collab' })
    })

    const call = navigate.mock.calls[0]?.[0]
    expect(call?.search?.view).toBe('settings')
    expect(call?.search?.collab).toBe('conn_abc')
    expect(call?.search?.channel).toBe('general')
    expect(call?.search?.agent).toBe('mgr1')
  })

  it('preserves collab as sticky param through stats navigation', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'chat', surface: 'collab', channel: 'general', collab: 'conn_abc' },
      navigate,
    })

    flushSync(() => {
      captured.current?.navigateToRoute({ view: 'stats' })
    })

    const call = navigate.mock.calls[0]?.[0]
    expect(call?.search?.collab).toBe('conn_abc')
    expect(call?.search?.channel).toBe('general')
  })



  it('treats chat routes with different collab as distinct states', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'chat', surface: 'collab', collab: 'conn_a' },
      navigate,
    })

    // Navigate to same channel on different connection — should NOT be a no-op
    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'chat',
        agentId: '__default__',
        surface: 'collab',
        collab: 'conn_b',
      })
    })

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ collab: 'conn_b' }),
      }),
    )
  })

  it('does not emit collab param when switching from collab to builder chat', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'chat', surface: 'collab', collab: 'conn_a' },
      navigate,
    })

    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'chat',
        agentId: '__default__',
        surface: 'builder',
      })
    })

    const call = navigate.mock.calls[0]?.[0]
    expect(call?.search?.collab).toBeUndefined()
  })

  it('normalises empty collab to undefined', () => {
    const result = parseRouteStateFromLocation(
      '/',
      { view: 'chat', surface: 'collab', collab: '' },
      'builder',
    )

    expect(result).toEqual({
      view: 'chat',
      agentId: '__default__',
      surface: 'collab',
    })
    expect((result as any).collab).toBeUndefined()
  })
})

describe('useRouteState — settingsTab deep-link', () => {
  it('parses settingsTab from search params', () => {
    const result = parseRouteStateFromLocation(
      '/',
      { view: 'settings', surface: 'builder', settingsTab: 'collaboration' },
      'builder',
    )

    expect(result).toEqual({
      view: 'settings',
      surface: 'builder',
      settingsTab: 'collaboration',
    })
  })

  it('omits settingsTab when not present', () => {
    const result = parseRouteStateFromLocation(
      '/',
      { view: 'settings', surface: 'builder' },
      'builder',
    )

    expect(result).toEqual({
      view: 'settings',
      surface: 'builder',
      settingsTab: undefined,
    })
  })

  it('serialises settingsTab into search params', () => {
    const search = toRouteSearch(
      { view: 'settings', surface: 'builder', settingsTab: 'collaboration' },
      undefined,
      'builder',
    )

    expect(search).toEqual({
      view: 'settings',
      settingsTab: 'collaboration',
    })
  })

  it('omits settingsTab from search when absent', () => {
    const search = toRouteSearch(
      { view: 'settings', surface: 'builder' },
      undefined,
      'builder',
    )

    expect(search).toEqual({ view: 'settings' })
    expect(search.settingsTab).toBeUndefined()
  })

  it('treats settings routes with different settingsTab as distinct', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'settings', surface: 'builder' },
      navigate,
    })

    // Navigate to the same surface but with a settingsTab — should NOT be a no-op
    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'settings',
        surface: 'builder',
        settingsTab: 'collaboration',
      })
    })

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          view: 'settings',
          settingsTab: 'collaboration',
        }),
      }),
    )
  })
})

describe('useRouteState — collabApiBaseUrl deep-link', () => {
  it('parses collabApiBaseUrl from search params', () => {
    const result = parseRouteStateFromLocation(
      '/',
      { view: 'settings', surface: 'builder', settingsTab: 'collaboration', collabApiBaseUrl: 'https://b.example.com/' },
      'builder',
    )

    expect(result).toEqual({
      view: 'settings',
      surface: 'builder',
      settingsTab: 'collaboration',
      collabApiBaseUrl: 'https://b.example.com/',
    })
  })

  it('omits collabApiBaseUrl when not present', () => {
    const result = parseRouteStateFromLocation(
      '/',
      { view: 'settings', surface: 'builder', settingsTab: 'collaboration' },
      'builder',
    )

    expect(result).toEqual({
      view: 'settings',
      surface: 'builder',
      settingsTab: 'collaboration',
      collabApiBaseUrl: undefined,
    })
  })

  it('serialises collabApiBaseUrl into search params', () => {
    const search = toRouteSearch(
      { view: 'settings', surface: 'builder', settingsTab: 'collaboration', collabApiBaseUrl: 'https://b.example.com/' },
      undefined,
      'builder',
    )

    expect(search).toEqual({
      view: 'settings',
      settingsTab: 'collaboration',
      collabApiBaseUrl: 'https://b.example.com/',
    })
  })

  it('omits collabApiBaseUrl from search when absent', () => {
    const search = toRouteSearch(
      { view: 'settings', surface: 'builder', settingsTab: 'collaboration' },
      undefined,
      'builder',
    )

    expect(search.collabApiBaseUrl).toBeUndefined()
  })

  it('treats settings routes with different collabApiBaseUrl as distinct (not a no-op)', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'settings', surface: 'builder', settingsTab: 'collaboration' },
      navigate,
    })

    // Navigate to the same tab but with a different collabApiBaseUrl — must NOT be a no-op
    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'settings',
        surface: 'builder',
        settingsTab: 'collaboration',
        collabApiBaseUrl: 'https://b.example.com/',
      })
    })

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          view: 'settings',
          settingsTab: 'collaboration',
          collabApiBaseUrl: 'https://b.example.com/',
        }),
      }),
    )
  })

  it('treats navigation to same collabApiBaseUrl as no-op', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'settings', surface: 'builder', settingsTab: 'collaboration', collabApiBaseUrl: 'https://same.example.com/' },
      navigate,
    })

    // Navigate to the identical state — should be a no-op
    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'settings',
        surface: 'builder',
        settingsTab: 'collaboration',
        collabApiBaseUrl: 'https://same.example.com/',
      })
    })

    expect(navigate).not.toHaveBeenCalled()
  })

  it('treats settings routes differing only by collabApiBaseUrl as distinct', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'settings', surface: 'builder', settingsTab: 'collaboration', collabApiBaseUrl: 'https://a.example.com/' },
      navigate,
    })

    // Navigate to the same tab/surface but a different collabApiBaseUrl — must NOT be a no-op
    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'settings',
        surface: 'builder',
        settingsTab: 'collaboration',
        collabApiBaseUrl: 'https://b.example.com/',
      })
    })

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          view: 'settings',
          settingsTab: 'collaboration',
          collabApiBaseUrl: 'https://b.example.com/',
        }),
      }),
    )
  })

  it('round-trips collabApiBaseUrl through parse → serialise → parse', () => {
    const url = 'https://custom.example.com/api'
    const parsed = parseRouteStateFromLocation(
      '/',
      { view: 'settings', surface: 'builder', settingsTab: 'collaboration', collabApiBaseUrl: url },
      'builder',
    )

    expect(parsed).toMatchObject({ view: 'settings', collabApiBaseUrl: url })

    const search = toRouteSearch(parsed, undefined, 'builder')
    expect(search.collabApiBaseUrl).toBe(url)

    // Re-parse the serialised search back into route state
    const reparsed = parseRouteStateFromLocation('/', search, 'builder')
    expect(reparsed).toMatchObject({ view: 'settings', collabApiBaseUrl: url })
  })

  it('treats collabApiBaseUrl present vs absent as distinct', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'settings', surface: 'builder', settingsTab: 'collaboration', collabApiBaseUrl: 'https://x.example.com/' },
      navigate,
    })

    // Navigate to the same tab/surface but WITHOUT collabApiBaseUrl
    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'settings',
        surface: 'builder',
        settingsTab: 'collaboration',
      })
    })

    expect(navigate).toHaveBeenCalled()
    const call = navigate.mock.calls[0]?.[0]
    expect(call?.search?.collabApiBaseUrl).toBeUndefined()
  })
})
