import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from 'react'
import { reportBuilderConnected } from '@/lib/connection-health-store'
import { AgentSidebarConnected } from '@/components/chat/AgentSidebarConnected'
import { WorkGraphWorkerHighlightProvider } from '@/components/chat/WorkGraphWorkerHighlight'
import { ArtifactsSidebar } from '@/components/chat/ArtifactsSidebar'
import { ActivityRail } from '@/components/index-page/ActivityRail'
import { shouldRevealBrowserPanel } from '@/components/index-page/activity-rail-workspace'
import { BrowserAutomationHost, type BrowserAutomationHostHandle } from '@/components/browser/BrowserAutomationHost'
import { type BrowserWorkspaceCommandPort } from '@/components/browser/BrowserPanel'
import { projectRuntimeBrowserTabState } from '@/components/browser/browser-runtime-state'
import { BuilderBrowserPanel } from '@/components/index-page/BuilderBrowserPanel'
import type { ManagedBrowserWorkspaceMode } from '@/lib/electron-bridge'
import { ArchiveView } from '@/components/index-page/ArchiveView'
import { type MessageSourceView } from '@/components/chat/ChatHeader'
import { SettingsPanel } from '@/components/chat/SettingsDialog'
import { type MessageInputHandle } from '@/components/chat/MessageInput'
import type {
  SecureGrantInput,
  SecurePrivateFulfillmentInput,
  SecureSessionAvailability,
  SecureSessionPickerConfig,
  SecureSessionRequestConfig,
} from '@/components/chat/secure-session/types'
import { isSessionModelPickerEligible } from '@/components/chat/message-input/session-model-picker-eligibility'
import { isSecureSessionRuntimeSupported } from '@/components/index-page/secure-session-runtime-eligibility'
import { shouldShowSecureSessionPicker } from '@/components/index-page/secure-session-picker-visibility'
import { type MessageListHandle } from '@/components/chat/MessageList'
import { ChatSidePanels } from '@/components/index-page/ChatSidePanels'
import { ChatWorkspace } from '@/components/index-page/ChatWorkspace'
import { FileBrowserPanel } from '@/components/file-browser/FileBrowserPanel'
import { FileBrowserSidebar } from '@/components/file-browser/FileBrowserSidebar'
import { FileDirtyConfirmDialog } from '@/components/file-browser/FileDirtyConfirmDialog'
import { FILE_BROWSER_INLINE_EDITING_ENABLED } from '@/components/file-browser/file-editor-feature-gates'
import type { useFileEditorCoordinator } from '@/components/file-browser/use-file-editor-coordinator'
import { DiffViewerContent } from '@/components/diff-viewer/DiffViewerDialog'
import {
  remoteUpdateSnapshotMatchesTarget,
  type RemoteUpdateAwarenessMutationTarget,
} from '@/components/diff-viewer/remote-update-awareness-mutation'
import { GlobalDialogs } from '@/components/index-page/GlobalDialogs'
import { CortexV2OnboardingModal } from '@/components/settings/CortexV2OnboardingModal'
import { StatsPage } from '@/components/index-page/StatsPage'
import { shouldEnableCodexMention } from '@/components/index-page/codex-mention-utils'
import { defaultMessageSourceViewForAgentRole } from '@/components/index-page/message-source-view'
import { resolveWorkerFetchManagerId } from '@/lib/agent-hierarchy'
import { hasProjectManagers } from '@/lib/onboarding-ui'
import {
  DEFAULT_MANAGER_AGENT_ID,
  type ActiveSurface,
  type ActiveView,
  type AppRouteState,
  type DeckPanel,
  type StatsTab,
} from '@/hooks/index-page/use-route-state'
import { resolveStreamDeckNavigationRoute } from '@/hooks/index-page/stream-deck-navigation'
import { fetchModelCacheVisualizationEnabled } from '@/components/settings/model-cache-visualization-api'
import { activateRemoteUpdateAwarenessProject } from '@/components/settings/remote-update-awareness-api'
import { getActiveLocalRemoteUpdateSnapshot } from '@/components/index-page/remote-update-awareness'
import { createLocalBuilderSidebarOrderApi } from '@/lib/builder-sidebar-order-api'
import {
  applySecureSessionProjectDefaults,
  approveSecureSshHostTrustRequest,
  denySecureAccessRequest,
  dismissSecureSshHostTrustRequest,
  fetchSecureSessionCatalog,
  fetchSecureSessionSnapshot,
  fulfillSecureAccessRequestPrivately,
  grantSecureSessionLease,
  grantSecureSessionLeases,
  isPrivateSecureFulfillmentAvailable,
  isSecureControlAvailable,
  revokeSecureSessionLease,
  resolveSecureSecretsForProfile,
  secureSessionUiErrorMessage,
  SecureSessionUiError,
  shouldRefreshAfterProjectDefaultsApplyError,
  startSecureSession,
  stopSecureSession,
  toSecureSecretOptions,
  toSecureSessionSnapshotView,
  unlockLocalProjectDefaultsIfNeeded,
} from '@/lib/secure-sessions-api'
import type { SecureSecretsCatalog } from '@/lib/secure-secrets-api'
import {
  claimSecureBrowserPairing,
  createSecureBrowserPairingRequest,
  fetchSecureBrowserControlStatus,
} from '@/lib/secure-browser-control-api'
import { hydrateSessionWorkers } from './worker-hydration'
import {
  reconcileSecureBatchGrantFailure,
  secureGrantMatchesSnapshot,
  shouldRefreshSecureRequestAfterError,
} from './secure-batch-grant-reconciliation'
import {
  LOCAL_ORIGIN_ID,
  forgeOriginManager,
  originRegistry,
  useOriginMeta,
  useOriginSlice,
  useOriginSnapshot,
  type OriginId,
} from '@/lib/origin-store'
import { getCollaborationConnectionOptions, resolveCollaborationTarget } from '@/lib/collaboration-connections'
import type { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import { buildModelCacheHeaderSummary } from '@/components/chat/model-cache'
import { isPiGenerationThroughputEligible } from '@/lib/generation-throughput-eligibility'
import { deriveMissingPendingChoiceIds } from '@/lib/ws-client/utils'
import { useOriginConnection } from '@/hooks/index-page/use-origin-connection'
import { useManagerActions } from '@/hooks/index-page/use-manager-actions'
import { useActiveAgent } from '@/hooks/index-page/use-active-agent'
import { useWorkspacePanels } from '@/hooks/index-page/use-workspace-panels'
import { useTranscriptController } from '@/hooks/index-page/use-transcript-controller'
import { useSessionActions } from '@/hooks/index-page/use-session-actions'
import { useFileDrop } from '@/hooks/index-page/use-file-drop'
import {
  getProjectAgentSuggestions,
  shouldLoadExternalProjectAgentDirectory,
} from '@/hooks/index-page/project-agent-suggestions'
import { useSlashCommands } from '@/hooks/index-page/use-slash-commands'
import { useOnboardingState } from '@/hooks/use-onboarding-state'
import { useDynamicFavicon } from '@/hooks/use-dynamic-favicon'
import { useTerminalPanel } from '@/hooks/useTerminalPanel'
import {
  SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  type AgentDescriptor,
  type ProjectAgentExternalDirectoryEntry,
  type RemoteUpdateAwarenessProjectSnapshot,
  type SecureBrowserControlStatus,
  type SecureSessionSnapshot,
} from '@forge/protocol'

type FileEditorCoordinator = ReturnType<typeof useFileEditorCoordinator>

const selectLocalConnected = (s: ManagerWsState): boolean => s.connected

function isCortexDiffViewerSession(agent: AgentDescriptor | null | undefined): boolean {
  return Boolean(
    agent &&
      (agent.profileId === 'cortex' ||
        agent.archetypeId === 'cortex' ||
        agent.sessionPurpose === 'cortex_review'),
  )
}

type BuilderNavigationState =
  | {
      view: 'chat'
      agentId: string
      /** Target origin; omitted = stay on the currently active origin. */
      origin?: OriginId
      deckPanel?: DeckPanel
    }
  | Extract<AppRouteState, { view: 'settings' }>
  | { view: 'stats'; statsTab?: StatsTab }
  | { view: 'archive'; surface: ActiveSurface }

interface BuilderSurfaceProps {
  wsUrl: string
  routeState: AppRouteState
  activeView: ActiveView
  navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void
  /** Same-origin hosted collaboration Builder still browses server directories. */
  directServerDirectoryBrowser?: { canCreateDirectory: boolean }
  /**
   * Explicit capability for Clone repository / Repositories settings.
   * False on direct collaboration-server Builder shells.
   */
  repositoryCloneAvailable?: boolean
  collaborationModeSwitch?: {
    activeSurface: ActiveSurface
    onSelectSurface: (surface: ActiveSurface) => void
  }
}

export function BuilderSurface({
  wsUrl: localWsUrl,
  routeState,
  activeView,
  navigateToRoute: navigateToOuterRoute,
  directServerDirectoryBrowser,
  repositoryCloneAvailable,
  collaborationModeSwitch,
}: BuilderSurfaceProps) {
  // This API is intentionally pinned to the local Builder URL. It must never
  // derive from the active (possibly remote) origin.
  const builderSidebarOrderApi = useMemo(
    () => createLocalBuilderSidebarOrderApi(localWsUrl),
    [localWsUrl],
  )

  // Wave R: the route's `origin` selects which origin's state/client feed the
  // chat surface. Absent = the local origin. Non-chat views always render
  // against local.
  const activeOriginId: OriginId =
    routeState.view === 'chat' && routeState.origin ? routeState.origin : LOCAL_ORIGIN_ID
  const isRemoteOriginActive = activeOriginId !== LOCAL_ORIGIN_ID
  // Identity behind the active origin's connection (null on local): author
  // chips render only for authors other than this user (SPEC §5.5).
  const activeOriginMeta = useOriginMeta(activeOriginId)
  const usesServerDirectoryBrowser = isRemoteOriginActive || Boolean(directServerDirectoryBrowser)
  const cloneRepositoryEnabled =
    repositoryCloneAvailable !== false && !isRemoteOriginActive && !usesServerDirectoryBrowser
  const activeOriginCurrentUserId = isRemoteOriginActive
    ? activeOriginMeta?.currentUser?.userId ?? null
    : null
  // The ACTIVE origin's backend URL. Every project-scoped surface below
  // (files/git/terminals/attachments/audit/model availability) derives its
  // HTTP endpoints from this — instance-local surfaces (settings, stats,
  // onboarding, cortex, sidebar usage) explicitly use `localWsUrl`.
  const wsUrl = useMemo(() => {
    if (!isRemoteOriginActive) return localWsUrl
    const store = originRegistry.getOrigin(activeOriginId)
    if (store) return store.wsUrl
    const target = getCollaborationConnectionOptions().find(
      (candidate) => candidate.connectionId === activeOriginId,
    )
    return target?.wsUrl ?? localWsUrl
  }, [activeOriginId, isRemoteOriginActive, localWsUrl])

  const navigateToRoute = useCallback((nextRouteState: BuilderNavigationState, replace = false) => {
    if (nextRouteState.view === 'chat') {
      // Internal chat navigations stay on the active origin unless the caller
      // targets one explicitly (sidebar cross-origin selects).
      const resolvedOrigin = nextRouteState.origin ?? activeOriginId
      navigateToOuterRoute({
        view: 'chat',
        agentId: nextRouteState.agentId,
        surface: 'builder',
        origin: resolvedOrigin === LOCAL_ORIGIN_ID ? undefined : resolvedOrigin,
        deckPanel: nextRouteState.deckPanel,
      }, replace)
      return
    }

    navigateToOuterRoute(nextRouteState, replace)
  }, [activeOriginId, navigateToOuterRoute])

  // Shell-level refs shared across the extracted controllers.  Keeping these at
  // the shell (not inside a hook) is what breaks the apparent ordering cycle
  // between active-agent derivation and the workspace panels: the route-sync
  // effect reads `fileEditorCoordinatorRef.current` lazily, and the shell keeps
  // the ref current during render once the panels hook has created the
  // coordinator — so every effect (regardless of which hook registered it) sees
  // the live coordinator.
  const messageInputRef = useRef<MessageInputHandle | null>(null)
  const messageListRef = useRef<MessageListHandle | null>(null)
  const previousAgentsByIdRef = useRef<Map<string, AgentDescriptor>>(new Map())
  const fileEditorCoordinatorRef = useRef<FileEditorCoordinator | null>(null)
  const archiveHydrationRequestedRef = useRef(false)
  const browserHostRef = useRef<BrowserAutomationHostHandle | null>(null)
  const handledBrowserRevealRef = useRef<string | null>(null)
  const handledDeckPanelRef = useRef<string | null>(null)
  const handledStreamDeckNavigationRef = useRef<string | null>(null)
  const [browserWorkspaceMode, setBrowserWorkspaceMode] = useState<ManagedBrowserWorkspaceMode>(
    window.electronBridge?.browserWorkspace?.capability.popoutAvailable ? 'docked' : 'unavailable',
  )
  const browserCommandPort = useMemo<BrowserWorkspaceCommandPort>(() => {
    const host = (): BrowserAutomationHostHandle => {
      if (!browserHostRef.current) throw new Error('Browser controller is unavailable')
      return browserHostRef.current
    }
    return {
      open: (autoOpenAttemptKey) => host().open(autoOpenAttemptKey), activate: (tabId) => host().activate(tabId), close: (tabId) => host().close(tabId),
      resize: (tabId, viewport) => host().resize(tabId, viewport), navigate: (tabId, url) => host().navigate(tabId, url),
      history: async (tabId, direction) => host().history(tabId, direction), reload: async (tabId, hard) => host().reload(tabId, hard),
      zoom: async (tabId, factor) => host().setZoom(tabId, factor), capture: (tabId) => host().captureScreenshot(tabId),
      startRecording: (tabId) => host().startRecording(tabId), stopRecording: (tabId, recordingId) => host().stopRecording(tabId, recordingId),
      reveal: (tabId) => host().reveal(tabId), takeControl: (tabId) => host().takeControl(tabId),
      popOut: () => host().popOut(), dock: () => host().dock(),
    }
  }, [])

  const { clientRef, httpClientRef, state, setState } = useOriginConnection(activeOriginId, localWsUrl)
  const localState = useOriginSnapshot(LOCAL_ORIGIN_ID)
  const localClientRef = useRef<ManagerWsClient | null>(null)
  const localClient = originRegistry.getOrigin(LOCAL_ORIGIN_ID)?.getClient() ?? null
  // Keep local sidebar action handlers bound to the current local-origin client
  // during render so callbacks created below do not observe a stale ref when the
  // active origin changes.
  localClientRef.current = localClient
  const setLocalState = useCallback((update: SetStateAction<ManagerWsState>) => {
    const target = originRegistry.getOrigin(LOCAL_ORIGIN_ID)
    if (!target) return
    const previous = target.getSnapshot()
    const next = typeof update === 'function'
      ? (update as (prev: ManagerWsState) => ManagerWsState)(previous)
      : update
    if (next !== previous) target.ingest({ type: 'snapshot', state: next })
  }, [])
  const handleBrowserRuntimeTabStateChanged = useCallback((tab: Parameters<typeof projectRuntimeBrowserTabState>[1]) => {
    setLocalState((previous) => projectRuntimeBrowserTabState(previous, tab))
  }, [setLocalState])

  // Sync builder WS health to the module-level store so ModeSwitch can
  // display the builder connection dot even from the collab surface. Always
  // reflects the LOCAL origin — remote origin health lives in origin meta.
  const localConnected = useOriginSlice(LOCAL_ORIGIN_ID, selectLocalConnected, {
    selectorKey: 'builder.localConnected',
  })
  useEffect(() => {
    reportBuilderConnected(localConnected)
  }, [localConnected])

  useEffect(() => {
    let cancelled = false
    // Route through the origin's target-aware HTTP client (requirement 9)
    // rather than a raw wsUrl, so remote origins carry their credentials.
    void fetchModelCacheVisualizationEnabled(httpClientRef.current ?? wsUrl)
      .then((enabled) => {
        if (!cancelled) {
          clientRef.current?.applyLoadedModelCacheVisualizationSetting(enabled)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [clientRef, httpClientRef, wsUrl])

  useEffect(() => {
    if (activeView !== 'archive') {
      archiveHydrationRequestedRef.current = false
      return
    }
    if (!state.connected || archiveHydrationRequestedRef.current) return
    archiveHydrationRequestedRef.current = true
    clientRef.current?.hydrateArchiveLastUsed().catch((error) => {
      console.warn('Failed to hydrate archive last-used metadata', error)
      archiveHydrationRequestedRef.current = false
    })
  }, [activeView, clientRef, state.connected])

  const {
    onboardingState,
    isMutating: isMutatingOnboardingState,
    error: onboardingError,
    savePreferences: saveOnboardingPreferences,
    skip: skipOnboarding,
  } = useOnboardingState(localWsUrl)

  const [messageSourceView, setMessageSourceView] = useState<MessageSourceView>('web')
  const [detailedAllView, setDetailedAllView] = useState(false)
  const [planExpanded, setPlanExpanded] = useState(false)
  const [externalProjectAgentEntries, setExternalProjectAgentEntries] = useState<ProjectAgentExternalDirectoryEntry[]>([])
  const [secureCatalog, setSecureCatalog] = useState<SecureSecretsCatalog | null>(null)
  const [secureCatalogLoading, setSecureCatalogLoading] = useState(false)
  const [secureCatalogUnavailable, setSecureCatalogUnavailable] = useState(false)
  const [secureRuntimeUnsupported, setSecureRuntimeUnsupported] = useState(false)
  const [secureBrowserControl, setSecureBrowserControl] =
    useState<SecureBrowserControlStatus | null>(null)

  // ── Active-agent derivation + route→subscription sync ──
  const {
    activeAgentId,
    activeAgent,
    activeManagerId,
    activeManagerAgent,
    isActiveManager,
    terminalSessionAgentId,
    activeAgentStatus,
    activeAgentProfileName,
    activeAgentSessionLabel,
    activeAgentLabel,
  } = useActiveAgent({
    state,
    routeState,
    navigateToRoute,
    clientRef,
    fileEditorCoordinatorRef,
    previousAgentsByIdRef,
  })

  const totalUnreadCount = useMemo(() => {
    if (!state.unreadCounts) return 0
    return Object.entries(state.unreadCounts).reduce((sum, [agentId, count]) => {
      if (agentId === activeAgentId) return sum
      return sum + count
    }, 0)
  }, [state.unreadCounts, activeAgentId])

  // Reset Detailed All when leaving All view
  useEffect(() => {
    if (messageSourceView !== 'all') setDetailedAllView(false)
  }, [messageSourceView])

  // Reset local chat chrome when switching active agent/session
  useEffect(() => {
    setDetailedAllView(false)
    setPlanExpanded(false)
    setMessageSourceView(defaultMessageSourceViewForAgentRole(activeAgent?.role))
  }, [activeAgentId, activeAgent?.role])

  useEffect(() => {
    clientRef.current?.setConversationView(messageSourceView)
  }, [clientRef, messageSourceView])

  // Derive effective detailed state for hook consumption
  const effectiveDetailedAllView = isActiveManager && messageSourceView === 'all' && detailedAllView

  const planSnapshot = isActiveManager && activeAgentId && state.planSnapshotLoadingSessionId !== activeAgentId
    ? state.planSnapshots[activeAgentId] ?? null
    : null
  const goalSnapshot = isActiveManager && activeAgentId && state.goalSnapshotLoadingSessionId !== activeAgentId
    ? state.goalSnapshots[activeAgentId] ?? null
    : null
  const secureAuthorityAgentId = activeAgent?.role === 'worker'
    ? activeAgent.managerId
    : activeAgentId
  const secureSessionSnapshot =
    secureAuthorityAgentId
    && state.secureSessionSnapshotLoadingSessionId !== activeAgentId
      ? state.secureSessionSnapshots[secureAuthorityAgentId] ?? null
      : null

  useEffect(() => {
    if (isRemoteOriginActive || !state.connected) {
      setSecureCatalog(null)
      setSecureCatalogLoading(false)
      setSecureCatalogUnavailable(false)
      return
    }
    const apiClient = httpClientRef.current
    if (!apiClient) return

    let cancelled = false
    setSecureCatalogLoading(true)
    setSecureCatalogUnavailable(false)
    void fetchSecureSessionCatalog(apiClient)
      .then((catalog) => {
        if (cancelled) return
        setSecureCatalog(catalog)
        setSecureCatalogUnavailable(false)
      })
      .catch(() => {
        if (cancelled) return
        setSecureCatalog(null)
        setSecureCatalogUnavailable(true)
      })
      .finally(() => {
        if (!cancelled) setSecureCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    activeAgentId,
    activeOriginId,
    httpClientRef,
    isRemoteOriginActive,
    state.connected,
    state.secureSecretCatalogRevision,
  ])

  const refreshSecureBrowserControl = useCallback(async () => {
    if (isRemoteOriginActive || !state.connected) {
      setSecureBrowserControl(null)
      return null
    }
    const apiClient = httpClientRef.current
    if (!apiClient) return null
    try {
      const status = await fetchSecureBrowserControlStatus(apiClient)
      setSecureBrowserControl(status)
      return status
    } catch {
      setSecureBrowserControl(null)
      return null
    }
  }, [httpClientRef, isRemoteOriginActive, state.connected])

  useEffect(() => {
    void refreshSecureBrowserControl()
  }, [refreshSecureBrowserControl])

  useEffect(() => {
    if (
      isRemoteOriginActive
      || !state.connected
      || !activeAgentId
      || !isSecureSessionRuntimeSupported(activeAgent)
    ) {
      setSecureRuntimeUnsupported(false)
      return
    }
    const apiClient = httpClientRef.current
    const client = clientRef.current
    if (!apiClient || !client) return

    let cancelled = false
    const requestedSessionAgentId = activeAgentId
    setSecureRuntimeUnsupported(false)
    void fetchSecureSessionSnapshot(apiClient, requestedSessionAgentId)
      .then((snapshot) => {
        if (!cancelled && clientRef.current === client) {
          client.applySecureSessionSnapshot(snapshot)
        }
      })
      .catch((error) => {
        if (cancelled) return
        setSecureRuntimeUnsupported(
          error instanceof SecureSessionUiError
          && error.code === 'SECURE_SESSION_UNSUPPORTED',
        )
      })
    return () => {
      cancelled = true
    }
  }, [
    activeAgentId,
    activeAgent,
    activeOriginId,
    clientRef,
    httpClientRef,
    isRemoteOriginActive,
    state.connected,
  ])

  const secureSessionAvailability = useMemo<SecureSessionAvailability>(() => {
    if (isRemoteOriginActive) {
      return {
        state: 'remote_origin',
        reason: 'Secure Sessions are available only in the local Builder.',
      }
    }
    if (!isSecureSessionRuntimeSupported(activeAgent) || secureRuntimeUnsupported) {
      return { state: 'unsupported_runtime' }
    }
    if (secureCatalogUnavailable) {
      return { state: 'source_unavailable' }
    }
    return { state: 'available' }
  }, [
    activeAgent,
    isRemoteOriginActive,
    secureCatalogUnavailable,
    secureRuntimeUnsupported,
  ])

  const secureSecretOptions = useMemo(
    () => toSecureSecretOptions(resolveSecureSecretsForProfile(
      secureCatalog?.secrets ?? [],
      secureSessionSnapshot?.profileId ?? activeAgent?.profileId,
    )),
    [
      activeAgent?.profileId,
      secureCatalog?.secrets,
      secureSessionSnapshot?.profileId,
    ],
  )
  const secureSessionSnapshotView = useMemo(
    () => secureSessionSnapshot
      ? toSecureSessionSnapshotView(secureSessionSnapshot)
      : null,
    [secureSessionSnapshot],
  )
  const securePendingRequestViews = useMemo(() => {
    return secureSessionSnapshot
      ? toSecureSessionSnapshotView(secureSessionSnapshot).pendingRequests
      : []
  }, [secureSessionSnapshot])
  const securePendingSshTrustRequestViews = useMemo(() => {
    return secureSessionSnapshot
      ? toSecureSessionSnapshotView(secureSessionSnapshot).pendingSshTrustRequests ?? []
      : []
  }, [secureSessionSnapshot])

  const modelCacheHeaderSummary =
    state.modelCacheVisualizationEnabled && isActiveManager
      ? buildModelCacheHeaderSummary({
          enabled: true,
          observations: state.modelCacheObservations,
        })
      : null

  const activeAgentRole = activeAgent?.role ?? null
  const activeAgentProfileId = activeAgent?.profileId ?? null
  const activeAgentProfile = useMemo(
    () => state.profiles.find((profile) => profile.profileId === activeAgentProfileId) ?? null,
    [activeAgentProfileId, state.profiles],
  )
  const activeAgentProfileType = activeAgentProfile?.profileType ?? null
  const activeProjectId = activeAgent?.profileId ?? activeManagerAgent?.profileId ?? null
  const activeAgentIsCortex = isCortexDiffViewerSession(activeAgent)
  const remoteUpdateSnapshot = getActiveLocalRemoteUpdateSnapshot(
    state.remoteUpdateAwarenessSnapshot,
    activeProjectId,
    isRemoteOriginActive,
    activeAgentIsCortex,
  )
  const handleRemoteUpdateSnapshotChange = useCallback((
    snapshot: RemoteUpdateAwarenessProjectSnapshot,
    expectedTarget?: RemoteUpdateAwarenessMutationTarget,
  ) => {
    setState((current) => {
      if (expectedTarget) {
        const currentProjection = getActiveLocalRemoteUpdateSnapshot(
          current.remoteUpdateAwarenessSnapshot,
          activeProjectId,
          isRemoteOriginActive,
          activeAgentIsCortex,
        )
        if (!remoteUpdateSnapshotMatchesTarget(currentProjection, expectedTarget)) {
          return current
        }
      }
      return { ...current, remoteUpdateAwarenessSnapshot: snapshot }
    })
  }, [activeAgentIsCortex, activeProjectId, isRemoteOriginActive, setState])

  useEffect(() => {
    if (isRemoteOriginActive || !state.connected || !activeProjectId) return
    void activateRemoteUpdateAwarenessProject(localWsUrl, activeProjectId).catch(() => undefined)
  }, [activeProjectId, isRemoteOriginActive, localWsUrl, state.connected])

  useEffect(() => {
    if (!state.connected || !shouldLoadExternalProjectAgentDirectory({
      activeAgentRole,
      activeProfileId: activeAgentProfileId,
      activeProfileType: activeAgentProfileType,
    })) {
      setExternalProjectAgentEntries([])
      return
    }

    const client = clientRef.current
    if (!client) {
      setExternalProjectAgentEntries([])
      return
    }

    let cancelled = false
    void client.getProjectAgentExternalDirectory()
      .then((result) => {
        if (!cancelled) {
          setExternalProjectAgentEntries(result.entries)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExternalProjectAgentEntries([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    activeAgentProfileId,
    activeAgentProfileType,
    activeAgentRole,
    clientRef,
    state.connected,
    state.promptChangeKey,
  ])

  // Project agents for @mention autocomplete — only when the active agent is a manager session
  const projectAgentSuggestions = useMemo(
    () => getProjectAgentSuggestions(activeAgent, state.agents, externalProjectAgentEntries),
    [activeAgent, externalProjectAgentEntries, state.agents],
  )

  const diffViewerSessionAgent = useMemo(() => {
    if (!activeAgent) {
      return null
    }

    return activeAgent.role === 'manager' ? activeAgent : activeManagerAgent ?? activeAgent
  }, [activeAgent, activeManagerAgent])

  const isDiffViewerCortexSession = isCortexDiffViewerSession(diffViewerSessionAgent)

  const terminalPanel = useTerminalPanel({
    wsUrl,
    sessionAgentId: terminalSessionAgentId,
    sessionCwd: activeManagerAgent?.cwd ?? activeAgent?.cwd ?? null,
    terminals: state.terminals,
    enabled: activeView === 'chat',
    onError: (message) => {
      setState((previous) => ({
        ...previous,
        lastError: message,
      }))
    },
  })

  const isCortexSession = activeAgent?.archetypeId === 'cortex'

  // ── Workspace panels (file browser / diff viewer / artifacts / activity rail) ──
  const panels = useWorkspacePanels({
    wsUrl,
    activeAgentId,
    activeAgent,
    activeManagerAgent,
    terminalSessionAgentId,
    terminalPanel,
    terminalCount: state.terminals.length,
    isCortexSession,
    activeContextKey: `${activeOriginId}:${activeProjectId ?? 'none'}:${activeAgentId ?? 'none'}:${isDiffViewerCortexSession ? 'cortex' : 'workspace'}`,
    clientRef,
    messageInputRef,
    navigateToRoute,
  })

  // Keep the shell-level coordinator ref current for the active-agent route-sync
  // effect.  Assigned during render (after panels creates the coordinator) so it
  // is visible to every effect on the next commit, matching the original
  // in-component ordering where the ref always held the live coordinator.
  fileEditorCoordinatorRef.current = panels.fileEditorCoordinator

  const browserSessionAgentId = !isRemoteOriginActive ? activeManagerAgent?.agentId ?? null : null
  const browserProfileId = !isRemoteOriginActive
    ? activeManagerAgent?.profileId ?? activeManagerAgent?.agentId ?? null
    : null
  const browserSessionSnapshot = browserSessionAgentId
    ? localState.browserSessions[browserSessionAgentId] ?? null
    : null

  useEffect(() => {
    const request = localState.streamDeckNavigationRequest
    if (!request || handledStreamDeckNavigationRef.current === request.requestId) return
    if (window.electronBridge?.windowRole !== 'main') return
    handledStreamDeckNavigationRef.current = request.requestId
    void window.electronBridge.focusMainWindow?.()
    const nextRoute = resolveStreamDeckNavigationRoute(request, activeAgentId)
    if (nextRoute) navigateToOuterRoute(nextRoute)
  }, [
    activeAgentId,
    localState.streamDeckNavigationRequest,
    navigateToOuterRoute,
  ])

  useEffect(() => {
    if (routeState.view !== 'chat' || !routeState.deckPanel || !activeAgentId) return
    if (routeState.deckPanel === 'terminal' && !terminalSessionAgentId) return
    const streamDeckRequest = localState.streamDeckNavigationRequest
    const streamDeckRequestId =
      streamDeckRequest?.sessionAgentId === activeAgentId &&
      streamDeckRequest.surface === routeState.deckPanel
        ? streamDeckRequest.requestId
        : 'route'
    const requestKey = `${activeAgentId}:${routeState.deckPanel}:${streamDeckRequestId}`
    if (handledDeckPanelRef.current === requestKey) return
    handledDeckPanelRef.current = requestKey

    if (routeState.deckPanel === 'git') {
      panels.handleOpenDiffViewerInline()
    } else if (routeState.deckPanel === 'browser') {
      panels.handleOpenBrowserFromReveal()
      if (browserWorkspaceMode === 'popped-out' || browserWorkspaceMode === 'opening') {
        void browserHostRef.current?.bringToFront()
      }
    } else {
      if (state.terminals.length === 0) {
        void terminalPanel.createTerminal()
      } else {
        terminalPanel.expandPanel()
      }
    }
  }, [
    activeAgentId,
    browserWorkspaceMode,
    panels,
    localState.streamDeckNavigationRequest,
    routeState,
    state.terminals.length,
    terminalSessionAgentId,
    terminalPanel,
  ])

  useEffect(() => {
    const request = localState.browserPanelRevealRequest
    if (!shouldRevealBrowserPanel({
      electronHostAvailable: Boolean(window.electronBridge?.browserAutomation),
      selectedSessionAgentId: browserSessionAgentId,
      request,
      currentHostGeneration: localState.browserHost.hostGeneration,
    })) return
    const key = `${request!.hostGeneration}:${request!.sequence}:${request!.tabId}`
    if (handledBrowserRevealRef.current === key) return
    handledBrowserRevealRef.current = key
    panels.handleOpenBrowserFromReveal()
    if (browserWorkspaceMode === 'popped-out' || browserWorkspaceMode === 'opening') {
      void browserHostRef.current?.bringToFront()
    }
  }, [browserSessionAgentId, browserWorkspaceMode, localState.browserHost.hostGeneration, localState.browserPanelRevealRequest, panels])

  // Workers belonging to the active manager session (for pill bar)
  const sessionWorkers = useMemo(() => {
    if (!activeManagerId) return []
    return state.agents.filter(
      (a) => a.role === 'worker' && a.managerId === activeManagerId,
    )
  }, [activeManagerId, state.agents])

  // Track the active manager's workerCount so the effect re-fires when workers spawn/despawn
  const activeManagerWorkerCount = useMemo(() => {
    if (!activeManagerId) return 0
    const manager = state.agents.find(
      (a) => a.role === 'manager' && a.agentId === activeManagerId,
    )
    return manager?.workerCount ?? 0
  }, [activeManagerId, state.agents])

  // Resolve worker-fetch target from actual active agent context only.
  const workerFetchManagerId = useMemo(
    () => resolveWorkerFetchManagerId(activeAgent),
    [activeAgent],
  )

  useEffect(() => {
    if (!workerFetchManagerId) return
    hydrateSessionWorkers(activeOriginId, workerFetchManagerId)
  }, [activeOriginId, workerFetchManagerId, activeManagerWorkerCount])

  // Resolve parent manager label for the worker back-bar
  const parentManagerLabel = useMemo(() => {
    if (activeAgent?.role !== 'worker' || !activeAgent.managerId) return null
    const manager = state.agents.find((a) => a.agentId === activeAgent.managerId)
    if (!manager) return activeAgent.managerId
    if (manager.profileId && manager.sessionLabel) {
      const profile = state.profiles.find((p) => p.profileId === manager.profileId)
      const profileName = profile?.displayName ?? manager.profileId
      return `${profileName} › ${manager.sessionLabel}`
    }
    return manager.displayName ?? manager.agentId
  }, [activeAgent, state.agents, state.profiles])
  const workerSecureStatus = useMemo(() => {
    if (activeAgent?.role !== 'worker' || !secureSessionSnapshotView) return undefined
    const activeGrantCount = secureSessionSnapshotView.leases.filter(
      (lease) => lease.status === 'active',
    ).length
    const active =
      secureSessionSnapshotView.executionMode === 'secure'
      && secureSessionSnapshotView.environmentStatus === 'ready'
    return {
      active,
      label: secureSessionSnapshotView.outputState === 'quarantined'
        ? 'Protected output redacted'
        : active
          ? `Team Secure Bash · ${activeGrantCount} ${activeGrantCount === 1 ? 'grant' : 'grants'}`
          : `Secure Bash ${secureSessionSnapshotView.environmentStatus}`,
    }
  }, [activeAgent?.role, secureSessionSnapshotView])

  // For settings, only show profile-level managers (default sessions or legacy managers without profileId)
  const settingsManagers = useMemo(() => {
    const defaultSessionIds = new Set(state.profiles.map((p) => p.defaultSessionAgentId))
    return state.agents.filter((agent) => {
      if (agent.role !== 'manager') return false
      if (state.profiles.length > 0) {
        return defaultSessionIds.has(agent.agentId) || !agent.profileId
      }
      return true
    })
  }, [state.agents, state.profiles])

  useDynamicFavicon({
    agents: state.agents,
    statuses: state.statuses,
  })

  // ── Transcript / search / feedback / pins / context window / pending response ──
  const transcript = useTranscriptController({
    state,
    activeView,
    activeAgent,
    activeAgentId,
    activeAgentStatus,
    messageSourceView,
    effectiveDetailedAllView,
    messageListRef,
  })
  const { feedback } = transcript
  const isLoading = transcript.isLoading
  const conversationActionsEnabled = transcript.isConversationInteractive

  const missingPendingChoiceIds = useMemo(
    () => deriveMissingPendingChoiceIds(state.pendingChoiceIds, state.messages, activeAgentId),
    [activeAgentId, state.messages, state.pendingChoiceIds],
  )
  const hasActivePendingChoice = state.pendingChoiceIds.size > 0
  const canStopAllAgents =
    isActiveManager &&
    (activeAgentStatus === 'idle' || activeAgentStatus === 'streaming')

  const autoCompactionInProgress = useMemo(() => {
    if (!activeAgentId) return false
    return state.statuses[activeAgentId]?.contextRecoveryInProgress === true
  }, [activeAgentId, state.statuses])

  const hasCreatedProjectManager = useMemo(() => hasProjectManagers(state.agents), [state.agents])
  // The sidebar always renders the local tree, even while a remote origin is
  // selected. Bind its context-menu actions to the local origin so local
  // sessions/projects keep their normal menu without misrouting commands to the
  // remote client.
  const localActiveAgentId = activeOriginId === LOCAL_ORIGIN_ID ? activeAgentId : null
  const localActiveAgent = localActiveAgentId
    ? localState.agents.find((agent) => agent.agentId === localActiveAgentId) ?? null
    : null
  const localIsActiveManager = Boolean(localActiveAgent && localActiveAgent.role === 'manager')

  const shouldShowWelcomeForm =
    routeState.view === 'chat' &&
    activeOriginId === LOCAL_ORIGIN_ID &&
    !hasCreatedProjectManager &&
    onboardingState?.status === 'pending'
  const shouldShowCreateManagerState =
    routeState.view === 'chat' &&
    activeOriginId === LOCAL_ORIGIN_ID &&
    !hasCreatedProjectManager &&
    Boolean(onboardingState && onboardingState.status !== 'pending')

  const { slashCommands } = useSlashCommands({ wsUrl, activeView })

  const {
    isCreateManagerDialogOpen,
    newManagerName,
    newManagerCwd,
    newManagerModelSelection,
    newManagerReasoningLevel,
    scaffoldForgeResources,
    createManagerError,
    browseError,
    isCreatingManager,
    isValidatingDirectory,
    isPickingDirectory,
    handleNewManagerNameChange,
    handleNewManagerCwdChange,
    handleNewManagerModelSelectionChange,
    handleNewManagerReasoningLevelChange,
    handleScaffoldForgeResourcesChange,
    handleOpenCreateManagerDialog,
    handleCreateManagerDialogOpenChange,
    handleBrowseDirectory,
    handleCreateManager,
    createProjectSourceMode,
    repositoryUrl,
    repositoryFolder,
    repositoryBasePath,
    cloneStage,
    clonePercent,
    cloneCancellable,
    handleCreateProjectSourceModeChange,
    handleRepositoryUrlChange,
    handleRepositoryFolderChange,
    handleRepositoryBasePathChange,
    handleBrowseRepositoryBasePath,
    handleCancelClone,
    isCancellingClone,
    isCompactingManager,
    handleCompactManager,
    isSmartCompactingManager,
    handleSmartCompactManager,
    isStoppingAllAgents,
    handleStopAllAgents,
  } = useManagerActions({
    wsUrl,
    clientRef,
    agents: state.agents,
    activeAgent,
    activeAgentId,
    isActiveManager,
    navigateToRoute,
    setState,
    clearPendingResponseForAgent: transcript.clearPendingResponseForAgent,
  })

  // ── Session / sidebar action handlers ──
  const session = useSessionActions({
    clientRef,
    fileEditorCoordinator: panels.fileEditorCoordinator,
    state,
    activeAgent,
    activeAgentId,
    isActiveManager,
    isLoading,
    navigateToRoute,
    setState,
    visibleMessages: transcript.visibleMessages,
    markPendingResponse: transcript.markPendingResponse,
    handleCompactManager,
    messageInputRef,
    messageListRef,
  })
  const localSidebarManager = useManagerActions({
    wsUrl: localWsUrl,
    clientRef: localClientRef,
    agents: localState.agents,
    activeAgent: localActiveAgent,
    activeAgentId: localActiveAgentId,
    isActiveManager: localIsActiveManager,
    navigateToRoute: navigateToOuterRoute,
    setState: setLocalState,
    clearPendingResponseForAgent: activeOriginId === LOCAL_ORIGIN_ID
      ? transcript.clearPendingResponseForAgent
      : () => {},
  })

  const applySecureMutationResult = useCallback((
    client: ManagerWsClient,
    snapshot: SecureSessionSnapshot,
  ) => {
    const clientState = client.getState()
    const targetAgentId = clientState.targetAgentId
    const targetAgent = clientState.agents.find(
      (agent) => agent.agentId === targetAgentId,
    )
    const targetAuthorityAgentId = targetAgent?.role === 'worker'
      ? targetAgent.managerId
      : targetAgentId
    const ownerManagerAgentId =
      snapshot.ownerManagerAgentId ?? snapshot.sessionAgentId
    if (
      clientRef.current !== client
      || (
        targetAgentId !== snapshot.sessionAgentId
        && targetAuthorityAgentId !== ownerManagerAgentId
      )
    ) return
    client.applySecureSessionSnapshot(snapshot)
    setState((current) => current.lastError
      ? { ...current, lastError: null }
      : current)
  }, [clientRef, setState])

  const reportSecureMutationError = useCallback((
    client: ManagerWsClient,
    sessionAgentId: string,
    error: unknown,
  ) => {
    const clientState = client.getState()
    const targetDescriptor = clientState.agents.find(
      (agent) => agent.agentId === sessionAgentId,
    )
    const ownerManagerAgentId = targetDescriptor?.role === 'worker'
      ? targetDescriptor.managerId
      : sessionAgentId
    if (
      clientRef.current !== client
      || (
        clientState.targetAgentId !== sessionAgentId
        && clientState.targetAgentId !== ownerManagerAgentId
      )
    ) return
    const message = secureSessionUiErrorMessage(error)
    setState((current) => ({ ...current, lastError: message }))
  }, [clientRef, setState])

  const handleStartSecureSession = useCallback(async () => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    if (!apiClient || !client || !activeAgentId || isRemoteOriginActive) return false
    try {
      const localVaultReady = await unlockLocalProjectDefaultsIfNeeded(
        secureCatalog,
        secureSessionSnapshot?.profileId ?? activeAgent?.profileId,
        secureBrowserControl?.authorized === true
          && secureBrowserControl.privateEntryAvailable === true,
      )
      if (!localVaultReady) {
        throw new SecureSessionUiError('SECURE_SOURCE_UNAVAILABLE')
      }
      const snapshot = await startSecureSession(
        apiClient,
        activeAgentId,
        secureSessionSnapshot?.revision,
      )
      applySecureMutationResult(client, snapshot)
      return toSecureSessionSnapshotView(snapshot)
    } catch (error) {
      reportSecureMutationError(client, activeAgentId, error)
      return false
    }
  }, [
    activeAgent?.profileId,
    activeAgentId,
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    isRemoteOriginActive,
    reportSecureMutationError,
    secureBrowserControl,
    secureCatalog,
    secureSessionSnapshot?.profileId,
    secureSessionSnapshot?.revision,
  ])

  const handleApplySecureProjectDefaults = useCallback(async (
    managerAgentId: string,
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const managerSnapshot =
      client?.getState().secureSessionSnapshots[managerAgentId] ?? null
    if (
      !apiClient
      || !client
      || !managerSnapshot
      || managerSnapshot.principalKind !== 'manager'
      || isRemoteOriginActive
    ) return false

    try {
      const localVaultReady = await unlockLocalProjectDefaultsIfNeeded(
        secureCatalog,
        managerSnapshot.profileId,
        secureBrowserControl?.authorized === true
          && secureBrowserControl.privateEntryAvailable === true,
      )
      if (!localVaultReady) {
        throw new SecureSessionUiError('SECURE_SOURCE_UNAVAILABLE')
      }
      applySecureMutationResult(client, await applySecureSessionProjectDefaults(
        apiClient,
        managerAgentId,
        managerSnapshot.revision,
      ))
      return true
    } catch (error) {
      if (shouldRefreshAfterProjectDefaultsApplyError(error)) {
        try {
          const refreshed = await fetchSecureSessionSnapshot(
            apiClient,
            managerAgentId,
          )
          applySecureMutationResult(client, refreshed)
          return false
        } catch {
          // Report the original fixed failure when exact reconciliation is unavailable.
        }
      }
      reportSecureMutationError(client, managerAgentId, error)
      return false
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    isRemoteOriginActive,
    reportSecureMutationError,
    secureBrowserControl,
    secureCatalog,
  ])

  const handleReviewProjectSecrets = useCallback(() => {
    const profileId = secureSessionSnapshot?.profileId
    if (!isActiveManager || isRemoteOriginActive || !profileId) return
    panels.fileEditorCoordinator.requestFileEditorTransition(
      { type: 'navigate-route', nextView: 'settings' },
      () => {
        navigateToRoute({
          view: 'settings',
          surface: 'builder',
          settingsTab: 'secrets',
          settingsProfileId: profileId,
        })
      },
    )
  }, [
    isActiveManager,
    isRemoteOriginActive,
    navigateToRoute,
    panels.fileEditorCoordinator,
    secureSessionSnapshot?.profileId,
  ])

  const handleGrantSecureSession = useCallback(async (
    sessionAgentId: string,
    grant: SecureGrantInput,
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    if (
      !apiClient
      || !client
      || !principalSnapshot
      || isRemoteOriginActive
    ) return false
    try {
      let baseRevision = principalSnapshot.revision
      let nextSnapshot
      try {
        nextSnapshot = await grantSecureSessionLease(
          apiClient,
          sessionAgentId,
          baseRevision,
          grant,
        )
      } catch (error) {
        if (
          !grant.requestId
          || !shouldRefreshSecureRequestAfterError(error)
        ) throw error
        let refreshed
        try {
          refreshed = await fetchSecureSessionSnapshot(apiClient, sessionAgentId)
        } catch {
          throw error
        }
        applySecureMutationResult(client, refreshed)
        if (!refreshed.pendingRequests.some(
          (request) => request.requestId === grant.requestId,
        )) {
          return secureGrantMatchesSnapshot(grant, refreshed)
        }
        if (
          !(error instanceof SecureSessionUiError)
          || error.code !== 'SECURE_STALE_REVISION'
        ) throw error
        baseRevision = refreshed.revision
        nextSnapshot = await grantSecureSessionLease(
          apiClient,
          sessionAgentId,
          baseRevision,
          grant,
        )
      }
      applySecureMutationResult(client, nextSnapshot)
      return true
    } catch (error) {
      reportSecureMutationError(client, sessionAgentId, error)
      return false
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    isRemoteOriginActive,
    reportSecureMutationError,
  ])

  const handleGrantSecureSessions = useCallback(async (
    sessionAgentId: string,
    grants: SecureGrantInput[],
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    if (
      !apiClient
      || !client
      || !principalSnapshot
      || isRemoteOriginActive
      || grants.length === 0
    ) return false

    try {
      const nextSnapshot = await grantSecureSessionLeases(
        apiClient,
        sessionAgentId,
        principalSnapshot.revision,
        grants,
      )
      applySecureMutationResult(client, nextSnapshot)
      return true
    } catch (error) {
      let reportedError = error
      const reconciliation = await reconcileSecureBatchGrantFailure(
        error,
        grants,
        () => fetchSecureSessionSnapshot(apiClient, sessionAgentId),
      )
      if (reconciliation) {
        applySecureMutationResult(client, reconciliation.snapshot)
        if (reconciliation.confirmed) return true
        reportedError = new SecureSessionUiError('SECURE_STALE_REVISION')
      }
      reportSecureMutationError(client, sessionAgentId, reportedError)
      return false
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    isRemoteOriginActive,
    reportSecureMutationError,
  ])

  const handleRevokeSecureSession = useCallback(async (
    sessionAgentId: string,
    leaseId?: string,
    options?: { stopProcesses?: boolean },
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    if (
      !apiClient
      || !client
      || !principalSnapshot
      || isRemoteOriginActive
    ) return
    try {
      const nextSnapshot = options?.stopProcesses
        ? await stopSecureSession(apiClient, sessionAgentId, principalSnapshot.revision)
        : leaseId
          ? await revokeSecureSessionLease(
              apiClient,
              sessionAgentId,
              leaseId,
              principalSnapshot.revision,
            )
          : null
      if (nextSnapshot) applySecureMutationResult(client, nextSnapshot)
    } catch (error) {
      reportSecureMutationError(client, sessionAgentId, error)
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    isRemoteOriginActive,
    reportSecureMutationError,
  ])

  const handleDenySecureRequest = useCallback(async (
    sessionAgentId: string,
    requestId: string,
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    if (
      !apiClient
      || !client
      || !principalSnapshot
      || isRemoteOriginActive
    ) return
    try {
      let nextSnapshot
      try {
        nextSnapshot = await denySecureAccessRequest(
          apiClient,
          sessionAgentId,
          requestId,
          principalSnapshot.revision,
        )
      } catch (error) {
        if (!shouldRefreshSecureRequestAfterError(error)) throw error
        let refreshed
        try {
          refreshed = await fetchSecureSessionSnapshot(apiClient, sessionAgentId)
        } catch {
          throw error
        }
        applySecureMutationResult(client, refreshed)
        if (!refreshed.pendingRequests.some(
          (request) => request.requestId === requestId,
        )) return
        if (
          !(error instanceof SecureSessionUiError)
          || error.code !== 'SECURE_STALE_REVISION'
        ) throw error
        nextSnapshot = await denySecureAccessRequest(
          apiClient,
          sessionAgentId,
          requestId,
          refreshed.revision,
        )
      }
      applySecureMutationResult(client, nextSnapshot)
    } catch (error) {
      reportSecureMutationError(client, sessionAgentId, error)
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    isRemoteOriginActive,
    reportSecureMutationError,
  ])

  const handleResolveSecureSshTrustRequest = useCallback(async (
    sessionAgentId: string,
    requestId: string,
    decision: 'approve' | 'dismiss',
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    if (
      !apiClient
      || !client
      || !principalSnapshot
      || isRemoteOriginActive
    ) return false

    try {
      let currentSnapshot = principalSnapshot
      let nextSnapshot
      try {
        nextSnapshot = decision === 'approve'
          ? await approveSecureSshHostTrustRequest(
              apiClient,
              sessionAgentId,
              requestId,
              currentSnapshot.revision,
            )
          : await dismissSecureSshHostTrustRequest(
              apiClient,
              sessionAgentId,
              requestId,
              currentSnapshot.revision,
            )
      } catch (error) {
        if (!shouldRefreshSecureRequestAfterError(error)) throw error
        try {
          currentSnapshot = await fetchSecureSessionSnapshot(apiClient, sessionAgentId)
        } catch {
          throw error
        }
        applySecureMutationResult(client, currentSnapshot)
        if (!(currentSnapshot.pendingSshTrustRequests ?? []).some(
          (request) => request.requestId === requestId,
        )) return true
        if (
          !(error instanceof SecureSessionUiError)
          || error.code !== 'SECURE_STALE_REVISION'
        ) throw error
        nextSnapshot = decision === 'approve'
          ? await approveSecureSshHostTrustRequest(
              apiClient,
              sessionAgentId,
              requestId,
              currentSnapshot.revision,
            )
          : await dismissSecureSshHostTrustRequest(
              apiClient,
              sessionAgentId,
              requestId,
              currentSnapshot.revision,
            )
      }
      applySecureMutationResult(client, nextSnapshot)
      return true
    } catch (error) {
      reportSecureMutationError(client, sessionAgentId, error)
      return false
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    isRemoteOriginActive,
    reportSecureMutationError,
  ])

  const handleTrustSecureSshHost = useCallback((
    sessionAgentId: string,
    requestId: string,
  ) => handleResolveSecureSshTrustRequest(sessionAgentId, requestId, 'approve'), [
    handleResolveSecureSshTrustRequest,
  ])

  const handleDismissSecureSshTrustRequest = useCallback((
    sessionAgentId: string,
    requestId: string,
  ) => handleResolveSecureSshTrustRequest(sessionAgentId, requestId, 'dismiss'), [
    handleResolveSecureSshTrustRequest,
  ])

  const handlePrivateSecureFulfillment = useCallback(async (
    sessionAgentId: string,
    requestId: string,
    input: SecurePrivateFulfillmentInput,
  ) => {
    const apiClient = httpClientRef.current
    const client = clientRef.current
    const principalSnapshot =
      client?.getState().secureSessionSnapshots[sessionAgentId] ?? null
    const request = principalSnapshot?.pendingRequests.find(
      (candidate) => candidate.requestId === requestId,
    )
    if (
      !apiClient
      || !client
      || !principalSnapshot
      || !request
      || isRemoteOriginActive
    ) {
      throw new SecureSessionUiError('SECURE_REQUEST_INVALID')
    }
    try {
      let nextSnapshot
      try {
        nextSnapshot = await fulfillSecureAccessRequestPrivately(
          apiClient,
          sessionAgentId,
          request,
          principalSnapshot.revision,
          input,
        )
      } catch (error) {
        if (!shouldRefreshSecureRequestAfterError(error)) throw error
        let refreshed
        try {
          refreshed = await fetchSecureSessionSnapshot(apiClient, sessionAgentId)
        } catch {
          throw error
        }
        applySecureMutationResult(client, refreshed)
        const refreshedRequest = refreshed.pendingRequests.find(
          (candidate) =>
            candidate.requestId === requestId
            && candidate.secretId === null,
        )
        if (!refreshedRequest) {
          return
        }
        if (
          !(error instanceof SecureSessionUiError)
          || error.code !== 'SECURE_STALE_REVISION'
        ) throw error
        nextSnapshot = await fulfillSecureAccessRequestPrivately(
          apiClient,
          sessionAgentId,
          refreshedRequest,
          refreshed.revision,
          input,
        )
      }
      applySecureMutationResult(client, nextSnapshot)
    } catch (error) {
      reportSecureMutationError(client, sessionAgentId, error)
      throw error
    }
  }, [
    applySecureMutationResult,
    clientRef,
    httpClientRef,
    isRemoteOriginActive,
    reportSecureMutationError,
  ])

  const handleCreateSecureBrowserPairing = useCallback(async () => {
    const apiClient = httpClientRef.current
    if (!apiClient || isRemoteOriginActive) {
      throw new SecureSessionUiError('SECURE_PRIVATE_API_UNAVAILABLE')
    }
    return await createSecureBrowserPairingRequest(apiClient)
  }, [httpClientRef, isRemoteOriginActive])

  const handleClaimSecureBrowserPairing = useCallback(async (
    requestId: string,
    claimSecret: string,
  ) => {
    const apiClient = httpClientRef.current
    if (!apiClient || isRemoteOriginActive) {
      throw new SecureSessionUiError('SECURE_PRIVATE_API_UNAVAILABLE')
    }
    return await claimSecureBrowserPairing(apiClient, requestId, claimSecret)
  }, [httpClientRef, isRemoteOriginActive])

  const handleSecureBrowserPaired = useCallback(async () => {
    await refreshSecureBrowserControl()
  }, [refreshSecureBrowserControl])

  const secureSessionPicker = useMemo<SecureSessionPickerConfig | undefined>(() => {
    if (!activeAgentId) return undefined
    const config: SecureSessionPickerConfig = {
      originId: activeOriginId,
      availability: secureSessionAvailability,
      snapshot: isRemoteOriginActive ? null : secureSessionSnapshotView,
      ...(!isActiveManager ? { readOnly: true } : {}),
      secrets: isRemoteOriginActive ? [] : secureSecretOptions,
      ...(isRemoteOriginActive || !secureSessionSnapshotView
        ? {}
        : {
            outputState: secureSessionSnapshotView.outputState ?? 'clear',
            ...(secureSessionSnapshotView.outputState === 'quarantined'
              ? {
                  outputStateReason:
                    'Forge removed protected material before it reached the agent. The Secure Session remains active.',
                }
              : {}),
          }),
      disabled:
        !state.connected
        || (!isRemoteOriginActive && (
          secureCatalogLoading
          || state.secureSessionSnapshotLoadingSessionId === activeAgentId
        )),
      ...(isRemoteOriginActive || !isActiveManager
        ? {}
        : {
            onStart: handleStartSecureSession,
            onGrant: handleGrantSecureSessions,
            onApplyProjectDefaults: handleApplySecureProjectDefaults,
            onReviewProjectSecrets: handleReviewProjectSecrets,
            onRevoke: handleRevokeSecureSession,
          }),
    }
    return shouldShowSecureSessionPicker(config) ? config : undefined
  }, [
    activeAgentId,
    activeOriginId,
    handleGrantSecureSessions,
    handleApplySecureProjectDefaults,
    handleRevokeSecureSession,
    handleReviewProjectSecrets,
    handleStartSecureSession,
    isActiveManager,
    isRemoteOriginActive,
    secureCatalogLoading,
    secureSecretOptions,
    secureSessionAvailability,
    secureSessionSnapshotView,
    state.connected,
    state.secureSessionSnapshotLoadingSessionId,
  ])

  const secureSessionRequests = useMemo<SecureSessionRequestConfig | undefined>(() => {
    if (!activeAgentId) return undefined
    return {
      originId: activeOriginId,
      ...(secureSessionSnapshotView
        ? { sessionAgentId: secureSessionSnapshotView.sessionAgentId }
        : {}),
      availability: secureSessionAvailability,
      requests: isRemoteOriginActive
        ? []
        : securePendingRequestViews,
      sshTrustRequests: isRemoteOriginActive
        ? []
        : securePendingSshTrustRequestViews,
      secrets: isRemoteOriginActive ? [] : secureSecretOptions,
      ...(!isRemoteOriginActive && secureSessionSnapshot
        ? {
            project: {
              profileId: secureSessionSnapshot.profileId,
              displayName:
                state.profiles.find(
                  (profile) => profile.profileId === secureSessionSnapshot.profileId,
                )?.displayName ?? secureSessionSnapshot.profileId,
              projectDefaultLimitReached:
                (secureCatalog?.projectDefaults?.filter(
                  (projectDefault) =>
                    projectDefault.profileId === secureSessionSnapshot.profileId,
                ).length ?? 0) >= SECURE_SECRET_MAX_PROJECT_DEFAULTS,
            },
          }
        : {}),
      ...(isRemoteOriginActive || !secureSessionSnapshotView
        ? {}
        : {
            outputState: secureSessionSnapshotView.outputState ?? 'clear',
            ...(secureSessionSnapshotView.outputState === 'quarantined'
              ? {
                  outputStateReason:
                    'Forge removed protected material before it reached the agent. The Secure Session remains active.',
                }
              : {}),
          }),
      disabled: !state.connected || secureCatalogLoading,
      canApprove:
        !isRemoteOriginActive
        && isSecureControlAvailable(secureBrowserControl?.authorized === true),
      onGrant: handleGrantSecureSession,
      onDeny: handleDenySecureRequest,
      onTrustSshHost: handleTrustSecureSshHost,
      onDismissSshTrustRequest: handleDismissSecureSshTrustRequest,
      ...(isActiveManager ? { onRevoke: handleRevokeSecureSession } : {}),
      ...(!isRemoteOriginActive && isPrivateSecureFulfillmentAvailable(
        secureBrowserControl?.privateEntryAvailable === true,
      )
        ? { onPrivateFulfill: handlePrivateSecureFulfillment }
        : {}),
      ...(
        !isRemoteOriginActive
        && !isSecureControlAvailable(secureBrowserControl?.authorized === true)
        && secureBrowserControl?.available === true
        && secureBrowserControl.secureContextRequired === false
          ? {
              onCreateBrowserPairing: handleCreateSecureBrowserPairing,
              onClaimBrowserPairing: handleClaimSecureBrowserPairing,
              onBrowserPaired: handleSecureBrowserPaired,
            }
          : {}
      ),
    }
  }, [
    activeAgentId,
    activeOriginId,
    handleDenySecureRequest,
    handleDismissSecureSshTrustRequest,
    handleGrantSecureSession,
    handleTrustSecureSshHost,
    handlePrivateSecureFulfillment,
    handleCreateSecureBrowserPairing,
    handleClaimSecureBrowserPairing,
    handleSecureBrowserPaired,
    handleRevokeSecureSession,
    isActiveManager,
    isRemoteOriginActive,
    secureCatalogLoading,
    secureCatalog?.projectDefaults,
    secureSecretOptions,
    securePendingRequestViews,
    securePendingSshTrustRequestViews,
    secureSessionAvailability,
    secureSessionSnapshot,
    secureSessionSnapshotView,
    secureBrowserControl,
    state.profiles,
    state.connected,
  ])

  const sessionModelPicker =
    isActiveManager && isSessionModelPickerEligible(activeAgent, activeAgentProfile)
      ? {
          originId: activeOriginId,
          httpClientRef,
          sessionAgentId: activeAgent.agentId,
          sessionLabel: activeAgent.sessionLabel || activeAgent.displayName || activeAgent.agentId,
          currentModel: activeAgent.model,
          modelOrigin: activeAgent.modelOrigin,
          profileDefaultModel: activeAgentProfile?.defaultModel,
          disabled: !state.connected,
          onUpdate: session.handleUpdateSessionModel,
        }
      : undefined

  const sessionCoordinationPicker =
    isActiveManager
    && activeAgent
    && activeAgentProfile
    && isSessionModelPickerEligible(activeAgent, activeAgentProfile)
      ? {
          originId: activeOriginId,
          httpClientRef,
          sessionAgentId: activeAgent.agentId,
          profileId: activeAgentProfile.profileId,
          managerPosture: activeAgent.managerPosture ?? 'delegation_first' as const,
          managerPostureOrigin: activeAgent.managerPostureOrigin,
          projectDefaultManagerPosture: activeAgentProfile.defaultManagerPosture,
          delegationRosterId: activeAgent.delegationRosterId,
          delegationRosterOrigin: activeAgent.delegationRosterOrigin,
          projectDefaultDelegationRosterId: activeAgentProfile.defaultDelegationRosterId,
          disabled: !state.connected,
          onUpdateProjectDefaults: session.handleUpdateProjectDelegationDefaults,
          onUpdateSession: session.handleUpdateSessionDelegation,
        }
      : undefined

  const localSidebarSession = useSessionActions({
    clientRef: localClientRef,
    fileEditorCoordinator: panels.fileEditorCoordinator,
    state: localState,
    activeAgent: localActiveAgent,
    activeAgentId: localActiveAgentId,
    isActiveManager: localIsActiveManager,
    isLoading: activeOriginId === LOCAL_ORIGIN_ID ? isLoading : false,
    navigateToRoute: (nextRouteState, replace) => navigateToRoute({
      ...nextRouteState,
      origin: LOCAL_ORIGIN_ID,
    }, replace),
    setState: setLocalState,
    visibleMessages: activeOriginId === LOCAL_ORIGIN_ID ? transcript.visibleMessages : [],
    markPendingResponse: activeOriginId === LOCAL_ORIGIN_ID ? transcript.markPendingResponse : () => {},
    handleCompactManager: async () => {},
    messageInputRef,
    messageListRef,
  })
  const { replyTarget, setReplyTarget, messageForkTarget, setMessageForkTarget } = session

  const {
    isDraggingFiles,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useFileDrop({
    activeView,
    messageInputRef,
  })

  useEffect(() => {
    if (!state.lastSuccess) return
    const timer = setTimeout(() => {
      setState((prev) => ({ ...prev, lastSuccess: null }))
    }, 4000)
    return () => clearTimeout(timer)
  }, [state.lastSuccess, setState])

  const handleSaveOnboarding = useCallback((input: import('@/lib/onboarding-api').SaveOnboardingPreferencesInput) => {
    void (async () => {
      const nextState = await saveOnboardingPreferences(input)
      if (!nextState) {
        return
      }
      navigateToRoute({ view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID }, true)
    })()
  }, [navigateToRoute, saveOnboardingPreferences])

  const handleSkipOnboarding = useCallback(() => {
    void (async () => {
      const nextState = await skipOnboarding()
      if (!nextState) {
        return
      }
      navigateToRoute({ view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID }, true)
    })()
  }, [navigateToRoute, skipOnboarding])

  const previewSession = useMemo(() => {
    if (!activeAgentId) return null
    const activeDescriptor = state.agents.find((agent) => agent.agentId === activeAgentId)
    if (!activeDescriptor) return null

    const sessionAgentId = activeDescriptor.role === 'manager' ? activeDescriptor.agentId : activeDescriptor.managerId
    const sessionDescriptor = state.agents.find((agent) => agent.agentId === sessionAgentId && agent.role === 'manager')
    if (!sessionDescriptor?.profileId) return null

    return {
      agentId: sessionDescriptor.agentId,
      profileId: sessionDescriptor.profileId,
    }
  }, [activeAgentId, state.agents])

  const showActivityRail = activeView === 'chat'

  // Wave R presence: other members viewing the active session (self excluded).
  const presenceViewers = useMemo(() => {
    const viewers =
      (activeAgentId ? state.projectPresence[activeAgentId] : undefined) ??
      (activeManagerId ? state.projectPresence[activeManagerId] : undefined) ??
      []
    return viewers.filter((viewer) => viewer.userId !== activeOriginCurrentUserId)
  }, [activeAgentId, activeManagerId, activeOriginCurrentUserId, state.projectPresence])

  // ── Wave R: origin-aware sidebar selection ──
  const handleSelectSidebarAgent = useCallback((agentId: string) => {
    if (activeOriginId === LOCAL_ORIGIN_ID) {
      panels.handleSelectAgent(agentId)
      return
    }
    // Cross-origin select back to local: route change flips the active origin;
    // the route→subscription sync subscribes on the local client.
    navigateToRoute({ view: 'chat', agentId, origin: LOCAL_ORIGIN_ID })
  }, [activeOriginId, navigateToRoute, panels])

  const handleSelectRemoteAgent = useCallback((originId: string, agentId: string) => {
    if (originId === activeOriginId) {
      panels.handleSelectAgent(agentId)
      return
    }
    navigateToRoute({ view: 'chat', agentId, origin: originId })
  }, [activeOriginId, navigateToRoute, panels])

  const handleRemoteOriginSignIn = useCallback((originId: string) => {
    const target = resolveCollaborationTarget(originId)
    navigateToOuterRoute({
      view: 'settings',
      surface: 'builder',
      settingsTab: 'collaboration',
      collabApiBaseUrl: target.apiBaseUrl,
    })
  }, [navigateToOuterRoute])

  const handleRemoteOriginRetry = useCallback((originId: string) => {
    forgeOriginManager.retryOrigin(originId)
  }, [])

  const feedbackProfileId = transcript.feedbackProfileId

  return (
    <WorkGraphWorkerHighlightProvider>
      <FileDirtyConfirmDialog state={panels.fileEditorCoordinator.dialogState} />
      <BrowserAutomationHost
        ref={browserHostRef}
        client={localClient}
        state={localState}
        selectedSessionAgentId={browserSessionAgentId}
        selectedProfileId={browserProfileId}
        panelVisible={activeView === 'chat' && panels.isBrowserOpen}
        onRuntimeTabStateChanged={handleBrowserRuntimeTabStateChanged}
        onWorkspaceModeChange={(mode) => {
          setBrowserWorkspaceMode(mode)
          if (mode === 'docked') window.requestAnimationFrame(() => {
            const control = document.querySelector('button[aria-label="Open Managed Browser in a separate window"]')
            if (control instanceof HTMLElement) control.focus()
          })
        }}
      />

      <AgentSidebarConnected
        wsUrl={localWsUrl}
        builderSidebarOrderApi={builderSidebarOrderApi}
        collaborationModeSwitch={collaborationModeSwitch}
        selectedAgentId={activeAgentId}
        activeOriginId={activeOriginId}
        onSelectRemoteAgent={handleSelectRemoteAgent}
        onRemoteOriginSignIn={handleRemoteOriginSignIn}
        onRemoteOriginRetry={handleRemoteOriginRetry}
        isSettingsActive={activeView === 'settings'}
        isStatsActive={activeView === 'stats'}
        isArchiveActive={activeView === 'archive'}
        isMobileOpen={panels.isMobileSidebarOpen}
        onMobileClose={() => panels.setIsMobileSidebarOpen(false)}
        onAddManager={handleOpenCreateManagerDialog}
        onSelectAgent={handleSelectSidebarAgent}
        onDeleteAgent={localSidebarSession.handleDeleteAgent}
        onDeleteManager={localSidebarManager.handleRequestDeleteManager}
        onOpenSettings={() => panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'settings' }, () => {
          navigateToRoute({ view: 'settings', surface: 'builder' })
        })}
        onOpenProjectSecrets={(profileId) => panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'settings' }, () => {
          navigateToRoute({
            view: 'settings',
            surface: 'builder',
            settingsTab: 'secrets',
            settingsProfileId: profileId,
          })
        })}
        onOpenStats={() => panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'stats' }, () => {
          navigateToRoute({ view: 'stats' })
        })}
        onOpenArchive={() => panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'archive' }, () => {
          navigateToRoute({ view: 'archive', surface: 'builder' })
        })}
        onCreateSession={localSidebarSession.handleCreateSession}
        onStopSession={localSidebarSession.handleStopSession}
        onResumeSession={localSidebarSession.handleResumeSession}
        onDeleteSession={localSidebarSession.handleDeleteSession}
        onArchiveSession={localSidebarSession.handleArchiveSession}
        onArchiveProfile={localSidebarSession.handleArchiveProfile}
        onRenameSession={localSidebarSession.handleRenameSession}
        onPinSession={localSidebarSession.handlePinSession}
        onRenameProfile={localSidebarSession.handleRenameProfile}
        onForkSession={localSidebarSession.handleForkSession}
        onMarkUnread={localSidebarSession.handleMarkUnread}
        onMarkAllRead={localSidebarSession.handleMarkAllRead}
        onUpdateManagerModel={localSidebarSession.handleUpdateManagerModel}
        onUpdateSessionModel={localSidebarSession.handleUpdateSessionModel}
        onUpdateManagerCwd={localSidebarSession.handleUpdateManagerCwd}
        onBrowseDirectory={localSidebarSession.handleBrowseDirectoryForCwd}
        onValidateDirectory={localSidebarSession.handleValidateDirectoryForCwd}
        directServerDirectoryBrowser={directServerDirectoryBrowser}
        onRequestSessionWorkers={localSidebarSession.handleRequestSessionWorkers}
        onSetSessionProjectAgent={localSidebarSession.handleSetSessionProjectAgent}
        onGetProjectAgentConfig={localSidebarSession.handleGetProjectAgentConfig}
        onGetProjectAgentSharing={localSidebarSession.handleGetProjectAgentSharing}
        onSetProjectAgentSharing={localSidebarSession.handleSetProjectAgentSharing}
        onListProjectAgentReferences={localSidebarSession.handleListProjectAgentReferences}
        onGetProjectAgentReference={localSidebarSession.handleGetProjectAgentReference}
        onSetProjectAgentReference={localSidebarSession.handleSetProjectAgentReference}
        onDeleteProjectAgentReference={localSidebarSession.handleDeleteProjectAgentReference}
        onRequestProjectAgentRecommendations={localSidebarSession.handleRequestProjectAgentRecommendations}
        onCreateAgentCreator={localSidebarSession.handleCreateAgentCreator}
      />

      {showActivityRail ? (
        <ActivityRail items={panels.activityRailItems} />
      ) : null}

      <div
          className="relative flex min-w-0 flex-1"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {activeView === 'chat' && isDraggingFiles ? (
            <div className="pointer-events-none absolute inset-2 z-50 rounded-lg border-2 border-dashed border-primary bg-primary/10" />
          ) : null}

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen && panels.isArtifactsPanelOpen ? (
            <ArtifactsSidebar
              wsUrl={wsUrl}
              managerId={activeManagerId}
              artifacts={transcript.collectedArtifacts}
              isOpen={panels.isArtifactsPanelOpen}
              onClose={panels.handleGuardedArtifactsClose}
              onArtifactClick={panels.handleOpenArtifact}
              activeTab={panels.artifactsPanelTab}
              onActiveTabChange={panels.setArtifactsPanelTab}
              panelMode="rail-selected"
              desktopPlacement="left"
              desktopOnly
            />
          ) : null}

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen && !panels.isArtifactsPanelOpen ? (
            <FileBrowserSidebar
              wsUrl={wsUrl}
              agentId={activeAgentId}
              isOpen={panels.isFileBrowserOpen}
              onClose={panels.handleGuardedToggleFileBrowser}
              onSelectFile={panels.handleGuardedFileBrowserSelectFile}
              onOpenStickyFile={panels.handleFileBrowserOpenStickyFile}
              selectedFile={panels.selectedFileBrowserFile}
              treeSnapshot={panels.fileBrowserTreeSnapshot}
              onTreeSnapshotChange={panels.updateFileBrowserTreeSnapshot}
              worktreeContext={panels.fileBrowserWorktreeContext}
              onClearWorktreeContext={panels.handleGuardedClearFileBrowserWorktreeContext}
              projectResourceProfileId={activeManagerAgent?.profileId ?? activeManagerAgent?.agentId ?? null}
              projectResourceSessionAgentId={activeManagerAgent?.agentId ?? null}
              desktopPlacement="left"
              desktopOnly
              refreshNonce={panels.fileBrowserRefreshNonce}
              onDeleteEntry={panels.handleFileBrowserDeleteEntry}
              onCreateFile={panels.handleFileBrowserCreateFile}
              onRenameEntry={panels.handleFileBrowserRenameEntry}
            />
          ) : null}

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen && panels.isFileBrowserOpen && panels.selectedFileBrowserFile ? (
            <FileBrowserPanel
              wsUrl={wsUrl}
              agentId={activeAgentId}
              filePath={panels.selectedFileBrowserFile}
              onClose={panels.handleGuardedFileBrowserClosePanel}
              onNavigateToDirectory={panels.handleGuardedFileBrowserNavigateToDirectory}
              tabs={panels.fileBrowserTabs}
              activeTabId={panels.activeFileBrowserTabId}
              previewTabId={panels.previewFileBrowserTabId}
              dirtyTabIds={panels.dirtyFileBrowserTabIds}
              contentScrollSnapshot={panels.activeFileBrowserContentScrollSnapshot}
              onContentScrollSnapshotChange={panels.updateActiveFileBrowserContentScrollSnapshot}
              onActivateTab={panels.activateFileBrowserTab}
              onCloseTab={(tab) => panels.handleRequestCloseFileBrowserTab(tab.id)}
              onStickifyTab={panels.stickifyFileBrowserTab}
              worktreeId={panels.fileBrowserWorktreeContext?.worktreeId ?? null}
              desktopOnly
              resizeHandlePlacement="right"
              inlineEditingEnabled={FILE_BROWSER_INLINE_EDITING_ENABLED}
              editSession={panels.fileEditSession}
              editorSessionKey={panels.activeFileEditorKey}
              refreshNonce={panels.fileBrowserRefreshNonce}
              onContentLoaded={panels.handleFileEditorContentLoaded}
            />
          ) : null}

          <div className="flex min-w-0 flex-1 flex-col">
            {panels.isInlineDiffViewerOpen ? (
              <div className="diff-viewer flex min-h-0 flex-1 flex-col overflow-hidden bg-background" aria-label="Source Control workspace">
                <DiffViewerContent
                  active={panels.isInlineDiffViewerOpen}
                  wsUrl={wsUrl}
                  agentId={activeAgentId}
                  isCortex={isDiffViewerCortexSession}
                  onClose={panels.handleCloseDiffViewer}
                  onBrowseWorktreeFiles={panels.handleBrowseWorktreeFromSourceControl}
                  onRequestSourceControlMutation={panels.handleRequestSourceControlMutation}
                  onSourceControlMutationComplete={panels.handleSourceControlMutationComplete}
                  externalRefreshNonce={panels.sourceControlRefreshNonce}
                  remoteUpdateSnapshot={remoteUpdateSnapshot}
                  onRemoteUpdateSnapshotChange={handleRemoteUpdateSnapshotChange}
                  navigationRequest={panels.diffViewerNavigationRequest}
                  initialRepoTarget={panels.diffViewerInitialState?.initialRepoTarget}
                  initialTab={panels.diffViewerInitialState?.initialTab}
                  initialSha={panels.diffViewerInitialState?.initialSha}
                  initialFile={panels.diffViewerInitialState?.initialFile}
                  initialQuickFilter={panels.diffViewerInitialState?.initialQuickFilter}
                />
              </div>
            ) : activeView === 'settings' ? (
              <SettingsPanel
                wsUrl={localWsUrl}
                managers={settingsManagers}
                profiles={state.profiles}
                promptChangeKey={state.promptChangeKey}
                specialistChangeKey={state.specialistChangeKey}
                modelConfigChangeKey={state.modelConfigChangeKey}
                repositoryCloneAvailable={cloneRepositoryEnabled}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
                previewSession={previewSession}
                contextProfileId={routeState.view === 'settings' ? routeState.settingsProfileId : undefined}
                initialTab={routeState.view === 'settings' ? routeState.settingsTab : undefined}
                initialCollabApiBaseUrl={routeState.view === 'settings' ? routeState.collabApiBaseUrl : undefined}
                initialSkillImportUrl={routeState.view === 'settings' ? routeState.skillImportUrl : undefined}
                onSkillImportUrlConsumed={() => {
                  if (routeState.view === 'settings' && routeState.skillImportUrl) {
                    navigateToOuterRoute({ ...routeState, skillImportUrl: undefined }, true)
                  }
                }}
              />
            ) : activeView === 'stats' ? (
              <StatsPage
                wsUrl={localWsUrl}
                routeState={routeState as { view: 'stats'; statsTab?: StatsTab }}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
                onTabChange={(tab) =>
                  navigateToRoute({ view: 'stats', statsTab: tab })
                }
              />
            ) : activeView === 'archive' ? (
              <ArchiveView
                agents={state.agents}
                profiles={state.profiles}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
                onRestoreProfile={session.handleRestoreProfile}
                onRestoreSession={session.handleRestoreSession}
              />
            ) : activeView === 'chat' && panels.isBrowserOpen && browserSessionAgentId && browserProfileId ? (
              browserWorkspaceMode === 'popped-out' || browserWorkspaceMode === 'opening' ? (
                <section className="relative flex min-h-0 flex-1 items-center justify-center bg-background" aria-label="Managed Browser workspace">
                  <div data-browser-automation-viewport className="pointer-events-none absolute inset-0" aria-hidden="true" />
                  <div className="relative z-10 max-w-md text-center">
                    <h2 className="font-medium">Browser is open in a separate window</h2>
                    <p className="mt-2 text-sm text-muted-foreground">The same managed tab, automation queue, and recording remain active.</p>
                    <div className="mt-4 flex justify-center gap-2">
                      <button type="button" className="rounded border px-3 py-1.5 text-sm hover:bg-muted focus-visible:ring-2" onClick={() => void browserHostRef.current?.bringToFront()}>Bring to front</button>
                      <button id="managed-browser-dock-control" type="button" className="rounded border px-3 py-1.5 text-sm hover:bg-muted focus-visible:ring-2" onClick={() => void browserHostRef.current?.dock()}>Dock</button>
                    </div>
                  </div>
                </section>
              ) : <BuilderBrowserPanel
                client={localClient}
                sessionAgentId={browserSessionAgentId}
                profileId={browserProfileId}
                snapshot={browserSessionSnapshot}
                host={localState.browserHost}
                commandPort={browserCommandPort}
                mode={browserWorkspaceMode}
                popoutAvailable={Boolean(window.electronBridge?.browserWorkspace?.capability.popoutAvailable)}
              />
            ) : (
              <ChatWorkspace
                headerProps={{
                  connected: state.connected,
                  activeAgentId,
                  activeAgentLabel,
                  presenceViewers,
                  wsUrl,
                  activeAgentProfileName,
                  activeAgentSessionLabel,
                  totalUnreadCount,
                  activeAgentArchetypeId: activeAgent?.archetypeId,
                  activeAgentSessionPurpose: activeAgent?.sessionPurpose,
                  activeAgentStatus,
                  activeAgentRole: activeAgent?.role ?? null,
                  activeAgentCreatedAt: activeAgent?.createdAt ?? null,
                  activeAgentUpdatedAt: activeAgent?.updatedAt ?? null,
                  channelView: messageSourceView,
                  onChannelViewChange: setMessageSourceView,
                  detailedAllView: effectiveDetailedAllView,
                  onDetailedAllViewChange: undefined,
                  contextWindowUsage: transcript.contextWindowUsage,
                  modelCacheHeaderSummary,
                  generationThroughputEligible:
                    !isRemoteOriginActive && isActiveManager && isPiGenerationThroughputEligible(activeAgent),
                  generationThroughput:
                    !isRemoteOriginActive && isActiveManager && activeAgentId && isPiGenerationThroughputEligible(activeAgent)
                      ? state.generationThroughputByAgentId[activeAgentId]
                      : undefined,
                  generationThroughputLatestFinal:
                    !isRemoteOriginActive && isActiveManager && activeAgentId && isPiGenerationThroughputEligible(activeAgent)
                      ? state.generationThroughputLatestFinalByAgentId[activeAgentId]
                      : undefined,
                  compactionCount: activeAgent?.compactionCount,
                  showCompact: isActiveManager,
                  compactInProgress: isCompactingManager,
                  onCompact: () => void handleCompactManager(),
                  showSmartCompact: isActiveManager,
                  smartCompactInProgress: isSmartCompactingManager,
                  onSmartCompact: () => void handleSmartCompactManager(),
                  autoCompactionInProgress,
                  pinnedCount: transcript.pinnedCount,
                  pinnedMessageIds: transcript.pinnedMessageIds,
                  onScrollToMessage: transcript.handleScrollToMessage,
                  onClearAllPins: conversationActionsEnabled ? session.handleClearAllPins : undefined,
                  showStopAll: isActiveManager,
                  stopAllInProgress: isStoppingAllAgents,
                  stopAllDisabled: !state.connected || !canStopAllAgents,
                  onStopAll: () => void handleStopAllAgents(),
                  showNewChat: isActiveManager,
                  onNewChat: session.handleNewChat,
                  isArtifactsPanelOpen: panels.isArtifactsPanelOpen,
                  onToggleArtifactsPanel: panels.handleGuardedToggleArtifactsPanel,
                  isTerminalPanelOpen: terminalPanel.isPanelVisible,
                  terminalCount: state.terminals.length,
                  onToggleTerminalPanel: terminalSessionAgentId ? terminalPanel.togglePanel : undefined,
                  onOpenDiffViewer: panels.handleOpenDiffViewerModal,
                  remoteUpdateAttentionRequired:
                    remoteUpdateSnapshot?.effectiveEnabled === true &&
                    remoteUpdateSnapshot.state === 'update_available' &&
                    remoteUpdateSnapshot.attentionRequired === true,
                  isFileBrowserOpen: panels.isFileBrowserOpen,
                  onToggleFileBrowser: panels.handleGuardedToggleFileBrowser,
                  onToggleMobileSidebar: () =>
                    panels.setIsMobileSidebarOpen((previous) => !previous),
                  showDesktopWorkspaceActions: !showActivityRail,
                  sessionFeedbackVote: isActiveManager && activeAgentId ? feedback.getVote(activeAgentId) : null,
                  sessionFeedbackHasComment: isActiveManager && activeAgentId ? feedback.hasComment(activeAgentId) : false,
                  onSessionFeedbackVote:
                    conversationActionsEnabled && isActiveManager && feedbackProfileId ? feedback.submitVote : undefined,
                  onSessionFeedbackComment:
                    conversationActionsEnabled && isActiveManager && feedbackProfileId ? feedback.submitComment : undefined,
                  onSessionFeedbackClearComment:
                    conversationActionsEnabled && isActiveManager && feedbackProfileId ? feedback.clearComment : undefined,
                  isFeedbackSubmitting: feedback.isSubmitting,
                }}
                remoteUpdateSnapshot={remoteUpdateSnapshot}
                onRemoteUpdateSnapshotChange={handleRemoteUpdateSnapshotChange}
                onOpenRemoteUpdateIncoming={() => panels.handleOpenDiffViewerDeepLink({
                  initialRepoTarget: 'workspace',
                  initialTab: 'incoming',
                })}
                lastError={state.lastError}
                lastSuccess={state.lastSuccess}
                restartRecovery={state.restartRecovery}
                onResumeRestartRecovery={() => clientRef.current?.resumeRestartRecovery()}
                onDismissRestartRecovery={() => clientRef.current?.dismissRestartRecovery()}
                chatSearchBarProps={{ search: transcript.chatSearch }}
                showWelcomeForm={shouldShowWelcomeForm}
                showCreateManagerState={shouldShowCreateManagerState}
                welcomeCalloutProps={{
                  mode: 'first-launch',
                  state: onboardingState,
                  isBusy: isMutatingOnboardingState,
                  error: onboardingError,
                  onSave: handleSaveOnboarding,
                  onSkipForNow: handleSkipOnboarding,
                }}
                readyCalloutProps={{
                  mode: 'ready',
                  state: onboardingState,
                  isBusy: isMutatingOnboardingState,
                  error: onboardingError,
                  onCreateManager: handleOpenCreateManagerDialog,
                }}
                isMessageListHidden={
                  terminalPanel.panelMode === 'maximized' &&
                  !terminalPanel.isMobile &&
                  terminalPanel.isPanelVisible
                }
                messageListRef={messageListRef}
                messageListProps={{
                  messages: transcript.visibleMessages,
                  agents: state.agents,
                  isLoading,
                  wsUrl,
                  activeAgentId,
                  currentCollabUserId: activeOriginCurrentUserId ?? undefined,
                  projectAgent: activeAgent?.projectAgent,
                  onSuggestionClick: conversationActionsEnabled ? session.handleSuggestionClick : undefined,
                  onArtifactClick: conversationActionsEnabled ? panels.handleOpenArtifact : undefined,
                  onForkFromMessage: conversationActionsEnabled && activeAgentId ? session.handleForkFromMessage : undefined,
                  onPinMessage: conversationActionsEnabled && isActiveManager && activeAgentId ? session.handlePinMessage : undefined,
                  onStopExternalThread: conversationActionsEnabled ? session.handleStopSession : undefined,
                  onReplyToMessage: conversationActionsEnabled ? session.handleReplyToMessage : undefined,
                  getVote: conversationActionsEnabled && feedbackProfileId ? feedback.getVote : undefined,
                  hasComment: conversationActionsEnabled && feedbackProfileId ? feedback.hasComment : undefined,
                  onFeedbackVote: conversationActionsEnabled && feedbackProfileId ? feedback.submitVote : undefined,
                  onFeedbackComment: conversationActionsEnabled && feedbackProfileId ? feedback.submitComment : undefined,
                  onFeedbackClearComment: conversationActionsEnabled && feedbackProfileId ? feedback.clearComment : undefined,
                  isFeedbackSubmitting: feedback.isSubmitting,
                  onChoiceSubmit: conversationActionsEnabled ? session.handleChoiceSubmit : undefined,
                  onChoiceCancel: conversationActionsEnabled ? session.handleChoiceCancel : undefined,
                  pendingChoiceIds: conversationActionsEnabled ? state.pendingChoiceIds : new Set(),
                  codexElicitations: conversationActionsEnabled ? state.codexElicitations : [],
                  onCodexElicitationResponse: conversationActionsEnabled
                    ? (agentId, elicitationId, decision, values, persistScope) =>
                        clientRef.current?.sendCodexElicitationResponse(agentId, elicitationId, decision, values, persistScope)
                    : undefined,
                  missingPendingChoiceIds,
                  planSnapshot,
                  planExpanded,
                  onPlanExpandedChange: setPlanExpanded,
                  statuses: state.statuses,
                  hasOlder: conversationActionsEnabled && (state.conversationPage?.hasOlder ?? false),
                  olderCursor: conversationActionsEnabled ? state.conversationPage?.nextCursor : undefined,
                  isLoadingOlder: conversationActionsEnabled && state.conversationPageLoading,
                  historyCompleteness: state.conversationPage?.completeness ?? 'complete',
                  historyMutation: state.conversationHistoryMutation,
                  secureSessionRequests,
                  onLoadOlder: conversationActionsEnabled ? () => {
                    if (state.conversationPage?.completeness === 'source_changed') {
                      return clientRef.current?.refreshConversationHistory()
                    }
                    return clientRef.current?.loadOlderConversation()
                  } : undefined,
                  conversationBootstrapPhase: transcript.conversationBootstrap?.phase,
                  hasStalePresentation: transcript.hasStaleConversationPresentation,
                  bootstrapErrorMessage: transcript.conversationBootstrap?.errorMessage,
                  onRetryBootstrap: () => clientRef.current?.retryConversationBootstrap(),
                  streamingStartedAt:
                    activeAgentStatus === 'streaming'
                      ? state.statuses[activeAgentId ?? '']?.streamingStartedAt
                      : undefined,
                }}
                planSnapshot={planSnapshot}
                goalSnapshot={goalSnapshot}
                onGoalAction={(action) => {
                  if (activeAgentId) clientRef.current?.controlSessionGoal(activeAgentId, action)
                }}
                workerPillBarProps={
                  isActiveManager
                    ? {
                        workers: sessionWorkers,
                        statuses: state.statuses,
                        activityMessages: state.activityMessages,
                        generationThroughputByAgentId: !isRemoteOriginActive
                          ? state.generationThroughputByAgentId
                          : undefined,
                        generationThroughputLatestFinalByAgentId: !isRemoteOriginActive
                          ? state.generationThroughputLatestFinalByAgentId
                          : undefined,
                        onNavigateToWorker: panels.handleSelectAgent,
                      }
                    : undefined
                }
                workerBackBarProps={
                  activeAgent?.role === 'worker' && activeAgent.managerId && parentManagerLabel
                    ? {
                        managerLabel: parentManagerLabel,
                        onNavigateBack: () => panels.handleSelectAgent(activeAgent.managerId),
                        ...(workerSecureStatus ? { secureStatus: workerSecureStatus } : {}),
                      }
                    : undefined
                }
                terminalPanelProps={{
                  wsUrl,
                  sessionAgentId: terminalSessionAgentId,
                  terminals: state.terminals,
                  panelMode: terminalPanel.panelMode,
                  activeTerminalId: terminalPanel.activeTerminalId,
                  panelHeight: terminalPanel.panelHeight,
                  isMobile: terminalPanel.isMobile,
                  maxTerminalsPerManager: terminalPanel.maxTerminalsPerManager,
                  editingTerminalId: terminalPanel.editingTerminalId,
                  renameDraft: terminalPanel.renameDraft,
                  initialTickets: terminalPanel.initialTickets,
                  onSelectTerminal: terminalPanel.setActiveTerminalId,
                  onCreateTerminal: () => {
                    void terminalPanel.createTerminal()
                  },
                  onCloseTerminal: terminalPanel.closeTerminal,
                  onStartRenameTerminal: terminalPanel.startRenameTerminal,
                  onRenameDraftChange: terminalPanel.setRenameDraft,
                  onCommitRenameTerminal: terminalPanel.commitRenameTerminal,
                  onCancelRenameTerminal: terminalPanel.cancelRenameTerminal,
                  onCollapsePanel: terminalPanel.collapsePanel,
                  onRestorePanel: terminalPanel.restorePanel,
                  onMaximizePanel: terminalPanel.maximizePanel,
                  onHidePanel: terminalPanel.hidePanel,
                  onPanelHeightChange: terminalPanel.setPanelHeight,
                  onFocusChatInput: session.handleFocusChatInput,
                  onAddToChat: session.handleTerminalAddToChat,
                  issueTicket: terminalPanel.issueTicket,
                }}
                messageInputRef={messageInputRef}
                messageInputProps={{
                  onSend: session.handleSend,
                  onSubmitted: session.handleMessageInputSubmitted,
                  isLoading,
                  disabled: !state.connected || !activeAgentId || hasActivePendingChoice || !conversationActionsEnabled,
                  placeholderOverride: hasActivePendingChoice
                    ? 'Respond to the choice above or click Skip…'
                    : undefined,
                  allowWhileLoading: true,
                  agentLabel: activeAgentLabel,
                  wsUrl,
                  agentId: activeAgentId ?? undefined,
                  slashCommands,
                  projectAgents: projectAgentSuggestions,
                  enableCodexMention: shouldEnableCodexMention(activeAgent),
                  managerAgentId: activeAgentId ?? undefined,
                  replyTarget,
                  onClearReplyTarget: () => setReplyTarget(null),
                  sessionModelPicker,
                  sessionCoordinationPicker,
                  secureSessionPicker,
                }}
              />
            )}
          </div>

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen ? (
            <ChatSidePanels
              isCortexSession={activeAgent?.archetypeId === 'cortex'}
              cortexDashboardProps={{
                wsUrl: localWsUrl,
                managerId: activeManagerId,
                isOpen: panels.isArtifactsPanelOpen,
                onClose: panels.handleGuardedArtifactsClose,
                onArtifactClick: panels.handleOpenArtifact,
                onOpenSession: panels.handleSelectAgent,
                onOpenDiffViewer: panels.handleOpenDiffViewerModal,
                requestedTab: panels.cortexDashboardTabRequest,
                onActiveTabChange: panels.handleCortexDashboardTabChange,
              }}
              artifactsSidebarProps={{
                wsUrl,
                managerId: activeManagerId,
                artifacts: transcript.collectedArtifacts,
                isOpen: panels.isArtifactsPanelOpen,
                onClose: panels.handleGuardedArtifactsClose,
                onArtifactClick: panels.handleOpenArtifact,
                activeTab: panels.artifactsPanelTab,
                onActiveTabChange: panels.setArtifactsPanelTab,
                panelMode: 'rail-selected',
                mobileOnly: true,
              }}
              fileBrowserPanelProps={
                panels.isFileBrowserOpen && panels.selectedFileBrowserFile
                  ? {
                      wsUrl,
                      agentId: activeAgentId,
                      filePath: panels.selectedFileBrowserFile,
                      onClose: panels.handleGuardedFileBrowserClosePanel,
                      onNavigateToDirectory: panels.handleGuardedFileBrowserNavigateToDirectory,
                      tabs: panels.fileBrowserTabs,
                      activeTabId: panels.activeFileBrowserTabId,
                      previewTabId: panels.previewFileBrowserTabId,
                      dirtyTabIds: panels.dirtyFileBrowserTabIds,
                      contentScrollSnapshot: panels.activeFileBrowserContentScrollSnapshot,
                      onContentScrollSnapshotChange: panels.updateActiveFileBrowserContentScrollSnapshot,
                      onActivateTab: panels.activateFileBrowserTab,
                      onCloseTab: (tab) => panels.handleRequestCloseFileBrowserTab(tab.id),
                      onStickifyTab: panels.stickifyFileBrowserTab,
                      worktreeId: panels.fileBrowserWorktreeContext?.worktreeId ?? null,
                      mobileOnly: true,
                    }
                  : null
              }
              fileBrowserSidebarProps={{
                wsUrl,
                agentId: activeAgentId,
                isOpen: panels.isFileBrowserOpen,
                onClose: panels.handleGuardedToggleFileBrowser,
                onSelectFile: panels.handleGuardedFileBrowserSelectFile,
                onOpenStickyFile: panels.handleFileBrowserOpenStickyFile,
                selectedFile: panels.selectedFileBrowserFile,
                treeSnapshot: panels.fileBrowserTreeSnapshot,
                onTreeSnapshotChange: panels.updateFileBrowserTreeSnapshot,
                worktreeContext: panels.fileBrowserWorktreeContext,
                onClearWorktreeContext: panels.handleGuardedClearFileBrowserWorktreeContext,
                projectResourceProfileId: activeManagerAgent?.profileId ?? activeManagerAgent?.agentId ?? null,
                projectResourceSessionAgentId: activeManagerAgent?.agentId ?? null,
                mobileOnly: true,
                refreshNonce: panels.fileBrowserRefreshNonce,
                onDeleteEntry: panels.handleFileBrowserDeleteEntry,
                onCreateFile: panels.handleFileBrowserCreateFile,
                onRenameEntry: panels.handleFileBrowserRenameEntry,
              }}
            />
          ) : null}
      </div>

      <GlobalDialogs
        artifactPanelProps={{
          artifact: panels.activeArtifact,
          wsUrl,
          activeAgentId,
          onClose: panels.handleGuardedArtifactDialogClose,
          onArtifactClick: panels.handleOpenArtifact,
        }}
        createManagerDialogProps={{
          open: isCreateManagerDialogOpen,
          wsUrl,
          isCreatingManager,
          isValidatingDirectory,
          isPickingDirectory,
          newManagerName,
          newManagerCwd,
          newManagerModelSelection,
          newManagerReasoningLevel,
          scaffoldForgeResources,
          createManagerError,
          browseError,
          cloneRepositoryEnabled,
          sourceMode: createProjectSourceMode,
          repositoryUrl,
          repositoryFolder,
          repositoryBasePath,
          cloneStage,
          clonePercent,
          cloneCancellable,
          isCancellingClone,
          onSourceModeChange: handleCreateProjectSourceModeChange,
          onRepositoryUrlChange: handleRepositoryUrlChange,
          onRepositoryFolderChange: handleRepositoryFolderChange,
          onRepositoryBasePathChange: handleRepositoryBasePathChange,
          onBrowseRepositoryBasePath: !usesServerDirectoryBrowser
            ? () => {
                void handleBrowseRepositoryBasePath()
              }
            : undefined,
          onCancelClone: () => {
            void handleCancelClone()
          },
          onOpenChange: handleCreateManagerDialogOpenChange,
          onNameChange: handleNewManagerNameChange,
          onCwdChange: handleNewManagerCwdChange,
          onModelSelectionChange: handleNewManagerModelSelectionChange,
          onReasoningLevelChange: handleNewManagerReasoningLevelChange,
          onScaffoldForgeResourcesChange: handleScaffoldForgeResourcesChange,
          // Remote origins and direct hosted collaboration Builder both use the
          // active server socket. Only a true local Builder uses the native picker.
          onBrowseDirectory: usesServerDirectoryBrowser
            ? undefined
            : () => {
                void handleBrowseDirectory()
              },
          serverDirectoryBrowser: usesServerDirectoryBrowser
            ? {
                client: {
                  listDirectories: (path) => {
                    const client = clientRef.current
                    if (!client) return Promise.reject(new Error('Not connected to active server.'))
                    return client.listDirectories(path)
                  },
                  validateDirectory: (path) => {
                    const client = clientRef.current
                    if (!client) return Promise.reject(new Error('Not connected to active server.'))
                    return client.validateDirectory(path)
                  },
                  createDirectory: (isRemoteOriginActive
                    ? activeOriginMeta?.capabilities?.createDirectory
                    : directServerDirectoryBrowser?.canCreateDirectory)
                    ? (parentPath, name) => {
                        const client = clientRef.current
                        if (!client) return Promise.reject(new Error('Not connected to active server.'))
                        return client.createDirectory(parentPath, name)
                      }
                    : undefined,
                },
                canCreateDirectory: isRemoteOriginActive
                  ? activeOriginMeta?.capabilities?.createDirectory === true
                  : directServerDirectoryBrowser?.canCreateDirectory === true,
              }
            : undefined,
          onSubmit: (event) => {
            void handleCreateManager(event)
          },
        }}
        deleteManagerDialogProps={{
          managerToDelete: localSidebarManager.managerToDelete,
          deleteManagerError: localSidebarManager.deleteManagerError,
          isDeletingManager: localSidebarManager.isDeletingManager,
          onClose: localSidebarManager.handleCloseDeleteManagerDialog,
          onConfirm: () => {
            void localSidebarManager.handleConfirmDeleteManager()
          },
        }}
        forkSessionDialogProps={
          messageForkTarget
            ? {
                onConfirm: session.handleConfirmMessageFork,
                onClose: () => setMessageForkTarget(null),
                fromMessageTimestamp: messageForkTarget.messageTimestamp
                  ? new Date(messageForkTarget.messageTimestamp).toLocaleString()
                  : undefined,
              }
            : null
        }
        diffViewerDialogProps={{
          open: panels.isDiffViewerOpen && panels.diffViewerPresentation === 'modal',
          onOpenChange: panels.handleGuardedDiffViewerOpenChange,
          wsUrl,
          agentId: activeAgentId,
          isCortex: isDiffViewerCortexSession,
          onBrowseWorktreeFiles: panels.handleBrowseWorktreeFromSourceControl,
          onRequestSourceControlMutation: panels.handleRequestSourceControlMutation,
          onSourceControlMutationComplete: panels.handleSourceControlMutationComplete,
          externalRefreshNonce: panels.sourceControlRefreshNonce,
          remoteUpdateSnapshot,
          onRemoteUpdateSnapshotChange: handleRemoteUpdateSnapshotChange,
          navigationRequest: panels.diffViewerNavigationRequest,
          initialRepoTarget: panels.diffViewerInitialState?.initialRepoTarget,
          initialTab: panels.diffViewerInitialState?.initialTab,
          initialSha: panels.diffViewerInitialState?.initialSha,
          initialFile: panels.diffViewerInitialState?.initialFile,
          initialQuickFilter: panels.diffViewerInitialState?.initialQuickFilter,
        }}
      />

      <CortexV2OnboardingModal source={localWsUrl} />
    </WorkGraphWorkerHighlightProvider>
  )
}
