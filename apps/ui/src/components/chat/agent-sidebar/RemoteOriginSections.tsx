/**
 * Remote project rows and origin status cards for the unified Builder list.
 *
 * DnD deliberately does not live here: AgentSidebar owns one DndContext across
 * every local and remote project, and persistence always targets the local
 * Builder preference.
 */

import { memo, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, Globe } from 'lucide-react'
import type { SessionRow } from '@/lib/agent-hierarchy'
import {
  compositeKey,
  originRegistry,
  useOriginMeta,
  useOriginSlice,
  type OriginId,
  type OriginMetaState,
} from '@/lib/origin-store'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { SidebarCompactionBadge, SidebarRoomAvatar, SidebarStreamingWorkerBadge, SessionStatusDot } from './shared'
import { WorkerRow } from './WorkerRow'
import { MAX_VISIBLE_WORKERS } from './constants'
import { getProjectRoomSummary } from './utils'
import type { ManagerWsState } from '@/lib/ws-state'
import {
  equalRemoteProfileRowProps,
  type RemoteProfileRowProps,
} from './remote-profile-row-props'

export interface RemoteOriginSectionsProps {
  /** Origins which currently have no renderable project row. */
  originIds: OriginId[]
  /** Rooms renders the same remote state with its semantic sidebar tokens. */
  roomsV2?: boolean
  onSignIn?: (originId: OriginId) => void
  onRetry?: (originId: OriginId) => void
}

export function RemoteOriginSections({
  originIds,
  roomsV2 = false,
  onSignIn,
  onRetry,
}: RemoteOriginSectionsProps) {
  if (originIds.length === 0) return null

  return (
    <div className="mt-3 space-y-2" data-testid="remote-origin-sections">
      {originIds.map((originId) => (
        <RemoteOriginStatusSection
          key={originId}
          originId={originId}
          roomsV2={roomsV2}
          onSignIn={onSignIn}
          onRetry={onRetry}
        />
      ))}
    </div>
  )
}

type OriginHeaderState = 'connected' | 'connecting' | 'auth-required' | 'version-blocked' | 'unreachable' | 'disabled'

function deriveHeaderState(meta: OriginMetaState | null): OriginHeaderState {
  if (!meta) return 'connecting'
  if (meta.versionBlocked) return 'version-blocked'
  if (meta.authState === 'unauthorized') return 'auth-required'
  if (meta.connectionStatus === 'connected') return 'connected'
  if (meta.connectionStatus === 'connecting' || meta.authState === 'pending') return 'connecting'
  if (meta.lastError === 'Remote projects are disabled on this instance.') return 'disabled'
  return 'unreachable'
}

const HEADER_DOT_CLASS: Omit<Record<OriginHeaderState, string>, 'connected'> = {
  connecting: 'bg-amber-400 animate-pulse',
  'auth-required': 'bg-amber-500',
  'version-blocked': 'bg-red-500',
  unreachable: 'bg-red-500',
  disabled: 'bg-muted-foreground/50',
}

const ROOM_HEADER_DOT_CLASS: Omit<Record<OriginHeaderState, string>, 'connected'> = {
  connecting: 'sidebar-room-connection-status--reconnecting animate-pulse',
  'auth-required': 'sidebar-room-connection-status--reconnecting',
  'version-blocked': 'sidebar-room-status-error-dot',
  unreachable: 'sidebar-room-status-error-dot',
  disabled: 'sidebar-room-status-idle',
}

const HEADER_STATE_LABEL: Record<OriginHeaderState, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  'auth-required': 'Sign-in required',
  'version-blocked': 'Update Forge to connect',
  unreachable: 'Unreachable',
  disabled: 'Remote projects disabled',
}

const RemoteOriginStatusSection = memo(function RemoteOriginStatusSection({
  originId,
  roomsV2 = false,
  onSignIn,
  onRetry,
}: {
  originId: OriginId
  roomsV2?: boolean
  onSignIn?: (originId: OriginId) => void
  onRetry?: (originId: OriginId) => void
}) {
  const meta = useOriginMeta(originId)
  return (
    <RemoteOriginStatusCard
      originId={originId}
      roomsV2={roomsV2}
      state={deriveHeaderState(meta)}
      instanceName={meta?.instanceName?.trim() || 'Remote Forge'}
      onSignIn={onSignIn}
      onRetry={onRetry}
    />
  )
})

export const RemoteProfileRow = memo(function RemoteProfileRow({
  originId,
  treeRow,
  roomsV2 = false,
  selectedAgentId,
  isActiveOrigin,
  instanceName: fallbackInstanceName,
  dragHandleRef,
  dragHandleListeners,
  dragHandleAttributes,
  onSelectAgent,
  onChangeCwd,
}: RemoteProfileRowProps) {
  const { profile, sessions } = treeRow
  const [collapsed, setCollapsed] = useState(false)
  const meta = useOriginMeta(originId)
  const instanceName = meta?.instanceName?.trim() || fallbackInstanceName?.trim() || 'Remote Forge'
  const firstSession = sessions[0]?.sessionAgent
  const isHeaderSelected = isActiveOrigin && sessions.some((session) =>
    session.sessionAgent.agentId === selectedAgentId
    || session.workers.some((worker) => worker.agentId === selectedAgentId),
  )

  const currentCwd = firstSession?.cwd || sessions[0]?.sessionAgent.cwd || ''
  const selectRoomSummary = useMemo(() => (state: ManagerWsState) => {
    const agentsById = new Map(state.agents.map((agent) => [agent.agentId, agent]))
    const hydratedSessions = sessions.map((session) => ({
      ...session,
      sessionAgent: agentsById.get(session.sessionAgent.agentId) ?? session.sessionAgent,
    }))
    const summary = getProjectRoomSummary(hydratedSessions, state.statuses, state.unreadCounts)
    return `${summary.activeSessionCount}:${summary.visibleSessionCount}:${summary.unreadCount}`
  }, [sessions])
  const roomSummaryKey = useOriginSlice(originId, selectRoomSummary, {
    selectorKey: `sidebar.remote-room-summary.${profile.profileId}`,
  })
  const [activeSessionCount = 0, visibleSessionCount = 0, unreadCount = 0] = roomSummaryKey
    .split(':')
    .map((value) => Number(value))

  return (
    <div
      data-testid={`remote-profile-row-${compositeKey(originId, profile.profileId)}`}
      data-room-card={roomsV2 ? 'remote' : undefined}
      className={roomsV2 ? 'sidebar-room-card sidebar-room-remote-card' : undefined}
    >
      <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
        className={cn(
          roomsV2
            ? 'sidebar-room-header sidebar-room-remote-header'
            : 'relative flex items-center rounded-lg border bg-blue-500/[0.035] transition-colors',
          roomsV2
            ? isHeaderSelected ? 'sidebar-room-row-selected' : undefined
            : isHeaderSelected
              ? 'border-blue-400/45 ring-1 ring-blue-400/25'
              : 'border-blue-400/25 hover:border-blue-400/40',
        )}
      >
        <button
          type="button"
          ref={dragHandleRef}
          {...dragHandleAttributes}
          {...dragHandleListeners}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'}${dragHandleListeners ? ' or drag' : ''} remote project ${profile.displayName} on ${instanceName}`}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left transition-colors',
            roomsV2 ? 'py-1.5 pl-2 pr-1' : 'py-1.5 pl-2.5 pr-1.5',
            'hover:bg-sidebar-accent/50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
            dragHandleListeners ? 'cursor-grab active:cursor-grabbing' : '',
          )}
          style={dragHandleListeners ? { touchAction: 'none' } : undefined}
          title={`Remote project on ${instanceName}`}
        >
          {roomsV2 ? (
            collapsed
              ? <ChevronRight className="size-3 shrink-0 text-[var(--sidebar-room-remote-foreground)]" aria-hidden="true" />
              : <ChevronDown className="size-3 shrink-0 text-[var(--sidebar-room-remote-foreground)]" aria-hidden="true" />
          ) : null}
          {roomsV2 ? (
            <SidebarRoomAvatar label={profile.displayName} tone="blue" className="sidebar-room-project-avatar" />
          ) : null}
          <Globe aria-hidden="true" className={roomsV2 ? 'sidebar-room-remote-marker' : 'size-3.5 shrink-0 text-blue-400'} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">
            {profile.displayName}
          </span>
          {roomsV2 && unreadCount > 0 ? (
            <span className="sidebar-room-unread-badge" aria-label={`${unreadCount} unread messages in ${profile.displayName}`}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          ) : null}
          {roomsV2 ? (
            <span
              className="sidebar-room-counter"
              aria-label={`${activeSessionCount} of ${visibleSessionCount} sessions actively working`}
            >
              {activeSessionCount}/{visibleSessionCount}
            </span>
          ) : null}
        </button>
      </div>
      </ContextMenuTrigger>
      {onChangeCwd ? (
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => onChangeCwd(originId, profile.profileId, profile.displayName, currentCwd)}
          >
            <FolderOpen className="mr-2 size-3.5" />
            Change Working Directory
          </ContextMenuItem>
        </ContextMenuContent>
      ) : null}
      </ContextMenu>

      {!collapsed && sessions.length > 0 ? (
        <ul className={roomsV2 ? 'mt-0.5 space-y-px' : 'mt-1 space-y-0.5'}>
          {sessions.map((session) => (
            <RemoteSessionRow
              key={compositeKey(originId, session.sessionAgent.agentId)}
              originId={originId}
              session={session}
              selectedAgentId={isActiveOrigin ? selectedAgentId : null}
              roomsV2={roomsV2}
              onSelectAgent={onSelectAgent}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}, equalRemoteProfileRowProps)

const RemoteSessionRow = memo(function RemoteSessionRow({
  originId,
  session,
  selectedAgentId,
  roomsV2 = false,
  onSelectAgent,
}: {
  originId: OriginId
  session: SessionRow
  selectedAgentId: string | null
  roomsV2?: boolean
  onSelectAgent: (originId: OriginId, agentId: string) => void
}) {
  const { sessionAgent, workers, isDefault } = session
  const [collapsed, setCollapsed] = useState(true)
  const [isWorkerListExpanded, setWorkerListExpanded] = useState(false)
  const label = sessionAgent.sessionLabel || (isDefault ? 'Main' : sessionAgent.displayName || sessionAgent.agentId)
  const workerCount = sessionAgent.workerCount ?? workers.length
  const hasWorkers = workerCount > 0
  const isSelected = selectedAgentId === sessionAgent.agentId
  const hasSelectedWorker = workers.some((worker) => worker.agentId === selectedAgentId)
  const selectLiveStatus = useMemo(
    () => (state: ManagerWsState) => state.statuses[sessionAgent.agentId],
    [sessionAgent.agentId],
  )
  const selectActiveWorkerCount = useMemo(
    () => (state: ManagerWsState) => state.agents.find((agent) => agent.agentId === sessionAgent.agentId)?.activeWorkerCount
      ?? sessionAgent.activeWorkerCount
      ?? 0,
    [sessionAgent.activeWorkerCount, sessionAgent.agentId],
  )
  const selectUnreadCount = useMemo(
    () => (state: ManagerWsState) => state.unreadCounts[sessionAgent.agentId] ?? 0,
    [sessionAgent.agentId],
  )
  const selectedLiveStatus = useOriginSlice(originId, selectLiveStatus, {
    selectorKey: `sidebar.remote-session-status.${sessionAgent.agentId}`,
  })
  const liveStatus = selectedLiveStatus?.status ?? sessionAgent.status
  const activeWorkerCount = useOriginSlice(originId, selectActiveWorkerCount, {
    selectorKey: `sidebar.remote-session-active-workers.${sessionAgent.agentId}`,
  })
  const unreadCount = useOriginSlice(originId, selectUnreadCount, {
    selectorKey: `sidebar.remote-session-unread.${sessionAgent.agentId}`,
  })
  const running = liveStatus === 'idle' || liveStatus === 'streaming'
  const contextRecoveryInProgress = selectedLiveStatus?.contextRecoveryInProgress === true
  const toggleWorkers = () => {
    setCollapsed((wasCollapsed) => {
      if (wasCollapsed) void originRegistry.getOrigin(originId)?.getClient().getSessionWorkers(sessionAgent.agentId).catch(() => {})
      return !wasCollapsed
    })
  }
  const needsWorkerTruncation = workers.length > MAX_VISIBLE_WORKERS
  let visibleWorkers = workers
  let hiddenWorkerCount = 0
  if (needsWorkerTruncation && !isWorkerListExpanded) {
    const topWorkers = workers.slice(0, MAX_VISIBLE_WORKERS)
    const selectedWorkerInTop = !selectedAgentId || topWorkers.some((worker) => worker.agentId === selectedAgentId)
    const selectedWorker = workers.find((worker) => worker.agentId === selectedAgentId)
    visibleWorkers = selectedWorkerInTop || !selectedWorker
      ? topWorkers
      : [...topWorkers.slice(0, MAX_VISIBLE_WORKERS - 1), selectedWorker]
    hiddenWorkerCount = workers.length - visibleWorkers.length
  }

  return (
    <li>
      <div className={cn('relative', (isSelected || hasSelectedWorker) && 'text-sidebar-foreground')}>
        {hasWorkers ? (
          <button
            type="button"
            onClick={toggleWorkers}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} session workers`}
            aria-expanded={!collapsed}
            className={cn(
              roomsV2 ? 'absolute left-1.5 top-1/2 z-10 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60' : 'absolute left-2 top-1/2 z-10 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
            )}
          >
            {collapsed ? <ChevronRight className="size-3" aria-hidden="true" /> : <ChevronDown className="size-3" aria-hidden="true" />}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onSelectAgent(originId, sessionAgent.agentId)}
          className={cn(
            roomsV2 ? 'sidebar-room-row' : 'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-1.5 text-left transition-colors',
            roomsV2 ? 'py-1 pr-1.5 text-xs leading-4' : undefined,
            hasWorkers
              ? roomsV2 ? 'pl-6' : 'pl-7'
              : roomsV2 ? 'pl-3' : 'pl-5',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
            roomsV2
              ? (isSelected || hasSelectedWorker) ? 'sidebar-room-row-selected' : undefined
              : isSelected || hasSelectedWorker
                ? 'bg-white/[0.04] text-sidebar-foreground ring-1 ring-sidebar-ring/30'
                : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
          )}
        >
          {roomsV2 ? (
            <>
              {activeWorkerCount > 0 ? <SidebarStreamingWorkerBadge count={activeWorkerCount} roomsV2 /> : null}
              {contextRecoveryInProgress ? <SidebarCompactionBadge roomsV2 /> : null}
              {activeWorkerCount === 0 && !contextRecoveryInProgress && liveStatus === 'streaming' ? (
                <span className="sidebar-room-status-streaming sidebar-room-glow inline-flex size-3 shrink-0 rounded-full border-2 bg-transparent" aria-label="Manager streaming" />
              ) : liveStatus === 'error' ? (
                <span className="sidebar-room-status-error-dot size-2 shrink-0 rounded-full" aria-label="Session error" />
              ) : activeWorkerCount === 0 && !contextRecoveryInProgress ? (
                <SessionStatusDot running={running} isCli={Boolean(sessionAgent.cli)} roomsV2 />
              ) : null}
            </>
          ) : liveStatus === 'streaming' ? (
            <span className="inline-flex size-3 shrink-0 rounded-full border-2 border-amber-500 bg-transparent" style={{ animation: 'subtle-glow-pulse 2s ease-in-out infinite' }} aria-label="Manager streaming" />
          ) : liveStatus === 'error' ? (
            <span className="size-2 shrink-0 rounded-full bg-red-500" aria-label="Session error" />
          ) : (
            <SessionStatusDot running={running} isCli={Boolean(sessionAgent.cli)} />
          )}
          <span className={cn('min-w-0 flex-1 truncate text-sm leading-5', roomsV2 ? 'text-xs leading-4' : undefined)}>{label}</span>
          {unreadCount > 0 ? (
            <span className={roomsV2
              ? 'sidebar-room-unread-badge'
              : 'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium tabular-nums leading-none text-white'}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          ) : null}
        </button>
      </div>
      {hasWorkers && !collapsed ? (
        <div className="relative mt-0.5">
          <ul className="space-y-0.5">
            {visibleWorkers.map((worker) => (
              <li key={worker.agentId}>
                <RemoteWorkerRow originId={originId} worker={worker} roomsV2={roomsV2} isSelected={selectedAgentId === worker.agentId} onSelect={() => onSelectAgent(originId, worker.agentId)} />
              </li>
            ))}
          </ul>
          {needsWorkerTruncation ? (
            <button type="button" onClick={() => setWorkerListExpanded((expanded) => !expanded)} className={roomsV2 ? 'relative z-10 mt-0.5 flex w-full items-center gap-1 rounded-md py-1 pl-8 pr-1.5 text-left text-[11px] text-muted-foreground/70 transition-colors hover:bg-sidebar-accent/30 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60' : 'relative z-10 mt-0.5 flex w-full items-center gap-1 rounded-md py-1 pl-12 pr-1.5 text-left text-[11px] text-muted-foreground/70 transition-colors hover:bg-sidebar-accent/30 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60'}>
              {isWorkerListExpanded ? <><ChevronDown className="size-3 shrink-0" aria-hidden="true" /><span>Show less</span></> : <><ChevronDown className="size-3 shrink-0" aria-hidden="true" /><span>Show {hiddenWorkerCount} more</span></>}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
})

const RemoteWorkerRow = memo(function RemoteWorkerRow({ originId, worker, roomsV2 = false, isSelected, onSelect }: {
  originId: OriginId
  worker: SessionRow['workers'][number]
  roomsV2?: boolean
  isSelected: boolean
  onSelect: () => void
}) {
  const selectLiveStatus = useMemo(() => (state: ManagerWsState) => state.statuses[worker.agentId], [worker.agentId])
  const liveStatus = useOriginSlice(originId, selectLiveStatus, {
    selectorKey: `sidebar.remote-worker-status.${worker.agentId}`,
  })
  return <WorkerRow agent={worker} liveStatus={{ status: liveStatus?.status ?? worker.status, pendingCount: liveStatus?.pendingCount ?? 0 }} roomsV2={roomsV2} isSelected={isSelected} onSelect={onSelect} />
})

function RemoteOriginStatusCard({
  originId,
  roomsV2 = false,
  state,
  instanceName,
  onSignIn,
  onRetry,
}: {
  originId: OriginId
  roomsV2?: boolean
  state: OriginHeaderState
  instanceName: string
  onSignIn?: (originId: OriginId) => void
  onRetry?: (originId: OriginId) => void
}) {
  const isActionableAuth = state === 'auth-required' && onSignIn
  const isActionableRetry = (state === 'unreachable' || state === 'disabled') && onRetry

  return (
    <section
      data-testid={`remote-origin-section-${originId}`}
      className={roomsV2
        ? 'sidebar-room-remote-status-card rounded-lg p-2'
        : 'rounded-lg border border-blue-400/20 bg-blue-500/[0.035] p-2'}
      title={HEADER_STATE_LABEL[state]}
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold text-sidebar-foreground">
        <Globe aria-hidden="true" className={roomsV2 ? 'sidebar-room-remote-marker sidebar-room-remote-marker--large' : 'size-3.5 shrink-0 text-blue-400'} />
        <span className="min-w-0 flex-1 truncate">{instanceName}</span>
        {state !== 'connected' ? (
          <span
            aria-label={HEADER_STATE_LABEL[state]}
            className={cn(
              'size-2 shrink-0 rounded-full',
              roomsV2 ? ROOM_HEADER_DOT_CLASS[state] : HEADER_DOT_CLASS[state],
            )}
          />
        ) : null}
      </div>
      <p className={cn('mt-1 text-xs text-muted-foreground', state === 'connecting' ? 'animate-pulse' : undefined)}>
        {state === 'auth-required'
          ? 'Sign in to see this instance’s projects.'
          : state === 'version-blocked'
            ? 'This instance requires a newer Forge. Update Forge to connect.'
            : state === 'unreachable'
              ? 'Instance unreachable.'
              : state === 'disabled'
                ? 'Remote projects are disabled on this instance.'
                : state === 'connected'
                  ? 'No remote projects yet.'
                  : 'Connecting…'}
      </p>
      {isActionableAuth ? (
        <button
          type="button"
          onClick={() => onSignIn(originId)}
          className={roomsV2
            ? 'sidebar-room-remote-status-action mt-1.5 rounded-md px-2 py-1 text-xs transition-colors'
            : 'mt-1.5 rounded-md border border-blue-400/25 px-2 py-1 text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60'}
        >
          Sign in
        </button>
      ) : null}
      {isActionableRetry ? (
        <button
          type="button"
          onClick={() => onRetry(originId)}
          className={roomsV2
            ? 'sidebar-room-remote-status-action mt-1.5 rounded-md px-2 py-1 text-xs transition-colors'
            : 'mt-1.5 rounded-md border border-blue-400/25 px-2 py-1 text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60'}
        >
          Retry
        </button>
      ) : null}
    </section>
  )
}
