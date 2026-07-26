/* eslint-disable react-refresh/only-export-components -- TanStack route file exports Route + page utilities */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createFileRoute,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { BuilderSurface } from '@/components/index-page/BuilderSurface'
import { BrowserPopoutSurface } from '@/components/browser/BrowserPopoutSurface'
import { CollabSurface } from '@/components/index-page/CollabSurface'
import { CollaborationInlineLoginDialog } from '@/components/index-page/CollaborationInlineLoginDialog'
import {
  DEFAULT_MANAGER_AGENT_ID,
  useRouteState,
  type ActiveSurface,
} from '@/hooks/index-page/use-route-state'
import { useCollaborationSession } from '@/hooks/use-collaboration-session'
import type { AgentDescriptor } from '@forge/protocol'
import { resolveBackendWsUrl } from '@/lib/backend-url'
import { resolveCollaborationWsUrl } from '@/lib/collaboration-endpoints'
import { getCollaborationConnectionOptions, getDefaultConnectionIdFromTargets, subscribeToRegistryChanges, type CollaborationEndpointTarget } from '@/lib/collaboration-connections'
import { forgeOriginManager } from '@/lib/origin-store/forge-origin-manager'
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
  collab?: string
  origin?: string
  deckPanel?: string
  statsTab?: string
  settingsTab?: string
  collabApiBaseUrl?: string
  skillImportUrl?: string
}

export function IndexPage() {
  return typeof window !== 'undefined' && window.electronBridge?.windowRole === 'managed-browser-popout'
    ? <BrowserPopoutSurface />
    : <MainIndexPage />
}

function MainIndexPage() {
  const wsUrl = resolveBackendWsUrl()
  const collabWsUrl = resolveCollaborationWsUrl()

  // Wave R: manage remote origins (probe → version gate → auth → connect) for
  // registry connections with remote projects enabled. Module-level manager;
  // idempotent start.
  useEffect(() => {
    forgeOriginManager.start()
  }, [])

  // Track registry mutations so collabTargets recomputes when connections
  // are added, removed, renamed, or edited (not just when default wsUrl changes).
  const [registryRevision, setRegistryRevision] = useState(0)
  useEffect(() => {
    return subscribeToRegistryChanges(() => {
      setRegistryRevision((r) => r + 1)
    })
  }, [])

  // Resolve all visible/enabled collaboration connection targets.
  // Depends on both the default wsUrl (for same-origin derivation) and
  // the registry revision (for add/remove/rename reactivity).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const collabTargets = useMemo(() => getCollaborationConnectionOptions(), [collabWsUrl, registryRevision])
  const navigate = useOptionalNavigate()
  const location = useOptionalLocation()
  const routeSearch = useMemo(() => normalizeRouteSearch(location.search), [location.search])
  const { routeState, activeView, activeSurface, navigateToRoute } = useRouteState({
    pathname: location.pathname,
    search: routeSearch,
    navigate,
  })
  // Keep connection-health-store accurate regardless of which surface is mounted.
  // Ping all configured collab backends — aggregate health drives the ModeSwitch dot.
  const collabWsUrls = useMemo(() => collabTargets.map((t) => t.wsUrl), [collabTargets])
  useBackendHealthPoll(wsUrl, collabWsUrls)

  const inElectron = isElectron()
  const defaultSurface = getConfiguredDefaultSurface()

  // Resolve the target connection for auth/gating from the route `collab`
  // param (or the first/default target).  This ensures `hasRemoteCollabServer`
  // and `collabSession` reflect the connection the user is actually viewing,
  // not an arbitrary default.
  const routeCollabParam = normalizeOptionalSearchValue(routeSearch.collab)
  const resolvedCollabTarget = useMemo<CollaborationEndpointTarget | null>(() => {
    if (routeCollabParam) {
      const match = collabTargets.find((t) => t.connectionId === routeCollabParam)
      if (match) return match
    }
    // Fallback: canonical default from registry's lastActiveConnectionId,
    // not insertion-order targets[0].
    const defaultId = getDefaultConnectionIdFromTargets(collabTargets)
    if (defaultId) {
      return collabTargets.find((t) => t.connectionId === defaultId) ?? null
    }
    return null
  }, [routeCollabParam, collabTargets])

  // True when the resolved target is a genuinely different origin
  // from the local Forge backend.  Also true when ANY configured target
  // is remote (for Electron gating: allow collab if any remote exists).
  const hasRemoteCollabServer = useMemo(() => {
    if (resolvedCollabTarget?.isRemote) return true
    return collabTargets.some((t) => t.isRemote)
  }, [resolvedCollabTarget, collabTargets])

  // Allow Electron to participate in collab only if a genuinely remote server is configured
  const shouldLoadCollabSession = !inElectron || hasRemoteCollabServer
  const collabSession = useCollaborationSession({
    enabled: shouldLoadCollabSession,
    apiBaseUrl: resolvedCollabTarget?.apiBaseUrl,
  })
  const isCollabUnauthenticated = shouldLoadCollabSession && collabSession.hasLoaded && collabSession.isCollabEnabled && !collabSession.isAdmin && !collabSession.isMember
  // A hosted collaboration server can serve Builder directly from the local
  // origin. It has no remote-origin ID, but its filesystem remains server-side.
  const isDirectCollaborationServerBuilder =
    !resolvedCollabTarget?.isRemote &&
    collabSession.isCollabEnabled &&
    collabSession.capabilities?.collab === true
  // A collaboration server serves Builder directly at its own origin. Gate
  // that local Builder transport on the explicit `/me` probe so an expired or
  // missing session does not turn into an unactionable WebSocket retry loop.
  const requiresInlineBuilderSignIn = isCollabUnauthenticated && !resolvedCollabTarget?.isRemote
  const shouldBlockOnCollabBootstrap = shouldLoadCollabSession && !collabSession.hasLoaded

  // Detect forced collab settings route — do not fall back to builder for these
  const isForcedCollabSettings = activeView === 'settings' && routeState.view === 'settings' && routeState.surface === 'collab'

  const effectiveSurface = useMemo<ActiveSurface>(() => {
    // In Electron, only show collab if a remote server URL is configured.
    // Keep Builder accessible when the remote collab server is configured but the user is not signed in.
    if (inElectron && !hasRemoteCollabServer) return 'builder'
    if (activeSurface !== 'collab') return 'builder'
    if (shouldBlockOnCollabBootstrap) return 'collab'
    // Forced collab settings must stay on collab even when unauthenticated — renders blocked state
    if (isForcedCollabSettings) return 'collab'
    if (isCollabUnauthenticated && !hasRemoteCollabServer && defaultSurface !== 'collab') return 'builder'
    return (collabSession.isCollabEnabled || hasRemoteCollabServer) ? 'collab' : 'builder'
  }, [activeSurface, collabSession.isCollabEnabled, defaultSurface, hasRemoteCollabServer, inElectron, isForcedCollabSettings, isCollabUnauthenticated, shouldBlockOnCollabBootstrap])

  useEffect(() => {
    if (shouldBlockOnCollabBootstrap) {
      return
    }

    const stickyAgentId = normalizeStickyAgentId(routeSearch.agent)
    const stickyChannel = normalizeOptionalSearchValue(routeSearch.channel)
    const stickyCollabConn = normalizeOptionalSearchValue(routeSearch.collab)
    // Members browsing the HOSTED (same-origin) UI stay on the collab
    // surface (D5 — browser-direct builder access is deferred). A member
    // session on a REMOTE connection means this is someone's local client
    // connecting out (Wave R D4): they keep their local builder surface,
    // where remote origins render as sidebar sections.
    const isMemberOnly =
      !inElectron &&
      collabSession.hasLoaded &&
      collabSession.isMember &&
      !collabSession.isAdmin &&
      !resolvedCollabTarget?.isRemote

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
          collab: stickyCollabConn,
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
    resolvedCollabTarget,
    routeSearch.agent,
    routeSearch.channel,
    routeSearch.collab,
    routeSearch.surface,
    routeState,
    shouldBlockOnCollabBootstrap,
  ])

  const stickyChannel = normalizeOptionalSearchValue(routeSearch.channel)
  const stickyCollab = normalizeOptionalSearchValue(routeSearch.collab)
  const collabChannel = routeState.view === 'chat' ? routeState.channel : stickyChannel
  const collabConnectionId = routeState.view === 'chat' ? routeState.collab : stickyCollab
  const handleSelectCollabChannel = useCallback((channelId?: string, connectionId?: string) => {
    const nextAgentId = routeState.view === 'chat'
      ? routeState.agentId
      : normalizeStickyAgentId(routeSearch.agent)

    // When connectionId is undefined the caller intends to clear the explicit
    // collab param (e.g. stale-param normalization).  Never fall back to
    // `collabConnectionId` here — that may itself be stale/deleted.
    navigateToRoute({
      view: 'chat',
      agentId: nextAgentId,
      surface: 'collab',
      channel: normalizeOptionalSearchValue(channelId),
      collab: normalizeOptionalSearchValue(connectionId),
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
            targets={collabTargets}
            wsUrl={collabWsUrl}
            channel={collabChannel}
            collab={collabConnectionId}
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
                collab: stickyCollab,
              })
            }}
            onSignIn={(apiBaseUrl) => {
              navigateToRoute({ view: 'settings', surface: 'builder', settingsTab: 'collaboration', collabApiBaseUrl: apiBaseUrl })
            }}
          />
        ) : requiresInlineBuilderSignIn ? (
          <CollaborationInlineLoginDialog
            apiBaseUrl={resolvedCollabTarget?.apiBaseUrl ?? window.location.origin}
            onAuthenticated={() => {
              // Reloading recreates the local Builder WebSocket with the new
              // HttpOnly cookie while retaining the requested URL/route.
              window.location.reload()
            }}
          />
        ) : (
          <BuilderSurface
            wsUrl={wsUrl}
            routeState={routeState}
            activeView={activeView}
            navigateToRoute={navigateToRoute}
            directServerDirectoryBrowser={isDirectCollaborationServerBuilder
              ? { canCreateDirectory: collabSession.capabilities?.createDirectory === true }
              : undefined}
            repositoryCloneAvailable={!isDirectCollaborationServerBuilder}
            collaborationModeSwitch={
              activeView === 'chat' && ((collabSession.isCollabEnabled && collabSession.isAdmin) || hasRemoteCollabServer)
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
    if (search?.collab) {
      params.set('collab', search.collab)
    }
    if (search?.origin) {
      params.set('origin', search.origin)
    }
    if (search?.deckPanel) {
      params.set('deckPanel', search.deckPanel)
    }
    if (search?.statsTab) {
      params.set('statsTab', search.statsTab)
    }
    if (search?.settingsTab) {
      params.set('settingsTab', search.settingsTab)
    }
    if (search?.collabApiBaseUrl) {
      params.set('collabApiBaseUrl', search.collabApiBaseUrl)
    }
    if (search?.skillImportUrl) {
      params.set('skillImportUrl', search.skillImportUrl)
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

/** @internal Exported for testing only. */
export function parseWindowRouteSearch(search: string): RouteSearch {
  if (!search) {
    return {}
  }

  const params = new URLSearchParams(search)

  return {
    view: params.get('view') ?? undefined,
    agent: params.get('agent') ?? undefined,
    surface: params.get('surface') ?? undefined,
    channel: params.get('channel') ?? undefined,
    collab: params.get('collab') ?? undefined,
    origin: params.get('origin') ?? undefined,
    deckPanel: params.get('deckPanel') ?? undefined,
    statsTab: params.get('statsTab') ?? undefined,
    settingsTab: params.get('settingsTab') ?? undefined,
    collabApiBaseUrl: params.get('collabApiBaseUrl') ?? undefined,
    skillImportUrl: params.get('skillImportUrl') ?? undefined,
  }
}
