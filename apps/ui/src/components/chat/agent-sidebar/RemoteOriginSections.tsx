/**
 * Remote origin sidebar sections (Wave R R1, SPEC §5.4).
 *
 * Connected remote origins render as normal project rows with a subtle remote
 * treatment. The origin-store slices remain scoped per origin — an event on one
 * origin never wakes another section (WP-U1 isolation).
 *
 * R1 scope: rows are SELECT-ONLY (no context menus, no DnD). Full row
 * interactions arrive with R2's per-origin action routing.
 */

import { memo, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Globe } from 'lucide-react'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { buildProfileTreeRows, isSessionRunning } from '@/lib/agent-hierarchy'
import type { ProfileTreeRow, SessionRow } from '@/lib/agent-hierarchy'
import type { ManagerWsState } from '@/lib/ws-state'
import {
  useOriginMeta,
  useOriginSlice,
  type OriginId,
  type OriginMetaState,
} from '@/lib/origin-store'
import { cn } from '@/lib/utils'
import { SessionStatusDot } from './shared'
import { getRemoteVisibleProfileRows } from './RemoteOriginSections.utils'
import type { StatusMap } from './types'

export interface RemoteOriginSectionsProps {
  originIds: OriginId[]
  selectedAgentId: string | null
  activeOriginId: OriginId
  onSelectAgent: (originId: OriginId, agentId: string) => void
  onSignIn?: (originId: OriginId) => void
  onRetry?: (originId: OriginId) => void
}

export function RemoteOriginSections({
  originIds,
  selectedAgentId,
  activeOriginId,
  onSelectAgent,
  onSignIn,
  onRetry,
}: RemoteOriginSectionsProps) {
  if (originIds.length === 0) return null

  return (
    <div className="mt-3 space-y-2" data-testid="remote-origin-sections">
      {originIds.map((originId) => (
        <RemoteOriginSection
          key={originId}
          originId={originId}
          selectedAgentId={selectedAgentId}
          isActiveOrigin={originId === activeOriginId}
          onSelectAgent={onSelectAgent}
          onSignIn={onSignIn}
          onRetry={onRetry}
        />
      ))}
    </div>
  )
}

// Stable module-level selectors — shared memoized selection per origin.
const selectAgents = (s: ManagerWsState): AgentDescriptor[] => s.agents
const selectProfiles = (s: ManagerWsState): ManagerProfile[] => s.profiles
const selectStatuses = (s: ManagerWsState): StatusMap => s.statuses
const selectUnreadCounts = (s: ManagerWsState): Record<string, number> => s.unreadCounts

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

const HEADER_DOT_CLASS: Record<OriginHeaderState, string> = {
  connected: 'bg-emerald-500',
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

const RemoteOriginSection = memo(function RemoteOriginSection({
  originId,
  selectedAgentId,
  isActiveOrigin,
  onSelectAgent,
  onSignIn,
  onRetry,
}: {
  originId: OriginId
  selectedAgentId: string | null
  isActiveOrigin: boolean
  onSelectAgent: (originId: OriginId, agentId: string) => void
  onSignIn?: (originId: OriginId) => void
  onRetry?: (originId: OriginId) => void
}) {
  const meta = useOriginMeta(originId)
  const agents = useOriginSlice(originId, selectAgents, { selectorKey: 'sidebar.agents' })
  const profiles = useOriginSlice(originId, selectProfiles, { selectorKey: 'sidebar.profiles' })
  const statuses = useOriginSlice(originId, selectStatuses, { selectorKey: 'sidebar.statuses' })
  const unreadCounts = useOriginSlice(originId, selectUnreadCounts, { selectorKey: 'sidebar.unreadCounts' })

  const treeRows = useMemo(
    () => getRemoteVisibleProfileRows(buildProfileTreeRows(agents, profiles)),
    [agents, profiles],
  )

  const headerState = deriveHeaderState(meta)
  const instanceName = meta?.instanceName?.trim() || 'Remote Forge'

  if (headerState === 'connected' && treeRows.length > 0) {
    return (
      <ul className="space-y-2" data-testid={`remote-origin-section-${originId}`}>
        {treeRows.map((treeRow) => (
          <RemoteProfileRow
            key={treeRow.profile.profileId}
            treeRow={treeRow}
            statuses={statuses}
            unreadCounts={unreadCounts}
            selectedAgentId={selectedAgentId}
            isActiveOrigin={isActiveOrigin}
            instanceName={instanceName}
            connectionLabel={HEADER_STATE_LABEL[headerState]}
            connectionDotClass={HEADER_DOT_CLASS[headerState]}
            onSelectAgent={(agentId) => onSelectAgent(originId, agentId)}
          />
        ))}
      </ul>
    )
  }

  return (
    <RemoteOriginStatusCard
      originId={originId}
      state={headerState}
      instanceName={instanceName}
      onSignIn={onSignIn}
      onRetry={onRetry}
    />
  )
})

function RemoteProfileRow({
  treeRow,
  statuses,
  unreadCounts,
  selectedAgentId,
  isActiveOrigin,
  instanceName,
  connectionLabel,
  connectionDotClass,
  onSelectAgent,
}: {
  treeRow: ProfileTreeRow
  statuses: StatusMap
  unreadCounts: Record<string, number>
  selectedAgentId: string | null
  isActiveOrigin: boolean
  instanceName: string
  connectionLabel: string
  connectionDotClass: string
  onSelectAgent: (agentId: string) => void
}) {
  const { profile, sessions } = treeRow
  const [collapsed, setCollapsed] = useState(false)
  const firstSession = sessions[0]?.sessionAgent
  const isHeaderSelected = isActiveOrigin && sessions.some((session) => session.sessionAgent.agentId === selectedAgentId)

  return (
    <li data-testid={`remote-profile-row-${profile.profileId}`}>
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
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} remote project ${profile.displayName}`}
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
          onClick={() => {
            if (firstSession) onSelectAgent(firstSession.agentId)
          }}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pl-5.5 pr-1.5 text-left transition-colors',
            'hover:bg-sidebar-accent/50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
          )}
          title={`Remote project on ${instanceName}`}
        >
          <Globe aria-hidden="true" className="size-3.5 shrink-0 text-blue-400" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">
            {profile.displayName}
          </span>
          <span
            aria-label={`${instanceName}: ${connectionLabel}`}
            className={cn('ml-1 size-2 shrink-0 rounded-full', connectionDotClass)}
          />
        </button>
      </div>

      {!collapsed && sessions.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {sessions.map((session) => (
            <RemoteSessionRow
              key={session.sessionAgent.agentId}
              session={session}
              statuses={statuses}
              unreadCount={unreadCounts[session.sessionAgent.agentId] ?? 0}
              isSelected={isActiveOrigin && selectedAgentId === session.sessionAgent.agentId}
              onSelect={() => onSelectAgent(session.sessionAgent.agentId)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function RemoteSessionRow({
  session,
  statuses,
  unreadCount,
  isSelected,
  onSelect,
}: {
  session: SessionRow
  statuses: StatusMap
  unreadCount: number
  isSelected: boolean
  onSelect: () => void
}) {
  const { sessionAgent, isDefault } = session
  const running = isSessionRunning(sessionAgent)
  const label = sessionAgent.sessionLabel || (isDefault ? 'Main' : sessionAgent.displayName || sessionAgent.agentId)
  const liveStatus = statuses[sessionAgent.agentId]?.status ?? sessionAgent.status

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
}

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
        <span
          aria-label={HEADER_STATE_LABEL[state]}
          className={cn('size-2 shrink-0 rounded-full', HEADER_DOT_CLASS[state])}
        />
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
