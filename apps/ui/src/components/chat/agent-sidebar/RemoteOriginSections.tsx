/**
 * Remote origin sidebar sections (Wave R R1, SPEC §5.4).
 *
 * One collapsible section per connected remote instance, rendered below the
 * local project tree. The section header carries the instance name and a
 * connection/auth state dot; the body renders that origin's projects/sessions
 * from its own origin-store slices — an event on one origin never wakes
 * another section (WP-U1 isolation).
 *
 * R1 scope: rows are SELECT-ONLY (no context menus, no DnD). Full row
 * interactions arrive with R2's per-origin action routing.
 */

import { memo, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Globe } from 'lucide-react'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { buildProfileTreeRows } from '@/lib/agent-hierarchy'
import type { ManagerWsState } from '@/lib/ws-state'
import {
  useOriginMeta,
  useOriginSlice,
  type OriginId,
  type OriginMetaState,
} from '@/lib/origin-store'
import { cn } from '@/lib/utils'
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
    <div className="mt-3 space-y-2 border-t border-sidebar-border pt-2" data-testid="remote-origin-sections">
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

  const [collapsed, setCollapsed] = useState(false)
  const treeRows = useMemo(() => buildProfileTreeRows(agents, profiles), [agents, profiles])

  const headerState = deriveHeaderState(meta)
  const instanceName = meta?.instanceName?.trim() || 'Remote Forge'
  const showBody = !collapsed

  return (
    <section data-testid={`remote-origin-section-${originId}`}>
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-semibold text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
        title={HEADER_STATE_LABEL[headerState]}
      >
        {collapsed ? (
          <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
        )}
        <Globe aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{instanceName}</span>
        <span
          aria-label={HEADER_STATE_LABEL[headerState]}
          className={cn('size-2 shrink-0 rounded-full', HEADER_DOT_CLASS[headerState])}
        />
      </button>

      {showBody ? (
        headerState === 'auth-required' ? (
          <div className="px-2 py-1.5">
            <p className="text-xs text-muted-foreground">Sign in to see this instance's projects.</p>
            {onSignIn ? (
              <button
                type="button"
                onClick={() => onSignIn(originId)}
                className="mt-1.5 rounded-md border border-sidebar-border px-2 py-1 text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
              >
                Sign in
              </button>
            ) : null}
          </div>
        ) : headerState === 'version-blocked' ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            This instance requires a newer Forge. Update Forge to connect.
          </p>
        ) : headerState === 'unreachable' || headerState === 'disabled' ? (
          <div className="px-2 py-1.5">
            <p className="text-xs text-muted-foreground">
              {headerState === 'disabled' ? 'Remote projects are disabled on this instance.' : 'Instance unreachable.'}
            </p>
            {onRetry ? (
              <button
                type="button"
                onClick={() => onRetry(originId)}
                className="mt-1.5 rounded-md border border-sidebar-border px-2 py-1 text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : treeRows.length === 0 ? (
          <p className={cn(
            'px-2 py-1.5 text-xs text-muted-foreground',
            headerState === 'connecting' ? 'animate-pulse' : undefined,
          )}>
            {headerState === 'connecting' ? 'Connecting…' : 'No projects yet.'}
          </p>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {treeRows.map((treeRow) => (
              <li key={treeRow.profile.profileId}>
                <p className="truncate px-2 pt-1 text-xs font-medium text-sidebar-foreground/90">
                  {treeRow.profile.displayName}
                </p>
                <ul>
                  {treeRow.sessions.map((session) => {
                    const agent = session.sessionAgent
                    const isSelected = isActiveOrigin && selectedAgentId === agent.agentId
                    const status = statuses[agent.agentId]?.status
                    const unread = unreadCounts[agent.agentId] ?? 0
                    return (
                      <li key={agent.agentId}>
                        <button
                          type="button"
                          onClick={() => onSelectAgent(originId, agent.agentId)}
                          className={cn(
                            'flex w-full items-center gap-1.5 rounded-md py-1 pl-5 pr-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                            isSelected
                              ? 'bg-sidebar-accent text-sidebar-foreground'
                              : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              'size-1.5 shrink-0 rounded-full',
                              status === 'streaming'
                                ? 'bg-emerald-500 animate-pulse'
                                : status === 'error'
                                  ? 'bg-red-500'
                                  : status === 'idle'
                                    ? 'bg-emerald-600/70'
                                    : 'bg-muted-foreground/40',
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {agent.sessionLabel ?? agent.displayName ?? agent.agentId}
                          </span>
                          {unread > 0 ? (
                            <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold leading-4 text-primary">
                              {unread}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
})
