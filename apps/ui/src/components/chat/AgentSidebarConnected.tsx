/**
 * Origin-slice-connected wrapper for {@link AgentSidebar} (WP-U1).
 *
 * The sidebar tree/counts are the highest-churn consumer of the whole-snapshot
 * path: every WS event (worker-status ticks especially) used to replace the
 * entire `ManagerWsState` and re-render the sidebar through BuilderSurface.
 * This container subscribes to ONLY the sidebar's domain slices
 * (`agents / profiles / statuses / unreadCounts / connected / terminal*`) from
 * the local origin store via `useOriginSlice`, so a change to an unrelated
 * slice (e.g. `messages`) never wakes the sidebar, and a `statuses`-only tick
 * re-renders just this subtree instead of the whole app.
 *
 * Non-slice inputs (selection, route flags, command callbacks) stay props from
 * BuilderSurface.  BuilderSurface no longer threads the domain slices through —
 * they are read here, off the registry.
 */

import { memo } from 'react'
import { AgentSidebar } from './AgentSidebar'
import type { AgentSidebarProps, StatusMap } from './agent-sidebar/types'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import {
  LOCAL_ORIGIN_ID,
  useOriginSlice,
  useRemoteOriginIds,
  type OriginId,
} from '@/lib/origin-store'
import type { ManagerWsState } from '@/lib/ws-state'

/** Props sourced from the store, injected by this container (not passed in). */
type StoreProvidedProps =
  | 'connected'
  | 'agents'
  | 'profiles'
  | 'statuses'
  | 'unreadCounts'
  | 'terminalScopeId'
  | 'terminalCount'
  | 'remoteOriginIds'

export interface AgentSidebarConnectedProps
  extends Omit<AgentSidebarProps, StoreProvidedProps> {
  /** Origin whose sidebar slices to render.  Defaults to the local origin. */
  originId?: OriginId
  /**
   * Wave R: when a REMOTE origin is active, the local tree renders
   * select-only — its row actions are bound to the active origin's client and
   * would misroute. Row actions return when the local origin is active again.
   */
  localTreeReadOnly?: boolean
}

/** Optional mutation handlers stripped in read-only mode (Wave R R1). */
const LOCAL_TREE_MUTATION_PROPS = [
  'onCreateSession',
  'onStopSession',
  'onResumeSession',
  'onDeleteSession',
  'onArchiveSession',
  'onArchiveProfile',
  'onRenameSession',
  'onPinSession',
  'onRenameProfile',
  'onForkSession',
  'onMarkUnread',
  'onMarkAllRead',
  'onUpdateManagerModel',
  'onUpdateSessionModel',
  'onUpdateManagerCwd',
  'onReorderProfiles',
  'onSetSessionProjectAgent',
  'onSetProjectAgentSharing',
  'onSetProjectAgentReference',
  'onDeleteProjectAgentReference',
  'onRequestProjectAgentRecommendations',
  'onCreateAgentCreator',
] as const

// Stable slice selectors (module-level so their identity is fixed and the store
// can share the memoized selection across renders).
const selectAgents = (s: ManagerWsState): AgentDescriptor[] => s.agents
const selectProfiles = (s: ManagerWsState): ManagerProfile[] => s.profiles
const selectStatuses = (s: ManagerWsState): StatusMap => s.statuses
const selectUnreadCounts = (s: ManagerWsState): Record<string, number> => s.unreadCounts
const selectConnected = (s: ManagerWsState): boolean => s.connected
const selectTerminalScopeId = (s: ManagerWsState): string | null => s.terminalSessionScopeId
const selectTerminalCount = (s: ManagerWsState): number => s.terminals.length

export const AgentSidebarConnected = memo(function AgentSidebarConnected({
  originId = LOCAL_ORIGIN_ID,
  localTreeReadOnly = false,
  ...rest
}: AgentSidebarConnectedProps) {
  // Each slice is an independent subscription: the store only wakes this
  // component for the slices that actually changed identity.  `agents` /
  // `profiles` / `statuses` / `unreadCounts` are replaced by-reference on the
  // relevant events, so `Object.is` is the correct (and cheapest) equality.
  const agents = useOriginSlice(originId, selectAgents, { selectorKey: 'sidebar.agents' })
  const profiles = useOriginSlice(originId, selectProfiles, { selectorKey: 'sidebar.profiles' })
  const statuses = useOriginSlice(originId, selectStatuses, { selectorKey: 'sidebar.statuses' })
  const unreadCounts = useOriginSlice(originId, selectUnreadCounts, { selectorKey: 'sidebar.unreadCounts' })
  const connected = useOriginSlice(originId, selectConnected, { selectorKey: 'sidebar.connected' })
  const terminalScopeId = useOriginSlice(originId, selectTerminalScopeId, { selectorKey: 'sidebar.terminalScopeId' })
  const terminalCount = useOriginSlice(originId, selectTerminalCount, { selectorKey: 'sidebar.terminalCount' })
  const remoteOriginIds = useRemoteOriginIds()

  let effectiveProps: Omit<AgentSidebarProps, StoreProvidedProps> = rest
  if (localTreeReadOnly) {
    const stripped = { ...rest }
    for (const key of LOCAL_TREE_MUTATION_PROPS) {
      delete (stripped as Record<string, unknown>)[key]
    }
    // Required handlers cannot be omitted; neutralize them instead.
    stripped.onDeleteAgent = noop
    stripped.onDeleteManager = noop
    effectiveProps = stripped
  }

  return (
    <AgentSidebar
      {...effectiveProps}
      connected={connected}
      agents={agents}
      profiles={profiles}
      statuses={statuses}
      unreadCounts={unreadCounts}
      terminalScopeId={terminalScopeId}
      terminalCount={terminalCount}
      remoteOriginIds={remoteOriginIds}
    />
  )
})

function noop(): void {}
