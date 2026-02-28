import { useCallback, useMemo } from 'react'

export const DEFAULT_MANAGER_AGENT_ID = 'opus-manager'

export type ActiveView = 'chat' | 'settings'
export type AppRouteState =
  | { view: 'chat'; agentId: string }
  | { view: 'settings' }

type AppRouteSearch = {
  view?: string
  agent?: string
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

  return {
    view: 'chat',
    agentId: normalizeAgentId(routeState.agentId),
  }
}

function toRouteSearch(routeState: AppRouteState): AppRouteSearch {
  if (routeState.view === 'settings') {
    return { view: 'settings' }
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
