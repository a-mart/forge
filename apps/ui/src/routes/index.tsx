/* eslint-disable react-refresh/only-export-components -- TanStack route file exports Route + page utilities */
import { useCallback, useEffect, useMemo } from 'react'
import {
  createFileRoute,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { BuilderSurface } from '@/components/index-page/BuilderSurface'
import { CollabSurface } from '@/components/index-page/CollabSurface'
import {
  DEFAULT_MANAGER_AGENT_ID,
  useRouteState,
  type ActiveSurface,
} from '@/hooks/index-page/use-route-state'
import { useCollaborationSession } from '@/hooks/use-collaboration-session'
import type { AgentDescriptor } from '@forge/protocol'
import { resolveBackendWsUrl } from '@/lib/backend-url'
import { resolveCollaborationWsUrl, getCollabServerUrl } from '@/lib/collaboration-endpoints'
import { isElectron } from '@/lib/electron-bridge'
import { getConfiguredDefaultSurface } from '@/lib/web-runtime-flags'
import { useBackendHealthPoll } from '@/hooks/index-page/use-backend-health-poll'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

export function isCortexDiffViewerSession(agent: AgentDescriptor | null | undefined): boolean {
  return Boolean(
    agent &&
      (agent.profileId === 'cortex' ||
        agent.archetypeId === 'cortex' ||
        agent.sessionPurpose === 'cortex_review'),
  )
}

export { getProjectAgentSuggestions } from '@/hooks/index-page/project-agent-suggestions'

type RouteSearch = {
  view?: string
  agent?: string
  surface?: string
  channel?: string
  playwrightSession?: string
  playwrightMode?: string
  statsTab?: string
}

export function IndexPage() {
  const wsUrl = resolveBackendWsUrl()
  const collabWsUrl = resolveCollaborationWsUrl()
  const navigate = useOptionalNavigate()
  const location = useOptionalLocation()
  const routeSearch = useMemo(() => normalizeRouteSearch(location.search), [location.search])
  const { routeState, activeView, activeSurface, navigateToRoute } = useRouteState({
    pathname: location.pathname,
    search: routeSearch,
    navigate,
  })
  // Keep connection-health-store accurate regardless of which surface is mounted
  useBackendHealthPoll(wsUrl, collabWsUrl)

  const inElectron = isElectron()
  const defaultSurface = getConfiguredDefaultSurface()
  const hasConfiguredCollabServer = Boolean(getCollabServerUrl())
  // Allow Electron to participate in collab if a remote server URL is configured
  const shouldLoadCollabSession = !inElectron || hasConfiguredCollabServer
  const collabSession = useCollaborationSession({
    enabled: shouldLoadCollabSession,
  })
  const isCollabUnauthenticated = shouldLoadCollabSession && collabSession.hasLoaded && collabSession.isCollabEnabled && !collabSession.isAdmin && !collabSession.isMember
  const shouldBlockOnCollabBootstrap = shouldLoadCollabSession && !collabSession.hasLoaded

  // Detect forced collab settings route — do not fall back to builder for these
  const isForcedCollabSettings = activeView === 'settings' && routeState.view === 'settings' && routeState.surface === 'collab'

  const effectiveSurface = useMemo<ActiveSurface>(() => {
    // In Electron, only show collab if a remote server URL is configured.
    // Keep Builder accessible when the remote collab server is configured but the user is not signed in.
    if (inElectron && !hasConfiguredCollabServer) return 'builder'
    if (activeSurface !== 'collab') return 'builder'
    if (shouldBlockOnCollabBootstrap) return 'collab'
    // Forced collab settings must stay on collab even when unauthenticated — renders blocked state
    if (isForcedCollabSettings) return 'collab'
    if (isCollabUnauthenticated && defaultSurface !== 'collab') return 'builder'
    return collabSession.isCollabEnabled ? 'collab' : 'builder'
  }, [activeSurface, collabSession.isCollabEnabled, defaultSurface, hasConfiguredCollabServer, inElectron, isForcedCollabSettings, isCollabUnauthenticated, shouldBlockOnCollabBootstrap])

  useEffect(() => {
    if (shouldBlockOnCollabBootstrap) {
      return
    }

    const stickyAgentId = normalizeStickyAgentId(routeSearch.agent)
    const stickyChannel = normalizeOptionalSearchValue(routeSearch.channel)
    const isMemberOnly = !inElectron && collabSession.hasLoaded && collabSession.isMember && !collabSession.isAdmin

    if (isMemberOnly) {
      // Allow forced collab settings route for members — they see admin-required state
      const isForcedCollabSettings = routeState.view === 'settings' && routeState.surface === 'collab'
      if (isForcedCollabSettings) {
        return
      }

      if (
        activeView !== 'chat' ||
        routeState.view !== 'chat' ||
        routeState.surface !== 'collab' ||
        routeState.agentId !== stickyAgentId ||
        routeState.channel !== stickyChannel
      ) {
        navigateToRoute({
          view: 'chat',
          agentId: stickyAgentId,
          surface: 'collab',
          channel: stickyChannel,
        }, true)
      }
      return
    }

    if (activeView !== 'chat') {
      if (routeSearch.surface) {
        navigateToRoute(routeState, true)
      }
      return
    }

    if (routeState.view !== 'chat') {
      return
    }

    if (routeState.surface !== effectiveSurface) {
      navigateToRoute({
        ...routeState,
        surface: effectiveSurface,
      }, true)
    }
  }, [
    activeView,
    collabSession.hasLoaded,
    collabSession.isAdmin,
    collabSession.isMember,
    effectiveSurface,
    inElectron,
    navigateToRoute,
    routeSearch.agent,
    routeSearch.channel,
    routeSearch.surface,
    routeState,
    shouldBlockOnCollabBootstrap,
  ])

  const stickyChannel = normalizeOptionalSearchValue(routeSearch.channel)
  const collabChannel = routeState.view === 'chat' ? routeState.channel : stickyChannel
  const handleSelectCollabChannel = useCallback((channelId?: string) => {
    const nextAgentId = routeState.view === 'chat'
      ? routeState.agentId
      : normalizeStickyAgentId(routeSearch.agent)

    navigateToRoute({
      view: 'chat',
      agentId: nextAgentId,
      surface: 'collab',
      channel: normalizeOptionalSearchValue(channelId),
    })
  }, [navigateToRoute, routeSearch.agent, routeState])

  if (shouldBlockOnCollabBootstrap) {
    return (
      <main className="h-dvh bg-background text-foreground">
        <div className="flex h-dvh w-full items-center justify-center bg-background text-sm text-muted-foreground">
          Loading…
        </div>
      </main>
    )
  }

  return (
    <main className="h-dvh bg-background text-foreground">
      <div className="flex h-dvh w-full min-w-0 overflow-hidden bg-background">
        {effectiveSurface === 'collab' ? (
          <CollabSurface
            wsUrl={collabWsUrl}
            channel={collabChannel}
            activeView={activeView}
            activeSurface={effectiveSurface}
            isAdmin={collabSession.isAdmin}
            isMember={collabSession.isMember}
            hasLoaded={collabSession.hasLoaded}
            onSelectChannel={handleSelectCollabChannel}
            onSelectSurface={(surface) => {
              if (routeState.view !== 'chat') {
                return
              }

              navigateToRoute({
                ...routeState,
                surface,
              })
            }}
            onOpenSettings={() => {
              navigateToRoute({ view: 'settings', surface: 'collab' })
            }}
            onBackToChat={() => {
              navigateToRoute({
                view: 'chat',
                agentId: normalizeStickyAgentId(routeSearch.agent),
                surface: 'collab',
                channel: stickyChannel,
              })
            }}
          />
        ) : (
          <BuilderSurface
            wsUrl={wsUrl}
            routeState={routeState}
            activeView={activeView}
            navigateToRoute={navigateToRoute}
            collaborationModeSwitch={
              activeView === 'chat' && collabSession.isCollabEnabled && collabSession.isAdmin
                ? {
                    activeSurface: 'builder',
                    onSelectSurface: (surface) => {
                      if (routeState.view !== 'chat') {
                        return
                      }

                      navigateToRoute({
                        ...routeState,
                        surface,
                      })
                    },
                  }
                : undefined
            }
          />
        )}
      </div>
    </main>
  )
}

function normalizeStickyAgentId(agentId?: string): string {
  const trimmedAgentId = agentId?.trim()
  return trimmedAgentId && trimmedAgentId.length > 0 ? trimmedAgentId : DEFAULT_MANAGER_AGENT_ID
}

function normalizeOptionalSearchValue(value?: string): string | undefined {
  const trimmedValue = value?.trim()
  return trimmedValue && trimmedValue.length > 0 ? trimmedValue : undefined
}

function normalizeRouteSearch(search: unknown): RouteSearch {
  return search && typeof search === 'object' ? (search as RouteSearch) : {}
}

function useOptionalLocation(): { pathname: string; search: unknown } {
  try {
    const location = useLocation()
    return {
      pathname: location.pathname,
      search: location.search,
    }
  } catch {
    if (typeof window === 'undefined') {
      return { pathname: '/', search: {} }
    }

    return {
      pathname: window.location.pathname || '/',
      search: parseWindowRouteSearch(window.location.search),
    }
  }
}

type NavigateFn = (options: {
  to: string
  search?: RouteSearch
  replace?: boolean
  resetScroll?: boolean
}) => void | Promise<void>

function useOptionalNavigate(): NavigateFn {
  const fallbackNavigate: NavigateFn = ({ to, search, replace }) => {
    if (typeof window === 'undefined') {
      return
    }

    const params = new URLSearchParams()
    if (search?.view) {
      params.set('view', search.view)
    }
    if (search?.agent) {
      params.set('agent', search.agent)
    }
    if (search?.surface) {
      params.set('surface', search.surface)
    }
    if (search?.channel) {
      params.set('channel', search.channel)
    }
    if (search?.playwrightSession) {
      params.set('playwrightSession', search.playwrightSession)
    }
    if (search?.playwrightMode) {
      params.set('playwrightMode', search.playwrightMode)
    }
    if (search?.statsTab) {
      params.set('statsTab', search.statsTab)
    }

    const query = params.toString()
    const nextUrl = query ? `${to}?${query}` : to

    if (replace) {
      window.history.replaceState(null, '', nextUrl)
    } else {
      window.history.pushState(null, '', nextUrl)
    }
  }

  try {
    const routerNavigate = useNavigate() as unknown as NavigateFn
    return (options) => {
      try {
        return routerNavigate(options)
      } catch {
        return fallbackNavigate(options)
      }
    }
  } catch {
    return fallbackNavigate
  }
}

function parseWindowRouteSearch(search: string): RouteSearch {
  if (!search) {
    return {}
  }

  const params = new URLSearchParams(search)

  return {
    view: params.get('view') ?? undefined,
    agent: params.get('agent') ?? undefined,
    surface: params.get('surface') ?? undefined,
    channel: params.get('channel') ?? undefined,
    playwrightSession: params.get('playwrightSession') ?? undefined,
    playwrightMode: params.get('playwrightMode') ?? undefined,
    statsTab: params.get('statsTab') ?? undefined,
  }
}
