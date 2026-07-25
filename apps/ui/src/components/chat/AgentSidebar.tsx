import { Archive, Globe, SquarePen, X } from 'lucide-react'
import { ChangeCwdDialog } from './ChangeCwdDialog'
import { ForkSessionDialog } from './ForkSessionDialog'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import {
  buildProfileTreeRows,
  getArchivedProfileRows,
  getDirectlyArchivedSessionRows,
  isCortexProfile,
} from '@/lib/agent-hierarchy'
import type { ProfileTreeRow } from '@/lib/agent-hierarchy'
import { LOCAL_ORIGIN_ID, originRegistry, type OriginId } from '@/lib/origin-store'
import { useProviderUsage } from '@/hooks/use-provider-usage'
import { toggleMute, getMutedAgents, setMutedAgents, MUTE_CHANGE_EVENT } from '@/lib/notification-service'
import { cn } from '@/lib/utils'
import type {
  AgentModelDescriptor,
  AgentModelOrigin,
  BuilderSidebarOrderRef,
  ManagerExactModelSelection,
  ManagerReasoningLevel,
  ProjectAgentInfo,
  SessionModelUpdateMode,
} from '@forge/protocol'

// Extracted sub-components
import { SidebarSearch } from './agent-sidebar/SidebarSearch'
import { ProjectViewSwitcher, type SidebarProjectViewOption } from './agent-sidebar/ProjectViewSwitcher'
import { SidebarFooter } from './agent-sidebar/SidebarFooter'
import { ModeSwitch } from './collab-sidebar/ModeSwitch'
import { ProfileGroup } from './agent-sidebar/ProfileGroup'
import { RemoteOriginSections, RemoteProfileRow } from './agent-sidebar/RemoteOriginSections'
import { CortexSection } from './agent-sidebar/CortexSection'
import { SortableProfileGroup } from './agent-sidebar/SortableProfileGroup'
import {
  CreateSessionDialog,
  RenameSessionDialog,
  RenameProfileDialog,
  DeleteSessionDialog,
  ChangeModelDialog,
  SessionModelDialog,
} from './agent-sidebar/dialogs'
import { ProjectAgentSettingsSheet } from './project-agent/ProjectAgentSettingsSheet'
import { ActivateRepoProjectAgentSheet } from './project-agent/ActivateRepoProjectAgentSheet'
import { ProjectAgentSharingDialog } from './project-agent/ProjectAgentSharingDialog'
import { filterTreeRows, findCliHideNavigationTarget, injectGlowPulseStyle } from './agent-sidebar'
import { useProjectViews, useSidebarPrefs, useSidebarTreeState } from './agent-sidebar/hooks'
import { useInactiveRepoProjectAgents, type RepoProjectAgentSidebarEntry } from '@/hooks/use-inactive-repo-project-agents'
import { getInactiveRepoProjectAgentEntryKey, matchesRepoProjectAgentSearch } from '@/components/settings/repo-project-agent-ui-utils'
import type { AgentSidebarProps, RemoteSidebarOrigin } from './agent-sidebar/types'
import {
  builderSidebarOrderKey,
  reconcileBuilderSidebarOrder,
  resolveBuilderSidebarDragMove,
} from '@/lib/builder-sidebar-order'

type MixedProjectRow =
  | {
      kind: 'local'
      ref: BuilderSidebarOrderRef
      treeRow: ProfileTreeRow
    }
  | {
      kind: 'remote'
      ref: BuilderSidebarOrderRef
      treeRow: ProfileTreeRow
      origin: RemoteSidebarOrigin
    }

// Inject subtle glow pulse keyframes once
injectGlowPulseStyle()

export const AgentSidebar = React.memo(function AgentSidebar({
  connected,
  wsUrl,
  agents,
  profiles,
  treeRows: providedTreeRows,
  statuses,
  unreadCounts,
  collaborationModeSwitch,
  selectedAgentId,
  isSettingsActive,
  isStatsActive = false,
  isArchiveActive = false,
  isMobileOpen = false,
  onMobileClose,
  onAddManager,
  onSelectAgent,
  onDeleteAgent,
  onDeleteManager,
  onOpenSettings,
  onOpenProjectSecrets,
  onOpenStats,
  onOpenArchive,
  onCreateSession,
  onStopSession,
  onResumeSession,
  onDeleteSession,
  onArchiveSession,
  onArchiveProfile,
  onRenameSession,
  onPinSession,
  onRenameProfile,
  onForkSession,
  onMarkUnread,
  onMarkAllRead,
  onUpdateManagerModel,
  onUpdateSessionModel,
  onUpdateManagerCwd,
  onBrowseDirectory,
  onValidateDirectory,
  directServerDirectoryBrowser,
  onRequestSessionWorkers,
  builderSidebarOrder,
  onMoveBuilderProject,
  onSetSessionProjectAgent,
  onGetProjectAgentConfig,
  onGetProjectAgentSharing,
  onSetProjectAgentSharing,
  onListProjectAgentReferences,
  onGetProjectAgentReference,
  onSetProjectAgentReference,
  onDeleteProjectAgentReference,
  onRequestProjectAgentRecommendations,
  onCreateAgentCreator,
  remoteOrigins,
  activeOriginId,
  onSelectRemoteAgent,
  onRemoteOriginSignIn,
  onRemoteOriginRetry,
}: AgentSidebarProps) {
  const isLocalOriginActive = (activeOriginId ?? LOCAL_ORIGIN_ID) === LOCAL_ORIGIN_ID
  const localSelectedAgentId = isLocalOriginActive ? selectedAgentId : null
  const builtTreeRows = useMemo(() => buildProfileTreeRows(agents, profiles), [agents, profiles])
  const treeRows = providedTreeRows ?? builtTreeRows
  const hasArchivedItems = useMemo(() => (
    getArchivedProfileRows(agents, profiles).length > 0
    || getDirectlyArchivedSessionRows(agents, profiles).length > 0
  ), [agents, profiles])

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const {
    collapsedProfileIds,
    toggleProfileCollapsed,
    searchQuery,
    setSearchQuery,
    searchInputRef,
    showModelIcons,
    showProviderUsage,
    hideCliSessions,
    toggleHideCliSessions,
  } = useSidebarPrefs()
  const projectViewOptions = useMemo<SidebarProjectViewOption[]>(() => {
    const localOptions = treeRows
      .filter((row) => !isCortexProfile(row))
      .map((row) => ({
        key: builderSidebarOrderKey({
          originId: LOCAL_ORIGIN_ID,
          profileId: row.profile.profileId,
        }),
        label: row.profile.displayName,
      }))
    const remoteOptions = (remoteOrigins ?? []).flatMap((origin) => (
      origin.connected
        ? origin.treeRows.map((row) => ({
            key: builderSidebarOrderKey({
              originId: origin.originId,
              profileId: row.profile.profileId,
            }),
            label: row.profile.displayName,
            originLabel: origin.instanceName ?? origin.originId,
          }))
        : []
    ))
    return [...localOptions, ...remoteOptions]
  }, [remoteOrigins, treeRows])
  const {
    views: projectViews,
    activeView,
    activeProjectKeys,
    setActiveView,
    saveView,
    deleteView,
  } = useProjectViews()
  const viewFilteredTreeRows = useMemo(() => {
    if (!activeProjectKeys) return treeRows
    return treeRows.filter((row) => (
      !isCortexProfile(row)
      && activeProjectKeys.has(builderSidebarOrderKey({
        originId: LOCAL_ORIGIN_ID,
        profileId: row.profile.profileId,
      }))
    ))
  }, [activeProjectKeys, treeRows])
  const {
    activeDragId,
    setActiveDragId,
    expandedSessionIds,
    expandedWorkerListSessionIds,
    regularRows,
    cortexRow,
    parsedSearch,
    deferredSearchQuery,
    isSearchActive,
    matchCount,
    toggleSessionCollapsed,
    showMoreSessions,
    showLessSessions,
    toggleWorkerListExpanded,
    getVisibleSessionLimit,
  } = useSidebarTreeState({
    treeRows: viewFilteredTreeRows,
    searchQuery,
    onRequestSessionWorkers,
  })
  const [usagePanelOpen, setUsagePanelOpen] = useState(false)
  const handleToggleUsagePanel = useCallback(() => setUsagePanelOpen(prev => !prev), [])
  const handleCloseUsagePanel = useCallback(() => setUsagePanelOpen(false), [])
  const { data: providerUsage, loading: providerUsageLoading, refetch: refetchProviderUsage } = useProviderUsage(showProviderUsage)
  const [mutedAgentsState, setMutedAgentsState] = useState<Set<string>>(() => getMutedAgents())

  // Re-read mute state on custom event (same-tab) and storage event (cross-tab)
  useEffect(() => {
    const updateMuted = () => setMutedAgentsState(getMutedAgents())
    window.addEventListener(MUTE_CHANGE_EVENT, updateMuted)
    window.addEventListener('storage', updateMuted)
    return () => {
      window.removeEventListener(MUTE_CHANGE_EVENT, updateMuted)
      window.removeEventListener('storage', updateMuted)
    }
  }, [])

  const [createTarget, setCreateTarget] = useState<{ profileId: string; profileLabel: string } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ agentId: string; label: string } | null>(null)
  const [renameProfileTarget, setRenameProfileTarget] = useState<{ profileId: string; displayName: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ agentId: string; label: string } | null>(null)
  const [forkTarget, setForkTarget] = useState<{ sourceAgentId: string } | null>(null)
  const [changeModelTarget, setChangeModelTarget] = useState<{
    profileId: string
    profileLabel: string
    currentModel: AgentModelDescriptor | undefined
    currentReasoningLevel: ManagerReasoningLevel | undefined
  } | null>(null)
  const [sessionModelTarget, setSessionModelTarget] = useState<{
    sessionAgentId: string
    sessionLabel: string
    currentModel: AgentModelDescriptor | undefined
    currentReasoningLevel: ManagerReasoningLevel | undefined
    modelOrigin: AgentModelOrigin | undefined
    profileDefaultModel: AgentModelDescriptor | undefined
  } | null>(null)
  const [changeCwdTarget, setChangeCwdTarget] = useState<{
    profileId: string
    profileLabel: string
    currentCwd: string
    originId?: OriginId
  } | null>(null)
  const [projectAgentTarget, setProjectAgentTarget] = useState<{
    agentId: string
    sessionLabel: string
    currentProjectAgent: ProjectAgentInfo | null
  } | null>(null)
  const [projectAgentSharingTarget, setProjectAgentSharingTarget] = useState<{
    agentId: string
    sessionLabel: string
    currentProjectAgent: ProjectAgentInfo
  } | null>(null)
  const [inactiveRepoActivationTarget, setInactiveRepoActivationTarget] = useState<RepoProjectAgentSidebarEntry | null>(null)
  const [selectedInactiveRepoEntryKey, setSelectedInactiveRepoEntryKey] = useState<string | null>(null)
  const [inactiveRepoRefreshKey, setInactiveRepoRefreshKey] = useState(0)
  const repoProjectAgentSignature = useMemo(() => (
    agents
      .filter((agent) => agent.role === 'manager' && agent.projectAgent?.source?.type === 'repo')
      .map((agent) => {
        const source = agent.projectAgent?.source
        const definitionId = source?.type === 'repo' ? source.definitionId : agent.agentId
        return `${agent.profileId ?? agent.agentId}:${definitionId}`
      })
      .sort()
      .join('|')
  ), [agents])

  const { getEntriesForProfile } = useInactiveRepoProjectAgents({
    connected,
    wsUrl,
    treeRows,
    refreshKey: `${inactiveRepoRefreshKey}:${repoProjectAgentSignature}`,
  })

  const { rows: displayedRegularRows, matchCount: displayedMatchCount } = useMemo(() => {
    if (!isSearchActive) {
      return { rows: regularRows, matchCount }
    }

    const existingProfileIds = new Set(regularRows.map((row) => row.profile.profileId))
    const inactiveOnlyRows: ProfileTreeRow[] = []
    let inactiveMatchCount = 0

    for (const row of viewFilteredTreeRows) {
      if (isCortexProfile(row) || existingProfileIds.has(row.profile.profileId)) continue
      const matchingInactiveEntries = getEntriesForProfile(row.profile.profileId).filter((entry) =>
        matchesRepoProjectAgentSearch(entry.item, parsedSearch.term),
      )
      if (matchingInactiveEntries.length === 0) continue
      inactiveMatchCount += matchingInactiveEntries.length
      inactiveOnlyRows.push({ ...row, sessions: [] })
    }

    return {
      rows: inactiveOnlyRows.length > 0 ? [...regularRows, ...inactiveOnlyRows] : regularRows,
      matchCount: matchCount + inactiveMatchCount,
    }
  }, [getEntriesForProfile, isSearchActive, matchCount, parsedSearch.term, regularRows, viewFilteredTreeRows])

  const {
    rows: remoteProjectRows,
    matchCount: remoteMatchCount,
    originIdsWithProjects: remoteOriginIdsWithProjects,
  } = useMemo<{
    rows: MixedProjectRow[]
    matchCount: number
    originIdsWithProjects: Set<string>
  }>(() => {
    const rows: MixedProjectRow[] = []
    const originIdsWithProjects = new Set<string>()
    let remoteMatchCount = 0

    for (const origin of remoteOrigins ?? []) {
      if (!origin.connected) continue
      const structuralRows = activeProjectKeys
        ? origin.treeRows.filter((row) => activeProjectKeys.has(builderSidebarOrderKey({
            originId: origin.originId,
            profileId: row.profile.profileId,
          })))
        : origin.treeRows
      if (structuralRows.length > 0) originIdsWithProjects.add(origin.originId)
      const filtered = isSearchActive
        ? filterTreeRows(structuralRows, deferredSearchQuery)
        : { filtered: structuralRows, matchCount: 0 }
      remoteMatchCount += filtered.matchCount
      for (const treeRow of filtered.filtered) {
        rows.push({
          kind: 'remote',
          ref: { originId: origin.originId, profileId: treeRow.profile.profileId },
          treeRow,
          origin,
        })
      }
    }

    return { rows, matchCount: remoteMatchCount, originIdsWithProjects }
  }, [activeProjectKeys, deferredSearchQuery, isSearchActive, remoteOrigins])

  const mixedProjectRows = useMemo<MixedProjectRow[]>(() => {
    const visibleRows: MixedProjectRow[] = [
      ...displayedRegularRows.map((treeRow) => ({
        kind: 'local' as const,
        ref: { originId: LOCAL_ORIGIN_ID, profileId: treeRow.profile.profileId },
        treeRow,
      })),
      ...remoteProjectRows,
    ]
    const rowByKey = new Map(visibleRows.map((row) => [builderSidebarOrderKey(row.ref), row]))
    const orderedRefs = reconcileBuilderSidebarOrder(
      builderSidebarOrder ?? [],
      visibleRows.map((row) => row.ref),
    )
    return orderedRefs.flatMap((ref) => {
      const row = rowByKey.get(builderSidebarOrderKey(ref))
      return row ? [row] : []
    })
  }, [builderSidebarOrder, displayedRegularRows, remoteProjectRows])

  const remoteOriginsWithoutProjects = useMemo(() => (
    activeView ? [] :
    (remoteOrigins ?? [])
      .filter((origin) => !remoteOriginIdsWithProjects.has(origin.originId))
      .map((origin) => origin.originId)
  ), [activeView, remoteOriginIdsWithProjects, remoteOrigins])
  const combinedMatchCount = displayedMatchCount + remoteMatchCount
  const viewNavigationRows = useMemo(() => {
    if (!activeView) return []
    const localRows = viewFilteredTreeRows.map((treeRow) => ({
      originId: LOCAL_ORIGIN_ID,
      treeRow,
    }))
    const remoteRows = (remoteOrigins ?? []).flatMap((origin) => (
      origin.connected
        ? origin.treeRows
            .filter((treeRow) => activeProjectKeys?.has(builderSidebarOrderKey({
              originId: origin.originId,
              profileId: treeRow.profile.profileId,
            })))
            .map((treeRow) => ({ originId: origin.originId, treeRow }))
        : []
    ))
    return [...localRows, ...remoteRows]
  }, [activeProjectKeys, activeView, remoteOrigins, viewFilteredTreeRows])

  const handleForkSetTarget = useCallback((sourceAgentId: string) => setForkTarget({ sourceAgentId }), [])

  const getCreatorAttribution = useCallback((creatorAgentId: string): string | null => {
    const creator = agents.find((a) => a.agentId === creatorAgentId)
    if (!creator) return null
    if (creator.projectAgent?.handle) return creator.projectAgent.handle
    return creator.sessionLabel || creator.displayName || null
  }, [agents])

  const handleSelectAgent = useCallback((agentId: string) => {
    setSelectedInactiveRepoEntryKey(null)
    setInactiveRepoActivationTarget(null)
    onSelectAgent(agentId)
    onMobileClose?.()
  }, [onSelectAgent, onMobileClose])

  const handleSelectRemoteAgent = useCallback((originId: string, agentId: string) => {
    onSelectRemoteAgent?.(originId, agentId)
    onMobileClose?.()
  }, [onMobileClose, onSelectRemoteAgent])

  const handleSelectInactiveRepoProjectAgent = useCallback((entry: RepoProjectAgentSidebarEntry) => {
    setSelectedInactiveRepoEntryKey(getInactiveRepoProjectAgentEntryKey(entry))
    setInactiveRepoActivationTarget(entry)
  }, [])

  const handleInactiveRepoProjectAgentActivated = useCallback((agentId: string) => {
    setInactiveRepoRefreshKey((prev) => prev + 1)
    setSelectedInactiveRepoEntryKey(null)
    setInactiveRepoActivationTarget(null)
    onSelectAgent(agentId)
    onMobileClose?.()
  }, [onSelectAgent, onMobileClose])

  const handleOpenSettings = useCallback(() => {
    onOpenSettings()
    onMobileClose?.()
  }, [onOpenSettings, onMobileClose])

  const handleOpenProjectSecrets = useCallback((profileId: string) => {
    onOpenProjectSecrets?.(profileId)
    onMobileClose?.()
  }, [onMobileClose, onOpenProjectSecrets])

  // A project view is a screen-share boundary, not just a cosmetic list filter.
  // If the current surface is outside that boundary, move to an allowed session
  // before the user continues. With no available session, Settings is the safest
  // existing neutral surface exposed by the stable sidebar contract.
  useEffect(() => {
    if (!activeView) return
    const currentOriginId = activeOriginId ?? LOCAL_ORIGIN_ID
    const currentSelectionIsVisible = Boolean(selectedAgentId) && viewNavigationRows.some((row) => (
      row.originId === currentOriginId
      && row.treeRow.sessions.some((session) => (
        session.sessionAgent.agentId === selectedAgentId
        || session.workers.some((worker) => worker.agentId === selectedAgentId)
      ))
    ))
    const isConversationSurface = !isSettingsActive && !isStatsActive && !isArchiveActive
    if (currentSelectionIsVisible && isConversationSurface) return

    const target = viewNavigationRows.flatMap((row) => {
      const session = row.treeRow.sessions.find((entry) => entry.isDefault)
        ?? row.treeRow.sessions[0]
      return session ? [{ originId: row.originId, agentId: session.sessionAgent.agentId }] : []
    }).find((entry) => entry.originId === LOCAL_ORIGIN_ID || Boolean(onSelectRemoteAgent))

    if (target) {
      if (target.originId === LOCAL_ORIGIN_ID) {
        handleSelectAgent(target.agentId)
      } else {
        handleSelectRemoteAgent(target.originId, target.agentId)
      }
    } else if (!isSettingsActive) {
      handleOpenSettings()
    }
  }, [
    activeOriginId,
    activeView,
    handleOpenSettings,
    handleSelectAgent,
    handleSelectRemoteAgent,
    isArchiveActive,
    isSettingsActive,
    isStatsActive,
    onSelectRemoteAgent,
    selectedAgentId,
    viewNavigationRows,
  ])

  const handleOpenStats = useCallback(() => {
    onOpenStats?.()
    onMobileClose?.()
  }, [onOpenStats, onMobileClose])

  const handleRequestCreateSession = useCallback((profileId: string) => {
    const profile = profiles.find((entry) => entry.profileId === profileId)
    setCreateTarget({
      profileId,
      profileLabel: profile?.displayName || profileId,
    })
  }, [profiles])

  const handleConfirmCreateSession = useCallback((profileId: string, name?: string) => {
    onCreateSession?.(profileId, name)
    setCreateTarget(null)
  }, [onCreateSession])

  const handleRequestRename = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setRenameTarget({
      agentId,
      label: agent.sessionLabel || agent.displayName || agent.agentId,
    })
  }, [agents])

  const handleConfirmRename = useCallback((agentId: string, label: string) => {
    onRenameSession?.(agentId, label)
    setRenameTarget(null)
  }, [onRenameSession])

  const handleRequestRenameProfile = useCallback((profileId: string) => {
    const profile = profiles.find((p) => p.profileId === profileId)
    if (!profile) return
    setRenameProfileTarget({
      profileId,
      displayName: profile.displayName,
    })
  }, [profiles])

  const handleConfirmRenameProfile = useCallback((profileId: string, displayName: string) => {
    onRenameProfile?.(profileId, displayName)
    setRenameProfileTarget(null)
  }, [onRenameProfile])

  const handleRequestDelete = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setDeleteTarget({
      agentId,
      label: agent.sessionLabel || agent.displayName || agent.agentId,
    })
  }, [agents])

  const handleConfirmDelete = useCallback((agentId: string) => {
    onDeleteSession?.(agentId)
    setDeleteTarget(null)
  }, [onDeleteSession])

  const handleRequestChangeModel = useCallback((profileId: string) => {
    const profile = profiles.find((p) => p.profileId === profileId)
    if (!profile) return
    const defaultModel = profile.defaultModel
    const currentReasoningLevel = defaultModel?.thinkingLevel as ManagerReasoningLevel | undefined
    setChangeModelTarget({
      profileId,
      profileLabel: profile.displayName || profileId,
      currentModel: defaultModel,
      currentReasoningLevel,
    })
  }, [profiles])

  const handleConfirmChangeModel = useCallback((profileId: string, modelSelection: ManagerExactModelSelection, reasoningLevel?: ManagerReasoningLevel) => {
    onUpdateManagerModel?.(profileId, modelSelection, reasoningLevel)
    setChangeModelTarget(null)
  }, [onUpdateManagerModel])

  const handleRequestSessionModelChange = useCallback((sessionAgentId: string) => {
    const agent = agents.find((a) => a.agentId === sessionAgentId)
    if (!agent) return
    const profile = profiles.find((p) => p.profileId === agent.profileId)
    const currentReasoningLevel = agent.model.thinkingLevel as ManagerReasoningLevel | undefined
    setSessionModelTarget({
      sessionAgentId,
      sessionLabel: agent.sessionLabel || agent.displayName || agent.agentId,
      currentModel: agent.model,
      currentReasoningLevel,
      modelOrigin: agent.modelOrigin,
      profileDefaultModel: profile?.defaultModel,
    })
  }, [agents, profiles])

  const handleConfirmSessionModelChange = useCallback((
    sessionAgentId: string,
    mode: SessionModelUpdateMode,
    modelSelection?: ManagerExactModelSelection,
    reasoningLevel?: ManagerReasoningLevel,
  ) => {
    onUpdateSessionModel?.(sessionAgentId, mode, modelSelection, reasoningLevel)
    setSessionModelTarget(null)
  }, [onUpdateSessionModel])

  const handleUseProjectDefault = useCallback((sessionAgentId: string) => {
    onUpdateSessionModel?.(sessionAgentId, 'inherit')
  }, [onUpdateSessionModel])

  const handleRequestChangeCwd = useCallback((profileId: string) => {
    const profile = profiles.find((p) => p.profileId === profileId)
    const defaultSession = agents.find(
      (a) => a.role === 'manager' && (a.profileId === profileId || a.agentId === profileId),
    )
    setChangeCwdTarget({
      profileId,
      profileLabel: profile?.displayName || profileId,
      currentCwd: defaultSession?.cwd || '',
      originId: LOCAL_ORIGIN_ID,
    })
  }, [agents, profiles])

  const handleRequestRemoteChangeCwd = useCallback((originId: OriginId, profileId: string, profileLabel: string, currentCwd: string) => {
    setChangeCwdTarget({
      profileId,
      profileLabel,
      currentCwd,
      originId,
    })
  }, [])

  const handleConfirmChangeCwd = useCallback(async (profileId: string, cwd: string) => {
    const originId = changeCwdTarget?.originId
    if (originId && originId !== LOCAL_ORIGIN_ID) {
      const client = originRegistry.getOrigin(originId)?.getClient()
      if (!client) throw new Error('Remote origin is not connected.')
      await client.updateManagerCwd(profileId, cwd)
      setChangeCwdTarget(null)
      return
    }
    if (!onUpdateManagerCwd) return
    await onUpdateManagerCwd(profileId, cwd)
    setChangeCwdTarget(null)
  }, [changeCwdTarget?.originId, onUpdateManagerCwd])

  const changeCwdValidateDirectory = useCallback(async (path: string) => {
    const originId = changeCwdTarget?.originId
    if (originId && originId !== LOCAL_ORIGIN_ID) {
      const client = originRegistry.getOrigin(originId)?.getClient()
      if (!client) throw new Error('Remote origin is not connected.')
      return client.validateDirectory(path)
    }
    if (!onValidateDirectory) throw new Error('Directory validation is unavailable.')
    return onValidateDirectory(path)
  }, [changeCwdTarget?.originId, onValidateDirectory])

  const changeCwdServerBrowser = useMemo(() => {
    const originId = changeCwdTarget?.originId
    if (!originId) return undefined
    const isDirectServer = originId === LOCAL_ORIGIN_ID && Boolean(directServerDirectoryBrowser)
    if (originId === LOCAL_ORIGIN_ID && !isDirectServer) return undefined
    const store = originRegistry.getOrigin(originId)
    const client = store?.getClient()
    if (!client) return undefined
    const canCreate = isDirectServer
      ? directServerDirectoryBrowser?.canCreateDirectory === true
      : store?.getMetaSnapshot().capabilities?.createDirectory === true
    return {
      client: {
        listDirectories: (path?: string) => client.listDirectories(path),
        validateDirectory: (path: string) => client.validateDirectory(path),
        createDirectory: canCreate
          ? (parentPath: string, name: string) => client.createDirectory(parentPath, name)
          : undefined,
      },
      canCreateDirectory: canCreate,
    }
  }, [changeCwdTarget?.originId, directServerDirectoryBrowser])

  const handlePromoteToProjectAgent = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setProjectAgentTarget({
      agentId,
      sessionLabel: agent.sessionLabel || agent.displayName || agent.agentId,
      currentProjectAgent: null,
    })
  }, [agents])

  const handleOpenProjectAgentSettings = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setProjectAgentTarget({
      agentId,
      sessionLabel: agent.sessionLabel || agent.displayName || agent.agentId,
      currentProjectAgent: agent.projectAgent ?? null,
    })
  }, [agents])

  const handleOpenProjectAgentSharing = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent?.projectAgent) return
    setProjectAgentSharingTarget({
      agentId,
      sessionLabel: agent.sessionLabel || agent.displayName || agent.agentId,
      currentProjectAgent: agent.projectAgent,
    })
  }, [agents])

  const handleDemoteProjectAgent = useCallback(async (agentId: string) => {
    await onSetSessionProjectAgent?.(agentId, null)
  }, [onSetSessionProjectAgent])

  const handleSaveProjectAgent = useCallback(async (agentId: string, projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string; capabilities?: import('@forge/protocol').ProjectAgentCapability[] }) => {
    await onSetSessionProjectAgent?.(agentId, projectAgent)
  }, [onSetSessionProjectAgent])

  const handleToggleMute = useCallback((agentId: string) => {
    toggleMute(agentId)
  }, [])

  // Wrap the CLI-session toggle with auto-navigate: when hiding CLI sessions,
  // move selection away from any currently-selected CLI session to the first
  // visible non-CLI session using the same display order the sidebar renders
  // (project agents → pinned → regular), derived from the search-filtered
  // displayed rows rather than raw treeRows.
  const handleToggleHideCliSessions = useCallback(() => {
    if (!hideCliSessions && localSelectedAgentId && !isSettingsActive) {
      const displayedRows = cortexRow ? [cortexRow, ...displayedRegularRows] : displayedRegularRows
      const targetId = findCliHideNavigationTarget(localSelectedAgentId, agents, displayedRows)
      if (targetId) {
        onSelectAgent(targetId)
      }
      // If no target exists, the selected session stays visible via the
      // existing isSelectedSessionOrWorker exception in ProfileGroup.
    }
    toggleHideCliSessions()
  }, [hideCliSessions, localSelectedAgentId, isSettingsActive, agents, displayedRegularRows, cortexRow, onSelectAgent, toggleHideCliSessions])

  const handleMuteAllSessions = useCallback((sessionAgentIds: string[], mute: boolean) => {
    const current = getMutedAgents()
    for (const id of sessionAgentIds) {
      if (mute) {
        current.add(id)
      } else {
        current.delete(id)
      }
    }
    setMutedAgents(current)
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null)
    const { active, over } = event
    if (!over || active.id === over.id || !onMoveBuilderProject) return

    const move = resolveBuilderSidebarDragMove(
      String(active.id),
      String(over.id),
      mixedProjectRows.map((row) => row.ref),
    )
    if (!move) return
    onMoveBuilderProject(move.active, move.over)
  }, [mixedProjectRows, onMoveBuilderProject, setActiveDragId])

  const profileGroupContent = useCallback((
    treeRow: ProfileTreeRow,
    dragHandleRef?: (element: HTMLElement | null) => void,
    dragHandleListeners?: DraggableSyntheticListeners,
    dragHandleAttributes?: DraggableAttributes,
  ) => (
    <ProfileGroup
      treeRow={treeRow}
      statuses={statuses}
      unreadCounts={unreadCounts}
      selectedAgentId={localSelectedAgentId}
      isSettingsActive={isSettingsActive}
      isCollapsed={isSearchActive ? false : collapsedProfileIds.has(treeRow.profile.profileId)}
      collapsedSessionIds={expandedSessionIds}
      visibleSessionLimit={getVisibleSessionLimit(treeRow.profile.profileId)}
      expandedWorkerListSessionIds={expandedWorkerListSessionIds}
      onToggleProfileCollapsed={() => toggleProfileCollapsed(treeRow.profile.profileId)}
      onToggleSessionCollapsed={toggleSessionCollapsed}
      onShowMoreSessions={() => showMoreSessions(treeRow.profile.profileId)}
      onShowLessSessions={() => showLessSessions(treeRow.profile.profileId)}
      onToggleWorkerListExpanded={toggleWorkerListExpanded}
      onSelect={handleSelectAgent}
      onDeleteAgent={onDeleteAgent}
      onDeleteManager={onDeleteManager}
      onOpenSettings={handleOpenSettings}
      onOpenProjectSecrets={onOpenProjectSecrets ? handleOpenProjectSecrets : undefined}
      onCreateSession={onCreateSession ? handleRequestCreateSession : undefined}
      onStopSession={onStopSession}
      onResumeSession={onResumeSession}
      onDeleteSession={handleRequestDelete}
      onArchiveSession={onArchiveSession}
      onArchiveProfile={onArchiveProfile}
      onRequestRenameSession={handleRequestRename}
      onRequestRenameProfile={onRenameProfile ? handleRequestRenameProfile : undefined}
      onForkSession={onForkSession ? handleForkSetTarget : undefined}
      onMarkUnread={onMarkUnread}
      onMarkAllRead={onMarkAllRead}
      onChangeModel={onUpdateManagerModel ? handleRequestChangeModel : undefined}
      onChangeSessionModel={onUpdateSessionModel ? handleRequestSessionModelChange : undefined}
      onUseProjectDefault={onUpdateSessionModel ? handleUseProjectDefault : undefined}
      onChangeCwd={onUpdateManagerCwd ? handleRequestChangeCwd : undefined}
      showModelIcons={showModelIcons}
      highlightQuery={isSearchActive ? parsedSearch.term : undefined}
      dragHandleRef={dragHandleRef}
      dragHandleListeners={dragHandleListeners}
      dragHandleAttributes={dragHandleAttributes}
      onPromoteToProjectAgent={onSetSessionProjectAgent ? handlePromoteToProjectAgent : undefined}
      onOpenProjectAgentSharing={onGetProjectAgentSharing && onSetProjectAgentSharing ? handleOpenProjectAgentSharing : undefined}
      onOpenProjectAgentSettings={onSetSessionProjectAgent ? handleOpenProjectAgentSettings : undefined}
      onPinSession={onPinSession}
      onDemoteProjectAgent={onSetSessionProjectAgent ? handleDemoteProjectAgent : undefined}
      onCreateAgentCreator={onCreateAgentCreator}
      mutedAgents={mutedAgentsState}
      onToggleMute={handleToggleMute}
      onMuteAllSessions={handleMuteAllSessions}
      getCreatorAttribution={getCreatorAttribution}
      hideCliSessions={hideCliSessions}
      onToggleHideCliSessions={handleToggleHideCliSessions}
      inactiveRepoProjectAgents={getEntriesForProfile(treeRow.profile.profileId)}
      selectedInactiveRepoEntryKey={selectedInactiveRepoEntryKey}
      onSelectInactiveRepoProjectAgent={wsUrl ? handleSelectInactiveRepoProjectAgent : undefined}
    />
  ), [
    statuses, unreadCounts, localSelectedAgentId, isSettingsActive, isSearchActive,
    collapsedProfileIds, expandedSessionIds, expandedWorkerListSessionIds,
    toggleProfileCollapsed, toggleSessionCollapsed, showMoreSessions, showLessSessions,
    toggleWorkerListExpanded, handleSelectAgent, onDeleteAgent, onDeleteManager, handleOpenSettings,
    onOpenProjectSecrets, handleOpenProjectSecrets,
    onCreateSession, handleRequestCreateSession, onStopSession, onResumeSession, handleRequestDelete,
    onArchiveSession, onArchiveProfile,
    handleRequestRename, onRenameProfile, handleRequestRenameProfile, onForkSession, handleForkSetTarget,
    onMarkUnread, onMarkAllRead, onUpdateManagerModel, handleRequestChangeModel,
    onUpdateSessionModel, handleRequestSessionModelChange, handleUseProjectDefault,
    onUpdateManagerCwd, handleRequestChangeCwd, showModelIcons, parsedSearch.term,
    getVisibleSessionLimit,
    onSetSessionProjectAgent, handlePromoteToProjectAgent, handleOpenProjectAgentSharing,
    onGetProjectAgentSharing, onSetProjectAgentSharing, handleOpenProjectAgentSettings,
    onPinSession, handleDemoteProjectAgent, onCreateAgentCreator, mutedAgentsState,
    handleToggleMute, handleMuteAllSessions, getCreatorAttribution,
    hideCliSessions, handleToggleHideCliSessions,
    getEntriesForProfile, selectedInactiveRepoEntryKey, wsUrl, handleSelectInactiveRepoProjectAgent,
  ])

  const mixedProjectContent = useCallback((
    row: MixedProjectRow,
    dragHandleRef?: (element: HTMLElement | null) => void,
    dragHandleListeners?: DraggableSyntheticListeners,
    dragHandleAttributes?: DraggableAttributes,
  ) => {
    if (row.kind === 'local') {
      return profileGroupContent(row.treeRow, dragHandleRef, dragHandleListeners, dragHandleAttributes)
    }
    const isActiveOrigin = row.origin.originId === (activeOriginId ?? LOCAL_ORIGIN_ID)
    return (
      <RemoteProfileRow
        originId={row.origin.originId}
        treeRow={row.treeRow}
        selectedAgentId={isActiveOrigin ? selectedAgentId : null}
        isActiveOrigin={isActiveOrigin}
        instanceName={row.origin.instanceName}
        dragHandleRef={dragHandleRef}
        dragHandleListeners={dragHandleListeners}
        dragHandleAttributes={dragHandleAttributes}
        onSelectAgent={handleSelectRemoteAgent}
        onChangeCwd={handleRequestRemoteChangeCwd}
      />
    )
  }, [
    activeOriginId,
    handleRequestRemoteChangeCwd,
    handleSelectRemoteAgent,
    profileGroupContent,
    selectedAgentId,
  ])

  const sidebarContent = (
    <aside
      data-tour="sidebar"
      className={cn(
        'flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
        'max-md:w-full md:w-[20rem] md:min-w-[20rem] md:shrink-0',
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-sidebar-border px-2 py-2">
        {collaborationModeSwitch ? (
          /* Collab-enabled: mode toggle fills the header row */
          <ModeSwitch
            activeSurface={collaborationModeSwitch.activeSurface}
            onSelectSurface={collaborationModeSwitch.onSelectSurface}
            className="flex-1"
          />
        ) : (
          /* Default: "New Project" button + status dot */
          <>
            <button
              type="button"
              onClick={onAddManager}
              className="flex min-h-[44px] flex-1 items-center gap-2 rounded-md p-2 text-sm transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
              title="Create project"
              aria-label="Add project"
            >
              <SquarePen aria-hidden="true" className="h-4 w-4" />
              <span>New Project</span>
            </button>
            <div className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground">
              <span
                className={cn(
                  'inline-block size-1.5 rounded-full',
                  connected ? 'bg-emerald-500' : 'bg-amber-500',
                )}
                title={connected ? 'Connected' : 'Reconnecting'}
              />
              <span className="hidden xl:inline">{connected ? 'Live' : 'Retrying'}</span>
            </div>
          </>
        )}
        {onMobileClose ? (
          <button
            type="button"
            onClick={onMobileClose}
            className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground md:hidden"
            aria-label="Close sidebar"
          >
            <X className="size-5" />
          </button>
        ) : null}
      </div>

      <div
        className="flex flex-1 flex-col overflow-y-auto px-2 pb-2 [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sidebar-border [&::-webkit-scrollbar-thumb:hover]:bg-sidebar-border/80"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--sidebar-border) transparent',
        }}
      >
        {/* Pinned Cortex entry — modest inset beneath Builder/Collab switch */}
        {cortexRow ? (
          <div className="mt-2">
            <CortexSection
              cortexRow={cortexRow}
              statuses={statuses}
              unreadCounts={unreadCounts}
              selectedAgentId={localSelectedAgentId}
              isSettingsActive={isSettingsActive}
              isCollapsed={isSearchActive ? false : collapsedProfileIds.has('cortex')}
              collapsedSessionIds={expandedSessionIds}
              visibleSessionLimit={getVisibleSessionLimit('cortex')}
              expandedWorkerListSessionIds={expandedWorkerListSessionIds}
              onToggleCollapsed={() => toggleProfileCollapsed(cortexRow.profile.profileId)}
              onToggleSessionCollapsed={toggleSessionCollapsed}
              onShowMoreSessions={() => showMoreSessions(cortexRow.profile.profileId)}
              onShowLessSessions={() => showLessSessions(cortexRow.profile.profileId)}
              onToggleWorkerListExpanded={toggleWorkerListExpanded}
              onSelect={handleSelectAgent}
              onDeleteAgent={onDeleteAgent}
              onOpenSettings={handleOpenSettings}
              onStopSession={onStopSession}
              onResumeSession={onResumeSession}
              onMarkUnread={onMarkUnread}
              onMarkAllRead={onMarkAllRead}
              highlightQuery={isSearchActive ? parsedSearch.term : undefined}
              mutedAgents={mutedAgentsState}
              onToggleMute={handleToggleMute}
              onMuteAllSessions={handleMuteAllSessions}
            />
          </div>
        ) : null}

        {/* Search bar below Cortex, above profile sections */}
        <SidebarSearch
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchInputRef={searchInputRef}
          rightAction={collaborationModeSwitch ? (
            <button
              type="button"
              onClick={onAddManager}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
              title="Create project"
              aria-label="Add project"
            >
              <SquarePen aria-hidden="true" className="size-3.5" />
            </button>
          ) : undefined}
        />

        <ProjectViewSwitcher
          options={projectViewOptions}
          views={projectViews}
          activeView={activeView}
          onSelectView={setActiveView}
          onSaveView={saveView}
          onDeleteView={deleteView}
        />

        {isSearchActive ? (
          <div className="px-1 pb-1">
            <h2 className="text-xs font-semibold text-muted-foreground">
              {combinedMatchCount} match{combinedMatchCount !== 1 ? 'es' : ''}
            </h2>
          </div>
        ) : null}

        {isSearchActive && mixedProjectRows.length === 0 && !cortexRow ? (
          <p className="rounded-md px-3 py-4 text-center text-xs text-muted-foreground">
            No matches found.
          </p>
        ) : mixedProjectRows.length === 0 && !isSearchActive ? (
          <p className="rounded-md bg-sidebar-accent/50 px-3 py-4 text-center text-xs text-muted-foreground">
            {activeView
              ? `No projects are currently available in “${activeView.name}”.`
              : 'No active agents.'}
          </p>
        ) : (() => {
          const dndEnabled = !activeView && !isSearchActive && Boolean(onMoveBuilderProject) && mixedProjectRows.length > 1
          const sortableIds = mixedProjectRows.map((row) => builderSidebarOrderKey(row.ref))
          const activeDragRow = activeDragId
            ? mixedProjectRows.find((row) => builderSidebarOrderKey(row.ref) === activeDragId)
            : null

          if (dndEnabled) {
            return (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={(event) => setActiveDragId(String(event.active.id))}
                onDragCancel={() => setActiveDragId(null)}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                  <ul className="mt-2 space-y-1" data-testid="unified-project-list">
                    {mixedProjectRows.map((row) => {
                      const sortableId = builderSidebarOrderKey(row.ref)
                      const remoteIsActive = row.kind === 'remote'
                        && row.origin.originId === (activeOriginId ?? LOCAL_ORIGIN_ID)
                      const remoteMemoDependencies = row.kind === 'remote'
                        ? [
                            row,
                            remoteIsActive,
                            remoteIsActive ? selectedAgentId : null,
                            handleSelectRemoteAgent,
                          ]
                        : undefined
                      return (
                        <SortableProfileGroup
                          key={sortableId}
                          sortableId={sortableId}
                          memoDependencies={remoteMemoDependencies}
                        >
                          {(dragHandleRef, dragHandleListeners, dragHandleAttributes) => (
                            mixedProjectContent(
                              row,
                              dragHandleRef,
                              dragHandleListeners,
                              dragHandleAttributes,
                            )
                          )}
                        </SortableProfileGroup>
                      )
                    })}
                  </ul>
                </SortableContext>
                <DragOverlay>
                  {activeDragRow ? (
                    <div className="rounded-md border border-sidebar-border bg-sidebar shadow-lg">
                      <div className="flex items-center gap-1.5 px-3 py-2">
                        {activeDragRow.kind === 'remote' ? (
                          <Globe aria-hidden="true" className="size-3.5 shrink-0 text-blue-400" />
                        ) : null}
                        <span className="text-sm font-semibold">{activeDragRow.treeRow.profile.displayName}</span>
                      </div>
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            )
          }

          return (
            <ul className="mt-2 space-y-1" data-testid="unified-project-list">
              {mixedProjectRows.map((row) => (
                <li key={builderSidebarOrderKey(row.ref)}>
                  {mixedProjectContent(row)}
                </li>
              ))}
            </ul>
          )
        })()}

        {/* Status-only rows for remote origins without visible projects. */}
        <RemoteOriginSections
          originIds={isSearchActive ? [] : remoteOriginsWithoutProjects}
          onSignIn={onRemoteOriginSignIn}
          onRetry={onRemoteOriginRetry}
        />

        {/* Archive button pinned to the bottom; outer pad creates gap above the divider */}
        {onOpenArchive && hasArchivedItems && !activeView ? (
          <div className="mt-auto pt-2.5">
            <div className="border-t border-sidebar-border pt-1.5">
              <button
                type="button"
                onClick={onOpenArchive}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                  isArchiveActive
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                )}
                aria-current={isArchiveActive ? 'page' : undefined}
              >
                <Archive className="size-4" aria-hidden="true" />
                <span>Archive</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <SidebarFooter
        isSettingsActive={isSettingsActive}
        isStatsActive={isStatsActive}
        showProviderUsage={showProviderUsage}
        providerUsage={providerUsage}
        providerUsageLoading={providerUsageLoading}
        usagePanelOpen={usagePanelOpen}
        onToggleUsagePanel={handleToggleUsagePanel}
        onCloseUsagePanel={handleCloseUsagePanel}
        onRefetchProviderUsage={refetchProviderUsage}
        onOpenSettings={handleOpenSettings}
        onOpenStats={handleOpenStats}
      />
    </aside>
  )

  return (
    <>
      {/* Desktop: render inline */}
      <div className="hidden md:flex md:shrink-0">
        {sidebarContent}
      </div>

      {/* Mobile: render as overlay */}
      <div
        className={cn(
          'fixed inset-0 z-40 md:hidden',
          isMobileOpen ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <div
          className={cn(
            'absolute inset-0 bg-black/50 transition-opacity duration-200',
            isMobileOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={onMobileClose}
          aria-hidden="true"
        />
        <div
          className={cn(
            'relative z-10 h-full w-full transition-transform duration-200 ease-out',
            isMobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          {sidebarContent}
        </div>
      </div>

      {/* Create session dialog */}
      {createTarget ? (
        <CreateSessionDialog
          profileId={createTarget.profileId}
          profileLabel={createTarget.profileLabel}
          onConfirm={handleConfirmCreateSession}
          onClose={() => setCreateTarget(null)}
        />
      ) : null}

      {/* Rename session dialog */}
      {renameTarget ? (
        <RenameSessionDialog
          agentId={renameTarget.agentId}
          currentLabel={renameTarget.label}
          onConfirm={handleConfirmRename}
          onClose={() => setRenameTarget(null)}
        />
      ) : null}

      {/* Rename profile dialog */}
      {renameProfileTarget ? (
        <RenameProfileDialog
          profileId={renameProfileTarget.profileId}
          currentName={renameProfileTarget.displayName}
          onConfirm={handleConfirmRenameProfile}
          onClose={() => setRenameProfileTarget(null)}
        />
      ) : null}

      {/* Delete session confirmation dialog */}
      {deleteTarget ? (
        <DeleteSessionDialog
          agentId={deleteTarget.agentId}
          sessionLabel={deleteTarget.label}
          onConfirm={handleConfirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}

      {/* Fork session dialog */}
      {forkTarget && onForkSession ? (
        <ForkSessionDialog
          onConfirm={(name) => {
            onForkSession(forkTarget.sourceAgentId, name)
            setForkTarget(null)
          }}
          onClose={() => setForkTarget(null)}
        />
      ) : null}

      {/* Change model dialog */}
      {changeModelTarget && onUpdateManagerModel ? (
        <ChangeModelDialog
          wsUrl={wsUrl}
          profileId={changeModelTarget.profileId}
          profileLabel={changeModelTarget.profileLabel}
          currentModel={changeModelTarget.currentModel}
          currentReasoningLevel={changeModelTarget.currentReasoningLevel}
          onConfirm={handleConfirmChangeModel}
          onClose={() => setChangeModelTarget(null)}
        />
      ) : null}

      {/* Session model dialog */}
      {sessionModelTarget && onUpdateSessionModel ? (
        <SessionModelDialog
          wsUrl={wsUrl}
          sessionAgentId={sessionModelTarget.sessionAgentId}
          sessionLabel={sessionModelTarget.sessionLabel}
          currentModel={sessionModelTarget.currentModel}
          currentReasoningLevel={sessionModelTarget.currentReasoningLevel}
          modelOrigin={sessionModelTarget.modelOrigin}
          profileDefaultModel={sessionModelTarget.profileDefaultModel}
          onConfirm={handleConfirmSessionModelChange}
          onClose={() => setSessionModelTarget(null)}
        />
      ) : null}

      {/* Change CWD dialog */}
      {changeCwdTarget && (onUpdateManagerCwd || changeCwdTarget.originId !== LOCAL_ORIGIN_ID) ? (
        <ChangeCwdDialog
          profileId={changeCwdTarget.profileId}
          profileLabel={changeCwdTarget.profileLabel}
          currentCwd={changeCwdTarget.currentCwd}
          onConfirm={handleConfirmChangeCwd}
          onClose={() => setChangeCwdTarget(null)}
          onBrowseDirectory={
            changeCwdTarget.originId === LOCAL_ORIGIN_ID && !directServerDirectoryBrowser
              ? onBrowseDirectory
              : undefined
          }
          serverDirectoryBrowser={changeCwdServerBrowser}
          onValidateDirectory={changeCwdValidateDirectory}
        />
      ) : null}

      {/* Project Agent sharing dialog */}
      {projectAgentSharingTarget && onGetProjectAgentSharing && onSetProjectAgentSharing ? (
        <ProjectAgentSharingDialog
          agentId={projectAgentSharingTarget.agentId}
          sessionLabel={projectAgentSharingTarget.sessionLabel}
          currentProjectAgent={projectAgentSharingTarget.currentProjectAgent}
          onClose={() => setProjectAgentSharingTarget(null)}
          onGetProjectAgentSharing={onGetProjectAgentSharing}
          onSetProjectAgentSharing={onSetProjectAgentSharing}
        />
      ) : null}

      {/* Project Agent settings sheet */}
      {projectAgentTarget && onSetSessionProjectAgent ? (
        <ProjectAgentSettingsSheet
          agentId={projectAgentTarget.agentId}
          sessionLabel={projectAgentTarget.sessionLabel}
          currentProjectAgent={projectAgentTarget.currentProjectAgent}
          onSave={handleSaveProjectAgent}
          onDemote={handleDemoteProjectAgent}
          onClose={() => setProjectAgentTarget(null)}
          onGetProjectAgentConfig={onGetProjectAgentConfig}
          onGetProjectAgentSharing={onGetProjectAgentSharing}
          onSetProjectAgentSharing={onSetProjectAgentSharing}
          onListReferences={onListProjectAgentReferences}
          onGetReference={onGetProjectAgentReference}
          onSetReference={onSetProjectAgentReference}
          onDeleteReference={onDeleteProjectAgentReference}
          onRequestRecommendations={onRequestProjectAgentRecommendations}
        />
      ) : null}

      {inactiveRepoActivationTarget && wsUrl ? (
        <ActivateRepoProjectAgentSheet
          wsUrl={wsUrl}
          profileId={inactiveRepoActivationTarget.profileId}
          sessionAgentId={inactiveRepoActivationTarget.sessionAgentId}
          item={inactiveRepoActivationTarget.item}
          onClose={() => {
            setInactiveRepoActivationTarget(null)
            setSelectedInactiveRepoEntryKey(null)
          }}
          onActivated={handleInactiveRepoProjectAgentActivated}
        />
      ) : null}
    </>
  )
})
