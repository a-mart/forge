import { useCallback, useMemo } from 'react'
import { getConfiguredDefaultSurface, type DefaultSurface } from '@/lib/web-runtime-flags'

// Placeholder used when no agent is specified in the URL.
// The WS client will resolve this to the actual primary manager on connect.
export const DEFAULT_MANAGER_AGENT_ID = '__default__'

export type ActiveView = 'chat' | 'settings' | 'playwright' | 'stats'
export type ActiveSurface = 'builder' | 'collab'
export type PlaywrightViewMode = 'split' | 'focus' | 'tiles'
export type StatsTab = 'overview' | 'tokens'
export type AppRouteState =
  | { view: 'chat'; agentId: string; surface: ActiveSurface; channel?: string }
  | { view: 'settings'; surface: ActiveSurface }
  | { view: 'playwright'; playwrightSession?: string; playwrightMode?: PlaywrightViewMode }
  | { view: 'stats'; statsTab?: StatsTab }

type AppRouteSearch = {
  view?: string
  agent?: string
  surface?: string
  channel?: string
  playwrightSession?: string
  playwrightMode?: string
  statsTab?: string
}

function normalizeAgentId(agentId?: string): string {
  const trimmedAgentId = agentId?.trim()
  return trimmedAgentId && trimmedAgentId.length > 0 ? trimmedAgentId : DEFAULT_MANAGER_AGENT_ID
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function parseSurface(raw: string | undefined, defaultSurface: DefaultSurface = getConfiguredDefaultSurface()): ActiveSurface {
  if (raw === 'collab') return 'collab'
  if (raw === 'builder') return 'builder'
  return defaultSurface
}

export function parseRouteStateFromPathname(
  pathname: string,
  defaultSurface: DefaultSurface = getConfiguredDefaultSurface(),
): AppRouteState {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname

  if (normalizedPath === '/settings') {
    return { view: 'settings', surface: defaultSurface }
  }

  const agentMatch = normalizedPath.match(/^\/agent\/([^/]+)$/)
  if (agentMatch) {
    return {
      view: 'chat',
      agentId: normalizeAgentId(decodePathSegment(agentMatch[1])),
      surface: defaultSurface,
    }
  }

  return {
    view: 'chat',
    agentId: DEFAULT_MANAGER_AGENT_ID,
    surface: defaultSurface,
  }
}

export function parseRouteStateFromLocation(
  pathname: string,
  search: unknown,
  defaultSurface: DefaultSurface = getConfiguredDefaultSurface(),
): AppRouteState {
  const routeSearch = search && typeof search === 'object' ? (search as AppRouteSearch) : {}
  const view = typeof routeSearch.view === 'string' ? routeSearch.view : undefined
  const agentId = typeof routeSearch.agent === 'string' ? routeSearch.agent : undefined
  const surface = typeof routeSearch.surface === 'string' ? routeSearch.surface : undefined
  const channel = typeof routeSearch.channel === 'string' ? routeSearch.channel : undefined

  if (view === 'settings') {
    return { view: 'settings', surface: parseSurface(surface, defaultSurface) }
  }

  if (view === 'stats') {
    const statsTab = typeof routeSearch.statsTab === 'string' && ['overview', 'tokens'].includes(routeSearch.statsTab)
      ? (routeSearch.statsTab as 'overview' | 'tokens')
      : undefined
    return { view: 'stats', statsTab }
  }

  if (view === 'playwright') {
    const playwrightSession = typeof routeSearch.playwrightSession === 'string' ? routeSearch.playwrightSession : undefined
    const playwrightMode = typeof routeSearch.playwrightMode === 'string' && ['split', 'focus', 'tiles'].includes(routeSearch.playwrightMode)
      ? (routeSearch.playwrightMode as PlaywrightViewMode)
      : undefined
    return { view: 'playwright', playwrightSession, playwrightMode }
  }

  if (view === 'chat' || agentId !== undefined || surface !== undefined) {
    const parsedSurface = parseSurface(surface, defaultSurface)
    return {
      view: 'chat',
      agentId: normalizeAgentId(agentId),
      surface: parsedSurface,
      channel: channel || undefined,
    }
  }

  // Fall back to pathname parsing, but still pick up surface/channel from search params
  const pathState = parseRouteStateFromPathname(pathname, defaultSurface)
  if (pathState.view === 'chat') {
    return {
      ...pathState,
      surface: parseSurface(surface, defaultSurface),
      channel: channel || undefined,
    }
  }
  return pathState
}

/**
 * Normalize route state. Builder-only views (stats, playwright)
 * always resolve to builder surface but preserve `channel` so it's sticky
 * when the user returns to collab. Settings preserves its own surface.
 */
function normalizeRouteState(routeState: AppRouteState): AppRouteState {
  if (routeState.view === 'settings') {
    return { view: 'settings', surface: routeState.surface }
  }

  if (routeState.view === 'stats') {
    return { view: 'stats', statsTab: routeState.statsTab }
  }

  if (routeState.view === 'playwright') {
    return { view: 'playwright', playwrightSession: routeState.playwrightSession, playwrightMode: routeState.playwrightMode }
  }

  return {
    view: 'chat',
    agentId: normalizeAgentId(routeState.agentId),
    surface: routeState.surface,
    channel: routeState.channel,
  }
}

export function toRouteSearch(
  routeState: AppRouteState,
  stickyParams?: { agent?: string; channel?: string },
  defaultSurface: DefaultSurface = getConfiguredDefaultSurface(),
): AppRouteSearch {
  if (routeState.view === 'settings') {
    // Preserve sticky agent and channel through non-chat views
    const search: AppRouteSearch = { view: 'settings' }
    if (routeState.surface !== defaultSurface) search.surface = routeState.surface
    if (stickyParams?.agent && stickyParams.agent !== DEFAULT_MANAGER_AGENT_ID) search.agent = stickyParams.agent
    if (stickyParams?.channel) search.channel = stickyParams.channel
    return search
  }

  if (routeState.view === 'stats') {
    const search: AppRouteSearch = { view: 'stats' }
    if (routeState.statsTab && routeState.statsTab !== 'overview') search.statsTab = routeState.statsTab
    if (stickyParams?.agent && stickyParams.agent !== DEFAULT_MANAGER_AGENT_ID) search.agent = stickyParams.agent
    if (stickyParams?.channel) search.channel = stickyParams.channel
    return search
  }

  if (routeState.view === 'playwright') {
    const search: AppRouteSearch = { view: 'playwright' }
    if (routeState.playwrightSession) search.playwrightSession = routeState.playwrightSession
    if (routeState.playwrightMode && routeState.playwrightMode !== 'tiles') search.playwrightMode = routeState.playwrightMode
    if (stickyParams?.agent && stickyParams.agent !== DEFAULT_MANAGER_AGENT_ID) search.agent = stickyParams.agent
    if (stickyParams?.channel) search.channel = stickyParams.channel
    return search
  }

  const search: AppRouteSearch = {}
  const agentId = normalizeAgentId(routeState.agentId)
  if (agentId !== DEFAULT_MANAGER_AGENT_ID) {
    search.agent = agentId
  }

  if (routeState.surface !== defaultSurface) {
    search.surface = routeState.surface
  }

  if (routeState.channel) {
    search.channel = routeState.channel
  }

  return search
}

function routeStatesEqual(left: AppRouteState, right: AppRouteState): boolean {
  if (left.view === 'settings' && right.view === 'settings') {
    return left.surface === right.surface
  }

  if (left.view === 'stats' && right.view === 'stats') {
    return (left.statsTab ?? 'overview') === (right.statsTab ?? 'overview')
  }

  if (left.view === 'playwright' && right.view === 'playwright') {
    return left.playwrightSession === right.playwrightSession && left.playwrightMode === right.playwrightMode
  }

  if (left.view === 'chat' && right.view === 'chat') {
    return left.agentId === right.agentId && left.surface === right.surface && left.channel === right.channel
  }

  return false
}

interface UseRouteStateOptions {
  pathname: string
  search: unknown
  navigate: (options: {
    to: string
    search?: AppRouteSearch
    replace?: boolean
    resetScroll?: boolean
  }) => void | Promise<void>
}

export function useRouteState({
  pathname,
  search,
  navigate,
}: UseRouteStateOptions): {
  routeState: AppRouteState
  activeView: ActiveView
  activeSurface: ActiveSurface
  navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void
} {
  const defaultSurface = getConfiguredDefaultSurface()
  const routeState = useMemo(
    () => parseRouteStateFromLocation(pathname, search, defaultSurface),
    [defaultSurface, pathname, search],
  )

  const activeView: ActiveView = routeState.view

  // surface defaults to builder for non-chat/non-settings views
  const activeSurface: ActiveSurface =
    routeState.view === 'chat' || routeState.view === 'settings'
      ? routeState.surface
      : 'builder'

  // Extract sticky params from the current route state
  const stickyAgent = routeState.view === 'chat' ? routeState.agentId : undefined
  const stickyChannel = routeState.view === 'chat' ? routeState.channel : undefined

  const navigateToRoute = useCallback(
    (nextRouteState: AppRouteState, replace = false) => {
      const normalizedRouteState = normalizeRouteState(nextRouteState)
      if (routeStatesEqual(routeState, normalizedRouteState)) {
        return
      }

      // Compute sticky params: use current agent/channel as fallbacks when
      // navigating to non-chat views so they survive the round-trip
      const currentSearch = (typeof search === 'object' && search !== null ? search : {}) as AppRouteSearch
      const effectiveStickyAgent = normalizedRouteState.view === 'chat'
        ? undefined
        : stickyAgent ?? currentSearch.agent
      const effectiveStickyChannel = normalizedRouteState.view === 'chat'
        ? undefined
        : stickyChannel ?? currentSearch.channel

      void navigate({
        to: '/',
        search: toRouteSearch(
          normalizedRouteState,
          {
            agent: effectiveStickyAgent && effectiveStickyAgent !== DEFAULT_MANAGER_AGENT_ID ? effectiveStickyAgent : undefined,
            channel: effectiveStickyChannel,
          },
          defaultSurface,
        ),
        replace,
        resetScroll: false,
      })
    },
    [defaultSurface, navigate, routeState, search, stickyAgent, stickyChannel],
  )

  return {
    routeState,
    activeView,
    activeSurface,
    navigateToRoute,
  }
}
