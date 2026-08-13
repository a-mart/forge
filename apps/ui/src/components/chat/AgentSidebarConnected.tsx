/**
 * Origin-slice-connected wrapper for {@link AgentSidebar}.
 *
 * Structural discovery subscribes only to connection/agent/profile snapshots.
 * Hot remote status, unread, and meta values are subscribed inside memoized
 * remote rows; ordering is always loaded/written through the local API.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  AgentDescriptor,
  BuilderSidebarOrderRef,
  ManagerProfile,
} from '@forge/protocol'
import { AgentSidebar } from './AgentSidebar'
import { CortexRailItem } from './agent-sidebar/CortexRailItem'
import { ActivityRail, type ActivityRailItem } from '@/components/index-page/ActivityRail'
import type {
  AgentSidebarProps,
  RemoteSidebarOrigin,
  StatusMap,
} from './agent-sidebar/types'
import { getRemoteVisibleProfileRows } from './agent-sidebar/RemoteOriginSections.utils'
import {
  buildProfileTreeRows,
  isCortexProfile,
  type ProfileTreeRow,
} from '@/lib/agent-hierarchy'
import { useSidebarLayout } from './agent-sidebar/hooks'
import {
  LOCAL_ORIGIN_ID,
  useAllOrigins,
  useOriginSlice,
} from '@/lib/origin-store'
import type { ManagerWsState } from '@/lib/ws-state'
import {
  BuilderSidebarOrderApiUnavailableError,
  type BuilderSidebarOrderApi,
} from '@/lib/builder-sidebar-order-api'
import { BuilderSidebarOrderStore } from '@/lib/builder-sidebar-order-store'
import {
  builderSidebarOrderKey,
  reconcileBuilderSidebarOrder,
} from '@/lib/builder-sidebar-order'

/** Props sourced from origin stores, injected by this container. */
type StoreProvidedProps =
  | 'connected'
  | 'agents'
  | 'profiles'
  | 'treeRows'
  | 'statuses'
  | 'unreadCounts'
  | 'terminalScopeId'
  | 'terminalCount'
  | 'remoteOrigins'
  | 'builderSidebarOrder'
  | 'onMoveBuilderProject'

export interface AgentSidebarConnectedProps
  extends Omit<AgentSidebarProps, StoreProvidedProps> {
  /** Must be constructed against the local Builder target by BuilderSurface. */
  builderSidebarOrderApi?: BuilderSidebarOrderApi
  /** Workspace rail is composed here so the Cortex navigator can share local Builder state. */
  activityRailItems?: ActivityRailItem[]
}

interface SidebarOriginStructure {
  connected: boolean
  agents: AgentDescriptor[]
  profiles: ManagerProfile[]
}

const EMPTY_STRUCTURE: SidebarOriginStructure = {
  connected: false,
  agents: [],
  profiles: [],
}

const VOLATILE_AGENT_DESCRIPTOR_FIELDS = new Set([
  'activeWorkerCount',
  'contextUsage',
  'status',
  'streamingStartedAt',
])

const selectSidebarStructure = (state: ManagerWsState): SidebarOriginStructure => ({
  connected: state.connected,
  agents: state.agents,
  profiles: state.profiles,
})
const selectAgents = (state: ManagerWsState): AgentDescriptor[] => state.agents
const selectStatuses = (state: ManagerWsState): StatusMap => state.statuses
const selectUnreadCounts = (state: ManagerWsState): Record<string, number> => state.unreadCounts
const selectTerminalScopeId = (state: ManagerWsState): string | null => state.terminalSessionScopeId
const selectTerminalCount = (state: ManagerWsState): number => state.terminals.length
const selectConnectionEpoch = (state: ManagerWsState): number => state.connectionEpoch
const selectBuilderSidebarOrderRevision = (state: ManagerWsState): number | null => (
  state.builderSidebarOrderRevision
)

function equalSidebarStructure(left: SidebarOriginStructure, right: SidebarOriginStructure): boolean {
  return left.connected === right.connected
    && left.profiles === right.profiles
    && equalStructuralAgentDescriptors(left.agents, right.agents)
}

function equalStructuralAgentDescriptors(
  left: readonly AgentDescriptor[],
  right: readonly AgentDescriptor[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false

  return left.every((leftAgent, index) => {
    const rightAgent = right[index]
    if (!rightAgent || leftAgent === rightAgent) return Boolean(rightAgent)
    const leftRecord = leftAgent as unknown as Record<string, unknown>
    const rightRecord = rightAgent as unknown as Record<string, unknown>
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])
    for (const key of keys) {
      if (VOLATILE_AGENT_DESCRIPTOR_FIELDS.has(key)) continue
      if (!Object.is(leftRecord[key], rightRecord[key])) return false
    }
    return true
  })
}

const subscribeNoop = () => () => undefined
const getNullOrder = () => null
const EMPTY_TREE_ROWS: ProfileTreeRow[] = []

type ApiAvailability = 'unknown' | 'available' | 'unavailable'

export const AgentSidebarConnected = memo(function AgentSidebarConnected({
  builderSidebarOrderApi,
  activityRailItems,
  ...rest
}: AgentSidebarConnectedProps) {
  const sidebarLayout = useSidebarLayout()
  const roomsV2 = sidebarLayout === 'rooms-v2'
  const originStructures = useAllOrigins(selectSidebarStructure, {
    selectorKey: 'sidebar.structure',
    equalityFn: equalSidebarStructure,
  })
  const localStructure = originStructures.find((entry) => entry.originId === LOCAL_ORIGIN_ID)?.value
    ?? EMPTY_STRUCTURE
  const { profiles, connected } = localStructure
  // Local actions still receive live descriptors; the cross-origin tree model
  // below is held stable when only volatile worker status/count fields change.
  const agents = useOriginSlice(LOCAL_ORIGIN_ID, selectAgents, { selectorKey: 'sidebar.agents' })
  const statuses = useOriginSlice(LOCAL_ORIGIN_ID, selectStatuses, { selectorKey: 'sidebar.statuses' })
  const unreadCounts = useOriginSlice(LOCAL_ORIGIN_ID, selectUnreadCounts, {
    selectorKey: 'sidebar.unreadCounts',
  })
  const terminalScopeId = useOriginSlice(LOCAL_ORIGIN_ID, selectTerminalScopeId, {
    selectorKey: 'sidebar.terminalScopeId',
  })
  const terminalCount = useOriginSlice(LOCAL_ORIGIN_ID, selectTerminalCount, {
    selectorKey: 'sidebar.terminalCount',
  })
  const connectionEpoch = useOriginSlice(LOCAL_ORIGIN_ID, selectConnectionEpoch, {
    selectorKey: 'sidebar.connectionEpoch',
  })
  const invalidatedRevision = useOriginSlice(
    LOCAL_ORIGIN_ID,
    selectBuilderSidebarOrderRevision,
    { selectorKey: 'sidebar.builderSidebarOrderRevision' },
  )
  // Build each origin's active tree once per structural snapshot. The custom
  // equality above preserves these identities across production agent_status
  // updates even though that reducer replaces descriptor-array references.
  const originTreeModels = useMemo(() => originStructures.map((entry) => ({
    originId: entry.originId,
    treeRows: buildProfileTreeRows(entry.value.agents, entry.value.profiles),
  })), [originStructures])
  const structuralLocalTreeRows = originTreeModels.find(
    (entry) => entry.originId === LOCAL_ORIGIN_ID,
  )?.treeRows ?? EMPTY_TREE_ROWS
  // Overlay local volatile descriptor changes for local badges/status fallbacks
  // without feeding those identities back into structural discovery.
  const localTreeRows = useMemo(
    () => buildProfileTreeRows(agents, profiles),
    [agents, profiles],
  )
  const cortexRow = useMemo(
    () => localTreeRows.find((row) => isCortexProfile(row)) ?? null,
    [localTreeRows],
  )
  const remoteOrigins = useMemo<RemoteSidebarOrigin[]>(() => {
    const modelByOrigin = new Map(originTreeModels.map((entry) => [entry.originId, entry]))
    return originStructures
      .filter((entry) => entry.originId !== LOCAL_ORIGIN_ID)
      .map((entry) => ({
        originId: entry.originId,
        connected: entry.value.connected,
        treeRows: getRemoteVisibleProfileRows(
          modelByOrigin.get(entry.originId)?.treeRows ?? EMPTY_TREE_ROWS,
        ),
      }))
  }, [originStructures, originTreeModels])

  const discoveredOrder = useMemo<BuilderSidebarOrderRef[]>(() => {
    const localRefs = structuralLocalTreeRows
      .filter(isOrderableLocalRow)
      .map((row) => ({ originId: LOCAL_ORIGIN_ID, profileId: row.profile.profileId }))
    const remoteRefs = remoteOrigins.flatMap((origin) => (
      origin.connected
        ? origin.treeRows.map((row) => ({
            originId: origin.originId,
            profileId: row.profile.profileId,
          }))
        : []
    ))
    return [...localRefs, ...remoteRefs]
  }, [remoteOrigins, structuralLocalTreeRows])

  const structuralOrderKey = useMemo(
    () => JSON.stringify(discoveredOrder.map(builderSidebarOrderKey)),
    [discoveredOrder],
  )

  const orderStore = useMemo(
    () => builderSidebarOrderApi ? new BuilderSidebarOrderStore(builderSidebarOrderApi) : null,
    [builderSidebarOrderApi],
  )
  const storedOrder = useSyncExternalStore(
    orderStore?.subscribe ?? subscribeNoop,
    orderStore?.getSnapshot ?? getNullOrder,
    orderStore?.getSnapshot ?? getNullOrder,
  )
  const [apiAvailability, setApiAvailability] = useState<ApiAvailability>('unknown')

  const refreshOrder = useCallback((minimumRevision = 0, resetAuthority = false) => {
    if (!orderStore) return
    void orderStore.refresh(minimumRevision, { resetAuthority }).then(() => {
      setApiAvailability('available')
    }).catch((error: unknown) => {
      if (error instanceof BuilderSidebarOrderApiUnavailableError) {
        setApiAvailability('unavailable')
        return
      }
      console.warn('[builder-sidebar-order] Unable to load local preference:', error)
    })
  }, [orderStore])

  // Initial GET is registered alongside the WS invalidation subscription. The
  // store's minimum-revision floor closes an invalidation-vs-inflight-GET race.
  useEffect(() => {
    setApiAvailability('unknown')
    refreshOrder()
  }, [refreshOrder])

  const observedConnectionEpoch = useRef(connectionEpoch)
  useEffect(() => {
    if (connectionEpoch > observedConnectionEpoch.current) {
      setApiAvailability('unknown')
      refreshOrder(0, true)
    }
    observedConnectionEpoch.current = connectionEpoch
  }, [connectionEpoch, refreshOrder])

  useEffect(() => {
    if (invalidatedRevision !== null) refreshOrder(invalidatedRevision)
  }, [invalidatedRevision, refreshOrder])

  useEffect(() => {
    const onFocus = () => refreshOrder()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshOrder])

  // Deliberately key this effect by additive discovery + authoritative
  // revision, not optimistic/rollback order identity. A client's missing
  // origins/profiles never become instance-global deletion authority.
  const authoritativeRevision = storedOrder?.revision ?? null
  useEffect(() => {
    if (!orderStore || apiAvailability !== 'available' || authoritativeRevision === null) return
    void orderStore.ensureDiscovered(discoveredOrder).catch((error: unknown) => {
      if (error instanceof BuilderSidebarOrderApiUnavailableError) {
        setApiAvailability('unavailable')
        return
      }
      console.warn('[builder-sidebar-order] Unable to reconcile local preference:', error)
    })
  }, [
    apiAvailability,
    authoritativeRevision,
    discoveredOrder,
    orderStore,
    structuralOrderKey,
  ])

  const effectiveOrder = useMemo(
    () => reconcileBuilderSidebarOrder(storedOrder?.order ?? [], discoveredOrder),
    [discoveredOrder, storedOrder],
  )

  const handleMoveBuilderProject = useCallback((
    active: BuilderSidebarOrderRef,
    over: BuilderSidebarOrderRef,
  ) => {
    if (!orderStore) return
    void orderStore.move(active, over, discoveredOrder).catch((error: unknown) => {
      if (error instanceof BuilderSidebarOrderApiUnavailableError) {
        setApiAvailability('unavailable')
        return
      }
      console.warn('[builder-sidebar-order] Unable to save local preference:', error)
    })
  }, [discoveredOrder, orderStore])

  const dndAvailable = Boolean(
    orderStore
    && storedOrder
    && apiAvailability === 'available',
  )

  return (
    <>
      <AgentSidebar
        {...rest}
        connected={connected}
        agents={agents}
        profiles={profiles}
        treeRows={localTreeRows}
        statuses={statuses}
        unreadCounts={unreadCounts}
        terminalScopeId={terminalScopeId}
        terminalCount={terminalCount}
        remoteOrigins={remoteOrigins}
        builderSidebarOrder={effectiveOrder}
        onMoveBuilderProject={dndAvailable ? handleMoveBuilderProject : undefined}
      />
      {activityRailItems ? (
        <ActivityRail
          items={activityRailItems}
          roomsV2={roomsV2}
          cortex={roomsV2 && cortexRow ? (
            <CortexRailItem
              cortexRow={cortexRow}
              statuses={statuses}
              unreadCounts={unreadCounts}
              selectedAgentId={rest.selectedAgentId}
              isSettingsActive={rest.isSettingsActive}
              onSelect={rest.onSelectAgent}
              onDeleteAgent={rest.onDeleteAgent}
              onOpenSettings={rest.onOpenSettings}
              onStopSession={rest.onStopSession}
              onResumeSession={rest.onResumeSession}
              onMarkUnread={rest.onMarkUnread}
              onMarkAllRead={rest.onMarkAllRead}
              onRequestSessionWorkers={rest.onRequestSessionWorkers}
            />
          ) : undefined}
        />
      ) : null}
    </>
  )
})

function isOrderableLocalRow(row: ProfileTreeRow): boolean {
  return row.profile.profileType !== 'system' && !isCortexProfile(row)
}
