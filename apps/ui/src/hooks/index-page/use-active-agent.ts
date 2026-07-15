/**
 * Active-agent derivation controller (WP-U3 BuilderSurface split).
 *
 * Owns the "who is the active agent/manager and how do we keep the route in
 * sync with the subscription" domain that used to live inline at the top of
 * BuilderSurface.  It derives the active agent/manager identities and labels
 * from the local-origin snapshot and runs the two coupled effects that keep the
 * subscribed agent aligned with the route (and remember the previous agent set
 * for deleted-target fallback).
 *
 * Threaded-state, not self-subscribing: BuilderSurface still reads the whole
 * snapshot via `useWsConnection` and passes `state` in, matching the existing
 * `useManagerActions` controller convention (a `useOriginSlice` here would not
 * prune the shell's render and would change the subscription topology — see the
 * WP-U3 plan review).  `fileEditorCoordinatorRef` and `previousAgentsByIdRef`
 * are shell-level refs threaded in so the route-sync effect reads
 * `fileEditorCoordinatorRef.current` lazily (its identity churns every render)
 * without listing the coordinator in the effect deps — preserving the exact
 * re-subscribe cadence of the original inline effect.
 */

import { useEffect, useMemo, type MutableRefObject } from 'react'
import type { AgentDescriptor } from '@forge/protocol'
import type { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import {
  chooseFallbackAgentId,
  isAgentEffectivelyArchived,
} from '@/lib/agent-hierarchy'
import { isUsableActiveTarget } from '@/components/index-page/archive-target-guards'
import {
  requestGuardedAgentTransition,
} from '@/components/index-page/builder-file-editor-guard-actions'
import { chooseMostRecentSessionFallbackForDeletedTarget } from '@/hooks/index-page/deleted-agent-fallback'
import { DEFAULT_MANAGER_AGENT_ID, type AppRouteState } from '@/hooks/index-page/use-route-state'
import type { useFileEditorCoordinator } from '@/components/file-browser/use-file-editor-coordinator'

type FileEditorCoordinator = ReturnType<typeof useFileEditorCoordinator>

interface BuilderNavigationState {
  view: 'chat'
  agentId: string
}

export interface UseActiveAgentOptions {
  state: ManagerWsState
  routeState: AppRouteState
  navigateToRoute: (nextRouteState: BuilderNavigationState, replace?: boolean) => void
  clientRef: MutableRefObject<ManagerWsClient | null>
  /**
   * Shell-owned ref to the file-editor coordinator.  Nullable in the type
   * because the shell assigns it during render *after* the workspace-panels
   * hook creates the coordinator; it is always populated by the time this
   * hook's effects run (effects fire after the full render completes).
   */
  fileEditorCoordinatorRef: MutableRefObject<FileEditorCoordinator | null>
  previousAgentsByIdRef: MutableRefObject<Map<string, AgentDescriptor>>
}

export interface ActiveAgentInfo {
  activeAgentId: string | null
  activeAgent: AgentDescriptor | null
  activeManagerId: string
  activeManagerAgent: AgentDescriptor | null
  isActiveManager: boolean
  terminalSessionAgentId: string | null
  activeAgentStatus: AgentDescriptor['status'] | null
  activeAgentProfileName: string | undefined
  activeAgentSessionLabel: string | undefined
  activeAgentLabel: string
}

export function useActiveAgent({
  state,
  routeState,
  navigateToRoute,
  clientRef,
  fileEditorCoordinatorRef,
  previousAgentsByIdRef,
}: UseActiveAgentOptions): ActiveAgentInfo {
  const activeAgentId = useMemo(() => {
    const preferredId = state.targetAgentId ?? state.subscribedAgentId ?? null
    const preferredAgent = preferredId ? state.agents.find((agent) => agent.agentId === preferredId) : null
    const preferredManager = preferredAgent?.role === 'worker'
      ? state.agents.find((agent) => agent.role === 'manager' && agent.agentId === preferredAgent.managerId)
      : preferredAgent
    if (preferredManager?.role === 'manager' && isAgentEffectivelyArchived(preferredManager, state.profiles)) {
      return chooseFallbackAgentId(state.agents, undefined, state.profiles)
    }
    return preferredId ?? chooseFallbackAgentId(state.agents, undefined, state.profiles)
  }, [state.agents, state.profiles, state.subscribedAgentId, state.targetAgentId])

  const activeAgent = useMemo(() => {
    if (!activeAgentId) {
      return null
    }

    return state.agents.find((agent) => agent.agentId === activeAgentId) ?? null
  }, [activeAgentId, state.agents])

  const isActiveManager = activeAgent?.role === 'manager'

  const activeManagerId = useMemo(() => {
    if (activeAgent?.role === 'manager') {
      return activeAgent.agentId
    }

    if (activeAgent?.managerId) {
      return activeAgent.managerId
    }

    return (
      state.agents.find((agent) => agent.role === 'manager')?.agentId ??
      DEFAULT_MANAGER_AGENT_ID
    )
  }, [activeAgent, state.agents])

  const activeManagerAgent = useMemo(() => {
    if (!activeManagerId) {
      return null
    }

    return state.agents.find(
      (agent) => agent.role === 'manager' && agent.agentId === activeManagerId,
    ) ?? null
  }, [activeManagerId, state.agents])

  const terminalSessionAgentId = useMemo(() => {
    if (!activeAgent) {
      return null
    }

    if (activeAgent.role === 'manager') {
      return activeAgent.agentId
    }

    return activeManagerAgent?.agentId ?? activeAgent.managerId ?? null
  }, [activeAgent, activeManagerAgent])

  const activeAgentStatus = useMemo(() => {
    if (!activeAgentId) {
      return null
    }

    const fromStatuses = state.statuses[activeAgentId]?.status
    if (fromStatuses) {
      return fromStatuses
    }

    return state.agents.find((agent) => agent.agentId === activeAgentId)?.status ?? null
  }, [activeAgentId, state.agents, state.statuses])

  const activeAgentProfileName = useMemo(() => {
    if (!activeAgent?.profileId || !activeAgent.sessionLabel) return undefined
    const profile = state.profiles.find((p) => p.profileId === activeAgent.profileId)
    return profile?.displayName ?? activeAgent.profileId
  }, [activeAgent, state.profiles])

  const activeAgentSessionLabel = useMemo(() => {
    if (!activeAgent?.profileId || !activeAgent.sessionLabel) return undefined
    return activeAgent.sessionLabel
  }, [activeAgent])

  const activeAgentLabel = useMemo(() => {
    if (!activeAgent) return activeAgentId ?? 'No active agent'
    // For session agents, show profile name + session label
    if (activeAgentProfileName && activeAgentSessionLabel) {
      return `${activeAgentProfileName} › ${activeAgentSessionLabel}`
    }
    return activeAgent.displayName ?? activeAgentId ?? 'No active agent'
  }, [activeAgent, activeAgentId, activeAgentProfileName, activeAgentSessionLabel])

  // Keep the subscribed agent aligned with the route.  Reads
  // `fileEditorCoordinatorRef.current` lazily so the coordinator is NOT an
  // effect dependency (its identity churns every render) — this preserves the
  // original re-subscribe cadence.  Must run BEFORE the previous-agents writer
  // below so the writer overwrites `previousAgentsByIdRef` only after this
  // effect has read the prior set for deleted-target fallback.
  useEffect(() => {
    if (routeState.view !== 'chat') {
      return
    }

    const coordinator = fileEditorCoordinatorRef.current
    if (!coordinator) return

    const currentAgentId = state.targetAgentId ?? state.subscribedAgentId
    const hasExplicitRouteSelection = routeState.agentId !== DEFAULT_MANAGER_AGENT_ID
    const clientExplicitSelectionAgentId = clientRef.current?.getExplicitSelectionAgentId() ?? null
    const explicitSelectionAgentId =
      clientExplicitSelectionAgentId ??
      (hasExplicitRouteSelection ? routeState.agentId : null)
    const hasExplicitSelection =
      hasExplicitRouteSelection || clientRef.current?.hasExplicitSelection() === true

    if (
      hasExplicitSelection &&
      explicitSelectionAgentId &&
      explicitSelectionAgentId !== DEFAULT_MANAGER_AGENT_ID
    ) {
      const explicitTargetUsable = isUsableActiveTarget(
        explicitSelectionAgentId,
        state.agents,
        state.profiles,
      )

      if (explicitTargetUsable) {
        if (currentAgentId !== explicitSelectionAgentId) {
          requestGuardedAgentTransition(
            coordinator,
            explicitSelectionAgentId,
            () => clientRef.current?.subscribeToAgent(explicitSelectionAgentId),
          )
        }
        return
      }

      const rejectedExplicitSelectionAgentId =
        clientRef.current?.getRejectedExplicitSelectionAgentId() ?? null
      const explicitSelectionRejected =
        rejectedExplicitSelectionAgentId === explicitSelectionAgentId

      // The origin client is created before the route controller runs, so a
      // fast managers-only bootstrap can clear the client's initial selection
      // bookkeeping before a cold worker route is subscribed. The URL remains
      // authoritative: re-issue that explicit subscription and wait for either
      // its targeted descriptor snapshot or an UNKNOWN_AGENT rejection.
      if (
        !explicitSelectionRejected &&
        clientExplicitSelectionAgentId !== explicitSelectionAgentId &&
        !previousAgentsByIdRef.current.has(explicitSelectionAgentId)
      ) {
        if (state.connected) {
          requestGuardedAgentTransition(
            coordinator,
            explicitSelectionAgentId,
            () => clientRef.current?.subscribeToAgent(explicitSelectionAgentId),
          )
        }
        return
      }

      if (!state.hasReceivedAgentsSnapshot) {
        return
      }

      const explicitSelectionPending =
        clientExplicitSelectionAgentId === explicitSelectionAgentId &&
        clientRef.current?.isExplicitSelectionPending() === true &&
        !explicitSelectionRejected
      // `ready` accepts the target before its agents_snapshot is applied and
      // clears the transport-level pending bit. Keep waiting while a cold,
      // never-observed explicit selection remains accepted; a rejection or
      // removal of a previously observed target authorizes deletion fallback.
      const explicitSelectionAccepted =
        clientExplicitSelectionAgentId === explicitSelectionAgentId &&
        !explicitSelectionRejected &&
        !previousAgentsByIdRef.current.has(explicitSelectionAgentId)
      if (
        explicitSelectionPending ||
        explicitSelectionAccepted ||
        !state.hasReceivedProfilesSnapshot
      ) {
        return
      }

      const fallbackAgentId =
        chooseMostRecentSessionFallbackForDeletedTarget(
          state.agents,
          explicitSelectionAgentId,
          previousAgentsByIdRef.current,
          state.profiles,
        ) ?? chooseFallbackAgentId(state.agents, undefined, state.profiles)

      if (!fallbackAgentId) {
        requestGuardedAgentTransition(
          coordinator,
          DEFAULT_MANAGER_AGENT_ID,
          () => navigateToRoute({ view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID }, true),
        )
        return
      }

      requestGuardedAgentTransition(
        coordinator,
        fallbackAgentId,
        () => {
          if (currentAgentId !== fallbackAgentId) {
            clientRef.current?.subscribeToAgent(fallbackAgentId, { explicit: false })
          }
          navigateToRoute({ view: 'chat', agentId: fallbackAgentId }, true)
        },
      )
      return
    }

    if (currentAgentId === routeState.agentId) {
      return
    }

    if (isUsableActiveTarget(routeState.agentId, state.agents, state.profiles)) {
      requestGuardedAgentTransition(
        coordinator,
        routeState.agentId,
        () => clientRef.current?.subscribeToAgent(routeState.agentId),
      )
      return
    }

    if (state.agents.length === 0) {
      return
    }

    const fallbackAgentId = chooseFallbackAgentId(state.agents, undefined, state.profiles)
    if (!fallbackAgentId || fallbackAgentId === currentAgentId) {
      return
    }

    requestGuardedAgentTransition(
      coordinator,
      fallbackAgentId,
      () => clientRef.current?.subscribeToAgent(fallbackAgentId, { explicit: false }),
    )
  }, [
    clientRef,
    fileEditorCoordinatorRef,
    navigateToRoute,
    previousAgentsByIdRef,
    routeState,
    state.agents,
    state.connected,
    state.hasReceivedAgentsSnapshot,
    state.hasReceivedProfilesSnapshot,
    state.profiles,
    state.subscribedAgentId,
    state.targetAgentId,
  ])

  useEffect(() => {
    previousAgentsByIdRef.current = new Map(
      state.agents.map((agent) => [agent.agentId, agent]),
    )
  }, [previousAgentsByIdRef, state.agents])

  return {
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
  }
}
