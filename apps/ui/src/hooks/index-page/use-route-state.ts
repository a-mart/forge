import { useCallback, useMemo } from 'react'

// Placeholder used when no agent is specified in the URL.
// The WS client will resolve this to the actual primary manager on connect.
export const DEFAULT_MANAGER_AGENT_ID = '__default__'

export type ActiveView = 'chat' | 'settings' | 'playwright'
export type PlaywrightViewMode = 'split' | 'focus' | 'tiles'
export type AppRouteState =
  | { view: 'chat'; agentId: string }
  | { view: 'settings' }
  | { view: 'playwright'; playwrightSession?: string; playwrightMode?: PlaywrightViewMode }

type AppRouteSearch = {
  view?: string
  agent?: string
  playwrightSession?: string
  playwrightMode?: string
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

function parseRouteStateFromPathname(pathname: string): AppRouteState {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname

  if (normalizedPath === '/settings') {
    return { view: 'settings' }
  }

  const agentMatch = normalizedPath.match(/^\/agent\/([^/]+)$/)
  if (agentMatch) {
    return {
      view: 'chat',
      agentId: normalizeAgentId(decodePathSegment(agentMatch[1])),
    }
  }

  return {
    view: 'chat',
    agentId: DEFAULT_MANAGER_AGENT_ID,
  }
}

function parseRouteStateFromLocation(pathname: string, search: unknown): AppRouteState {
  const routeSearch = search && typeof search === 'object' ? (search as AppRouteSearch) : {}
  const view = typeof routeSearch.view === 'string' ? routeSearch.view : undefined
  const agentId = typeof routeSearch.agent === 'string' ? routeSearch.agent : undefined

  if (view === 'settings') {
    return { view: 'settings' }
  }

  if (view === 'playwright') {
    const playwrightSession = typeof routeSearch.playwrightSession === 'string' ? routeSearch.playwrightSession : undefined
    const playwrightMode = typeof routeSearch.playwrightMode === 'string' && ['split', 'focus', 'tiles'].includes(routeSearch.playwrightMode)
      ? (routeSearch.playwrightMode as PlaywrightViewMode)
      : undefined
    return { view: 'playwright', playwrightSession, playwrightMode }
  }

  if (view === 'chat' || agentId !== undefined) {
    return {
      view: 'chat',
      agentId: normalizeAgentId(agentId),
    }
  }

  return parseRouteStateFromPathname(pathname)
}

function normalizeRouteState(routeState: AppRouteState): AppRouteState {
  if (routeState.view === 'settings') {
    return { view: 'settings' }
  }

  if (routeState.view === 'playwright') {
    return { view: 'playwright', playwrightSession: routeState.playwrightSession, playwrightMode: routeState.playwrightMode }
  }

  return {
    view: 'chat',
    agentId: normalizeAgentId(routeState.agentId),
  }
}

function toRouteSearch(routeState: AppRouteState): AppRouteSearch {
  if (routeState.view === 'settings') {
    return { view: 'settings' }
  }

  if (routeState.view === 'playwright') {
    const search: AppRouteSearch = { view: 'playwright' }
    if (routeState.playwrightSession) search.playwrightSession = routeState.playwrightSession
    if (routeState.playwrightMode && routeState.playwrightMode !== 'split') search.playwrightMode = routeState.playwrightMode
    return search
  }

  const agentId = normalizeAgentId(routeState.agentId)
  if (agentId === DEFAULT_MANAGER_AGENT_ID) {
    return {}
  }

  return { agent: agentId }
}

function routeStatesEqual(left: AppRouteState, right: AppRouteState): boolean {
  if (left.view === 'settings' && right.view === 'settings') {
    return true
  }

  if (left.view === 'playwright' && right.view === 'playwright') {
    return left.playwrightSession === right.playwrightSession && left.playwrightMode === right.playwrightMode
  }

  if (left.view === 'chat' && right.view === 'chat') {
    return left.agentId === right.agentId
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
  navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void
} {
  const routeState = useMemo(
    () => parseRouteStateFromLocation(pathname, search),
    [pathname, search],
  )

  const activeView: ActiveView = routeState.view

  const navigateToRoute = useCallback(
    (nextRouteState: AppRouteState, replace = false) => {
      const normalizedRouteState = normalizeRouteState(nextRouteState)
      if (routeStatesEqual(routeState, normalizedRouteState)) {
        return
      }

      void navigate({
        to: '/',
        search: toRouteSearch(normalizedRouteState),
        replace,
        resetScroll: false,
      })
    },
    [navigate, routeState],
  )

  return {
    routeState,
    activeView,
    navigateToRoute,
  }
}
