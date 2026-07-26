import { useCallback, useMemo } from 'react'
import { getConfiguredDefaultSurface, type DefaultSurface } from '@/lib/web-runtime-flags'

// Placeholder used when no agent is specified in the URL.
// The WS client will resolve this to the actual primary manager on connect.
export const DEFAULT_MANAGER_AGENT_ID = '__default__'

export type ActiveView = 'chat' | 'settings' | 'stats' | 'archive'
export type ActiveSurface = 'builder' | 'collab'
export type StatsTab = 'overview' | 'tokens'
export type DeckPanel = 'git' | 'browser' | 'terminal'
export type AppRouteState =
  | { view: 'chat'; agentId: string; surface: ActiveSurface; channel?: string; collab?: string; origin?: string; deckPanel?: DeckPanel }
  | { view: 'settings'; surface: ActiveSurface; settingsTab?: string; settingsProfileId?: string; collabApiBaseUrl?: string; skillImportUrl?: string }
  | { view: 'stats'; statsTab?: StatsTab }
  | { view: 'archive'; surface: ActiveSurface }

type AppRouteSearch = {
  view?: string
  agent?: string
  surface?: string
  channel?: string
  collab?: string
  /** Remote origin (connection id) whose builder surface is active; absent = local. */
  origin?: string
  deckPanel?: string
  statsTab?: string
  settingsTab?: string
  /** Project context for Settings pages that support project-scoped defaults. */
  settingsProfileId?: string
  /** Collab backend API base URL hint for sign-in recovery deep-link. */
  collabApiBaseUrl?: string
  /** Forge skill-share HTTPS URL handed off by web route or Electron deep-link. */
  skillImportUrl?: string
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
  const collab = typeof routeSearch.collab === 'string' ? routeSearch.collab : undefined
  const origin = typeof routeSearch.origin === 'string' ? routeSearch.origin : undefined
  const deckPanel = typeof routeSearch.deckPanel === 'string' && ['git', 'browser', 'terminal'].includes(routeSearch.deckPanel)
    ? (routeSearch.deckPanel as DeckPanel)
    : undefined

  if (view === 'settings') {
    const skillImportUrl = typeof routeSearch.skillImportUrl === 'string' ? routeSearch.skillImportUrl : undefined
    const settingsTab = skillImportUrl ? 'skills' : typeof routeSearch.settingsTab === 'string' ? routeSearch.settingsTab : undefined
    const settingsProfileId = typeof routeSearch.settingsProfileId === 'string'
      ? routeSearch.settingsProfileId.trim() || undefined
      : undefined
    const collabApiBaseUrl = typeof routeSearch.collabApiBaseUrl === 'string' ? routeSearch.collabApiBaseUrl : undefined
    return {
      view: 'settings',
      surface: skillImportUrl ? 'builder' : parseSurface(surface, defaultSurface),
      settingsTab,
      settingsProfileId,
      collabApiBaseUrl,
      skillImportUrl,
    }
  }

  if (view === 'stats') {
    const statsTab = typeof routeSearch.statsTab === 'string' && ['overview', 'tokens'].includes(routeSearch.statsTab)
      ? (routeSearch.statsTab as 'overview' | 'tokens')
      : undefined
    return { view: 'stats', statsTab }
  }

  if (view === 'archive') {
    return { view: 'archive', surface: 'builder' }
  }

  if (view === 'chat' || agentId !== undefined || surface !== undefined) {
    const parsedSurface = parseSurface(surface, defaultSurface)
    return {
      view: 'chat',
      agentId: normalizeAgentId(agentId),
      surface: parsedSurface,
      channel: channel || undefined,
      collab: collab || undefined,
      origin: origin || undefined,
      deckPanel,
    }
  }

  // Fall back to pathname parsing, but still pick up surface/channel/collab from search params
  const pathState = parseRouteStateFromPathname(pathname, defaultSurface)
  if (pathState.view === 'chat') {
    return {
      ...pathState,
      surface: parseSurface(surface, defaultSurface),
      channel: channel || undefined,
      collab: collab || undefined,
      origin: origin || undefined,
      deckPanel,
    }
  }
  return pathState
}

/**
 * Normalize route state. Builder-only views (stats)
 * always resolve to builder surface but preserve `channel` so it's sticky
 * when the user returns to collab. Settings preserves its own surface.
 */
function normalizeRouteState(routeState: AppRouteState): AppRouteState {
  if (routeState.view === 'settings') {
    return {
      view: 'settings',
      surface: routeState.surface,
      settingsTab: routeState.settingsTab,
      settingsProfileId: routeState.settingsProfileId?.trim() || undefined,
      collabApiBaseUrl: routeState.collabApiBaseUrl,
      skillImportUrl: routeState.skillImportUrl,
    }
  }

  if (routeState.view === 'stats') {
    return { view: 'stats', statsTab: routeState.statsTab }
  }

  if (routeState.view === 'archive') {
    return { view: 'archive', surface: 'builder' }
  }

  return {
    view: 'chat',
    agentId: normalizeAgentId(routeState.agentId),
    surface: routeState.surface,
    channel: routeState.channel,
    collab: routeState.collab,
    origin: routeState.origin,
    deckPanel: routeState.deckPanel,
  }
}

export function toRouteSearch(
  routeState: AppRouteState,
  stickyParams?: { agent?: string; channel?: string; collab?: string; origin?: string },
  defaultSurface: DefaultSurface = getConfiguredDefaultSurface(),
): AppRouteSearch {
  if (routeState.view === 'settings') {
    // Preserve sticky agent, channel, and collab through non-chat views
    const search: AppRouteSearch = { view: 'settings' }
    if (routeState.surface !== defaultSurface) search.surface = routeState.surface
    if (routeState.settingsTab) search.settingsTab = routeState.settingsTab
    if (routeState.settingsProfileId) search.settingsProfileId = routeState.settingsProfileId
    if (routeState.collabApiBaseUrl) search.collabApiBaseUrl = routeState.collabApiBaseUrl
    if (routeState.skillImportUrl) search.skillImportUrl = routeState.skillImportUrl
    if (stickyParams?.agent && stickyParams.agent !== DEFAULT_MANAGER_AGENT_ID) search.agent = stickyParams.agent
    if (stickyParams?.channel) search.channel = stickyParams.channel
    if (stickyParams?.collab) search.collab = stickyParams.collab
    if (stickyParams?.origin) search.origin = stickyParams.origin
    return search
  }

  if (routeState.view === 'stats') {
    const search: AppRouteSearch = { view: 'stats' }
    if (routeState.statsTab && routeState.statsTab !== 'overview') search.statsTab = routeState.statsTab
    if (stickyParams?.agent && stickyParams.agent !== DEFAULT_MANAGER_AGENT_ID) search.agent = stickyParams.agent
    if (stickyParams?.channel) search.channel = stickyParams.channel
    if (stickyParams?.collab) search.collab = stickyParams.collab
    if (stickyParams?.origin) search.origin = stickyParams.origin
    return search
  }

  if (routeState.view === 'archive') {
    const search: AppRouteSearch = { view: 'archive' }
    if (stickyParams?.agent && stickyParams.agent !== DEFAULT_MANAGER_AGENT_ID) search.agent = stickyParams.agent
    if (stickyParams?.channel) search.channel = stickyParams.channel
    if (stickyParams?.collab) search.collab = stickyParams.collab
    if (stickyParams?.origin) search.origin = stickyParams.origin
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

  if (routeState.collab) {
    search.collab = routeState.collab
  }

  if (routeState.origin) {
    search.origin = routeState.origin
  }
  if (routeState.deckPanel) {
    search.deckPanel = routeState.deckPanel
  }

  return search
}

function routeStatesEqual(left: AppRouteState, right: AppRouteState): boolean {
  if (left.view === 'settings' && right.view === 'settings') {
    return left.surface === right.surface
      && left.settingsTab === right.settingsTab
      && left.settingsProfileId === right.settingsProfileId
      && left.collabApiBaseUrl === right.collabApiBaseUrl
      && left.skillImportUrl === right.skillImportUrl
  }

  if (left.view === 'stats' && right.view === 'stats') {
    return (left.statsTab ?? 'overview') === (right.statsTab ?? 'overview')
  }

  if (left.view === 'archive' && right.view === 'archive') {
    return left.surface === right.surface
  }

  if (left.view === 'chat' && right.view === 'chat') {
    return left.agentId === right.agentId && left.surface === right.surface && left.channel === right.channel && left.collab === right.collab && left.origin === right.origin && left.deckPanel === right.deckPanel
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
  const stickyCollab = routeState.view === 'chat' ? routeState.collab : undefined
  const stickyOrigin = routeState.view === 'chat' ? routeState.origin : undefined

  const navigateToRoute = useCallback(
    (nextRouteState: AppRouteState, replace = false) => {
      const normalizedRouteState = normalizeRouteState(nextRouteState)
      const currentSearch = (typeof search === 'object' && search !== null ? search : {}) as AppRouteSearch
      const shouldStripStaleArchiveSurface = normalizedRouteState.view === 'archive' && typeof currentSearch.surface === 'string'
      if (routeStatesEqual(routeState, normalizedRouteState) && !shouldStripStaleArchiveSurface) {
        return
      }

      // Compute sticky params: use current agent/channel/collab as fallbacks when
      // navigating to non-chat views so they survive the round-trip
      const effectiveStickyAgent = normalizedRouteState.view === 'chat'
        ? undefined
        : stickyAgent ?? currentSearch.agent
      const effectiveStickyChannel = normalizedRouteState.view === 'chat'
        ? undefined
        : stickyChannel ?? currentSearch.channel
      const effectiveStickyCollab = normalizedRouteState.view === 'chat'
        ? undefined
        : stickyCollab ?? currentSearch.collab
      const effectiveStickyOrigin = normalizedRouteState.view === 'chat'
        ? undefined
        : stickyOrigin ?? currentSearch.origin

      void navigate({
        to: '/',
        search: toRouteSearch(
          normalizedRouteState,
          {
            agent: effectiveStickyAgent && effectiveStickyAgent !== DEFAULT_MANAGER_AGENT_ID ? effectiveStickyAgent : undefined,
            channel: effectiveStickyChannel,
            collab: effectiveStickyCollab,
            origin: effectiveStickyOrigin,
          },
          defaultSurface,
        ),
        replace,
        resetScroll: false,
      })
    },
    [defaultSurface, navigate, routeState, search, stickyAgent, stickyChannel, stickyCollab, stickyOrigin],
  )

  return {
    routeState,
    activeView,
    activeSurface,
    navigateToRoute,
  }
}
