/**
 * Remote project rows and origin status cards for the unified Builder list.
 *
 * DnD deliberately does not live here: AgentSidebar owns one DndContext across
 * every local and remote project, and persistence always targets the local
 * Builder preference.
 */

import { memo, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Globe } from 'lucide-react'
import type { SessionRow } from '@/lib/agent-hierarchy'
import {
  compositeKey,
  useOriginMeta,
  useOriginSlice,
  type OriginId,
  type OriginMetaState,
} from '@/lib/origin-store'
import { cn } from '@/lib/utils'
import { SessionStatusDot } from './shared'
import type { ManagerWsState } from '@/lib/ws-state'
import {
  equalRemoteProfileRowProps,
  type RemoteProfileRowProps,
} from './remote-profile-row-props'

export interface RemoteOriginSectionsProps {
  /** Origins which currently have no renderable project row. */
  originIds: OriginId[]
  onSignIn?: (originId: OriginId) => void
  onRetry?: (originId: OriginId) => void
}

export function RemoteOriginSections({
  originIds,
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
  onSignIn,
  onRetry,
}: {
  originId: OriginId
  onSignIn?: (originId: OriginId) => void
  onRetry?: (originId: OriginId) => void
}) {
  const meta = useOriginMeta(originId)
  return (
    <RemoteOriginStatusCard
      originId={originId}
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
  selectedAgentId,
  isActiveOrigin,
  instanceName: fallbackInstanceName,
  dragHandleRef,
  dragHandleListeners,
  dragHandleAttributes,
  onSelectAgent,
}: RemoteProfileRowProps) {
  const { profile, sessions } = treeRow
  const [collapsed, setCollapsed] = useState(false)
  const meta = useOriginMeta(originId)
  const instanceName = meta?.instanceName?.trim() || fallbackInstanceName?.trim() || 'Remote Forge'
  const firstSession = sessions[0]?.sessionAgent
  const isHeaderSelected = isActiveOrigin && sessions.some((session) => session.sessionAgent.agentId === selectedAgentId)

  return (
    <div data-testid={`remote-profile-row-${compositeKey(originId, profile.profileId)}`}>
      <div
        className={cn(
          'relative flex items-center rounded-lg border bg-blue-500/[0.035] transition-colors',
          isHeaderSelected
            ? 'border-blue-400/45 ring-1 ring-blue-400/25'
            : 'border-blue-400/25 hover:border-blue-400/40',
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} remote project ${profile.displayName} on ${instanceName}`}
          aria-expanded={!collapsed}
          className={cn(
            'group absolute left-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-blue-300/80 transition',
            'hover:text-blue-200',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
          )}
        >
          {collapsed ? (
            <ChevronRight className="size-3" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          ref={dragHandleRef}
          {...dragHandleAttributes}
          {...dragHandleListeners}
          aria-label={`${dragHandleListeners ? 'Open or drag' : 'Open'} remote project ${profile.displayName} on ${instanceName}`}
          onClick={() => {
            if (firstSession) onSelectAgent(originId, firstSession.agentId)
          }}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pl-5.5 pr-1.5 text-left transition-colors',
            'hover:bg-sidebar-accent/50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
            dragHandleListeners ? 'cursor-grab active:cursor-grabbing' : '',
          )}
          style={dragHandleListeners ? { touchAction: 'none' } : undefined}
          title={`Remote project on ${instanceName}`}
        >
          <Globe aria-hidden="true" className="size-3.5 shrink-0 text-blue-400" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">
            {profile.displayName}
          </span>
        </button>
      </div>

      {!collapsed && sessions.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {sessions.map((session) => (
            <RemoteSessionRow
              key={compositeKey(originId, session.sessionAgent.agentId)}
              originId={originId}
              session={session}
              isSelected={isActiveOrigin && selectedAgentId === session.sessionAgent.agentId}
              onSelect={() => onSelectAgent(originId, session.sessionAgent.agentId)}
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
  isSelected,
  onSelect,
}: {
  originId: OriginId
  session: SessionRow
  isSelected: boolean
  onSelect: () => void
}) {
  const { sessionAgent, isDefault } = session
  const label = sessionAgent.sessionLabel || (isDefault ? 'Main' : sessionAgent.displayName || sessionAgent.agentId)
  const selectLiveStatus = useMemo(
    () => (state: ManagerWsState) => state.statuses[sessionAgent.agentId]?.status,
    [sessionAgent.agentId],
  )
  const selectUnreadCount = useMemo(
    () => (state: ManagerWsState) => state.unreadCounts[sessionAgent.agentId] ?? 0,
    [sessionAgent.agentId],
  )
  const selectedLiveStatus = useOriginSlice(originId, selectLiveStatus, {
    selectorKey: `sidebar.remote-session-status.${sessionAgent.agentId}`,
  })
  const liveStatus = selectedLiveStatus ?? sessionAgent.status
  const unreadCount = useOriginSlice(originId, selectUnreadCount, {
    selectorKey: `sidebar.remote-session-unread.${sessionAgent.agentId}`,
  })
  const running = liveStatus === 'idle' || liveStatus === 'streaming'

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pl-5 pr-1.5 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
          isSelected
            ? 'bg-white/[0.04] text-sidebar-foreground ring-1 ring-sidebar-ring/30'
            : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
        )}
      >
        {liveStatus === 'streaming' ? (
          <span
            className="inline-flex size-3 shrink-0 rounded-full border-2 border-amber-500 bg-transparent"
            style={{ animation: 'subtle-glow-pulse 2s ease-in-out infinite' }}
            aria-label="Manager streaming"
          />
        ) : liveStatus === 'error' ? (
          <span className="size-2 shrink-0 rounded-full bg-red-500" aria-label="Session error" />
        ) : (
          <SessionStatusDot running={running} isCli={Boolean(sessionAgent.cli)} />
        )}
        <span className="min-w-0 flex-1 truncate text-sm leading-5">{label}</span>
        {unreadCount > 0 ? (
          <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium tabular-nums leading-none text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>
    </li>
  )
})

function RemoteOriginStatusCard({
  originId,
  state,
  instanceName,
  onSignIn,
  onRetry,
}: {
  originId: OriginId
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
      className="rounded-lg border border-blue-400/20 bg-blue-500/[0.035] p-2"
      title={HEADER_STATE_LABEL[state]}
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold text-sidebar-foreground">
        <Globe aria-hidden="true" className="size-3.5 shrink-0 text-blue-400" />
        <span className="min-w-0 flex-1 truncate">{instanceName}</span>
        {state !== 'connected' ? (
          <span
            aria-label={HEADER_STATE_LABEL[state]}
            className={cn('size-2 shrink-0 rounded-full', HEADER_DOT_CLASS[state])}
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
          className="mt-1.5 rounded-md border border-blue-400/25 px-2 py-1 text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
        >
          Sign in
        </button>
      ) : null}
      {isActionableRetry ? (
        <button
          type="button"
          onClick={() => onRetry(originId)}
          className="mt-1.5 rounded-md border border-blue-400/25 px-2 py-1 text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
        >
          Retry
        </button>
      ) : null}
    </section>
  )
}
