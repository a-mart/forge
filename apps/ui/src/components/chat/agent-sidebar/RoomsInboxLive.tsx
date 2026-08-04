import type React from 'react'
import { useMemo } from 'react'
import { LOCAL_ORIGIN_ID, useAllOrigins } from '@/lib/origin-store'
import type { ManagerWsState } from '@/lib/ws-state'
import { RoomsInbox } from './RoomsInbox'
import { RoomsModeSwitch, type RoomsMode } from './RoomsModeSwitch'
import { getRoomsInboxAcknowledgementKey, useRoomsInboxAcknowledgements } from './rooms-inbox-ack'
import {
  selectRoomsInboxLifecycleAttentionSignals,
  selectRoomsInboxSections,
  type RoomsInboxIdentity,
  type RoomsInboxOriginInput,
  type RoomsInboxProjectInput,
  type RoomsInboxSessionInput,
} from './rooms-inbox-selectors'

interface InboxOriginSnapshot {
  connected: boolean
  /** Both inventories must be complete before a missing session can be GCed. */
  inventoryReady: boolean
  sessions: RoomsInboxSessionInput[]
  projects: RoomsInboxProjectInput[]
  signature: string
}

function selectInboxOriginSnapshot(state: ManagerWsState): InboxOriginSnapshot {
  const profiles = state.profiles.filter((profile) => !profile.archivedAt && profile.profileType !== 'system')
  const profilesById = new Map(profiles.map((profile) => [profile.profileId, profile]))
  const cortexProfileIds = new Set(
    state.agents
      .filter((agent) => agent.role === 'manager' && agent.archetypeId === 'cortex' && agent.profileId)
      .map((agent) => agent.profileId!),
  )
  const visibleProfiles = profiles.filter((profile) => !cortexProfileIds.has(profile.profileId))
  const visibleProfileIds = new Set(visibleProfiles.map((profile) => profile.profileId))
  const sessions = state.agents.flatMap((agent): RoomsInboxSessionInput[] => {
    const profileId = agent.profileId
    if (
      agent.role !== 'manager'
      || !profileId
      || !visibleProfileIds.has(profileId)
      || agent.archivedAt
      || agent.agentCreatorResult
      || agent.sessionSurface === 'collab'
    ) return []
    const profile = profilesById.get(profileId)
    if (!profile) return []
    const live = state.statuses[agent.agentId]
    return [{
      identity: { originId: LOCAL_ORIGIN_ID, profileId, sessionAgentId: agent.agentId },
      label: agent.sessionLabel || agent.displayName || agent.agentId,
      profileName: profile.displayName,
      agentStatus: live?.status ?? agent.status,
      activeWorkerCount: agent.activeWorkerCount ?? 0,
      pendingChoiceCount: agent.pendingChoiceCount ?? 0,
      unreadCount: state.unreadCounts[agent.agentId] ?? 0,
      contextRecoveryInProgress: live?.contextRecoveryInProgress === true,
      streamingStartedAt: agent.streamingStartedAt,
      updatedAt: agent.updatedAt,
      lastUserMessageAt: agent.lastUserMessageAt,
      createdAt: agent.createdAt,
      pinnedAt: agent.pinnedAt,
      cli: Boolean(agent.cli),
    }]
  })
  const projects = visibleProfiles.map((profile) => ({
    originId: LOCAL_ORIGIN_ID,
    profileId: profile.profileId,
    profileName: profile.displayName,
    updatedAt: profile.updatedAt,
    createdAt: profile.createdAt,
  }))
  // This is intentionally a compact selector result. Worker-only status and
  // unread updates do not change it, so neither the project tree nor unrelated
  // origin Inbox rows rerender for them.
  const inventoryReady = state.connected
    && state.hasReceivedAgentsSnapshot
    && state.hasReceivedProfilesSnapshot
  const signature = JSON.stringify({ connected: state.connected, inventoryReady, sessions, projects })
  return { connected: state.connected, inventoryReady, sessions, projects, signature }
}

function equalInboxOriginSnapshot(left: InboxOriginSnapshot, right: InboxOriginSnapshot): boolean {
  return left.signature === right.signature
}

export function RoomsInboxLive({
  mode,
  onModeChange,
  selected,
  searchQuery,
  hideCliSessions,
  onSelectLocal,
  onSelectRemote,
  onNewProject,
  commandRow,
  projectTree,
  hasInlineProjectContent = false,
  mutedSessionIds,
  fallbackOrigins = [],
}: {
  mode: RoomsMode
  onModeChange: (mode: RoomsMode) => void
  selected?: Pick<RoomsInboxIdentity, 'originId' | 'sessionAgentId'> | null
  searchQuery: string
  hideCliSessions: boolean
  onSelectLocal: (agentId: string) => void
  onSelectRemote?: (originId: string, agentId: string) => void
  onNewProject: () => void
  /** Kept inside the live surface so the mode switch, one search input, and Inbox body stay ordered. */
  commandRow?: React.ReactNode
  /** Same Rooms v2 project subtree used in the Projects tab; never a shortcut list. */
  projectTree?: React.ReactNode
  /** Whether the shared tree currently renders rows or remote status content. */
  hasInlineProjectContent?: boolean
  /** Presentation-only mute markers owned by the existing sidebar preference. */
  mutedSessionIds?: ReadonlySet<string>
  /** Direct component consumers may not have an origin store yet (tests/bootstrap). */
  fallbackOrigins?: readonly RoomsInboxOriginInput[]
}) {
  const originSnapshots = useAllOrigins(selectInboxOriginSnapshot, {
    selectorKey: 'sidebar.rooms-inbox',
    equalityFn: equalInboxOriginSnapshot,
  })
  const origins = useMemo<RoomsInboxOriginInput[]>(() => {
    const liveOrigins = originSnapshots.map(({ originId, value }) => ({
      originId,
      connected: value.connected,
      inventoryReady: value.inventoryReady,
      sessions: value.sessions.map((session) => ({
        ...session,
        identity: { ...session.identity, originId },
      })),
      projects: value.projects.map((project) => ({ ...project, originId })),
    }))
    const liveOriginIds = new Set(liveOrigins.map((origin) => origin.originId))
    return [...liveOrigins, ...fallbackOrigins.filter((origin) => !liveOriginIds.has(origin.originId))]
  }, [fallbackOrigins, originSnapshots])
  // Existence is deliberately broader than display eligibility: hiding CLI
  // sessions or temporarily disconnecting a remote origin must not discard a
  // dismissal that should still exist when that room returns.
  const existingSessionKeys = useMemo(
    () => new Set(origins.flatMap((origin) => origin.sessions)
      .filter((session) => !session.archived && !session.agentCreatorResult)
      .map((session) => getRoomsInboxAcknowledgementKey(
        session.identity.originId,
        session.identity.sessionAgentId,
      ))),
    [origins],
  )
  const inventoryOriginIds = useMemo(
    () => new Set(origins.map((origin) => origin.originId)),
    [origins],
  )
  const authoritativeOriginIds = useMemo(
    () => new Set(origins
      // A disconnected snapshot cannot authoritatively prove a signal cleared
      // or a session deleted, even if it was ready before its disconnect.
      .filter((origin) => origin.connected && origin.inventoryReady === true)
      .map((origin) => origin.originId)),
    [origins],
  )
  // Lifecycle reconciliation must not use the display-filtered signal set:
  // hiding CLI sessions or searching must not make a still-live dismissal look
  // resolved and re-raise it later.
  const attentionSignals = useMemo(
    () => selectRoomsInboxLifecycleAttentionSignals(origins),
    [origins],
  )
  const { entries: attentionEntries, acknowledge } = useRoomsInboxAcknowledgements({
    existingSessionKeys,
    authoritativeOriginIds,
    inventoryOriginIds,
    signals: attentionSignals,
  })
  const sections = useMemo(() => selectRoomsInboxSections(origins, {
    selected,
    searchQuery,
    hideCliSessions,
    attentionEntries,
  }), [attentionEntries, hideCliSessions, origins, searchQuery, selected])

  // The Inbox badge is a global attention claim, so it must ignore the search
  // filter. Filtering it would let an unrelated query report that nothing needs
  // the user while eager global Needs You sessions still exist.
  const needsYouTotal = useMemo(() => selectRoomsInboxSections(origins, {
    selected,
    hideCliSessions,
    attentionEntries,
  }).needsYou.length, [attentionEntries, hideCliSessions, origins, selected])

  const handleSelectSession = (identity: RoomsInboxIdentity) => {
    if (identity.originId === LOCAL_ORIGIN_ID) {
      onSelectLocal(identity.sessionAgentId)
    } else {
      onSelectRemote?.(identity.originId, identity.sessionAgentId)
    }
  }

  return (
    <>
      <RoomsModeSwitch mode={mode} needsYouCount={needsYouTotal} onChange={onModeChange} />
      {commandRow}
      {mode === 'inbox' ? (
        <RoomsInbox
          sections={sections}
          selected={selected}
          onSelectSession={handleSelectSession}
          onShowProjects={() => onModeChange('projects')}
          onNewProject={onNewProject}
          onAcknowledgeNeedsYou={(identity) => acknowledge([getRoomsInboxAcknowledgementKey(
            identity.originId,
            identity.sessionAgentId,
          )])}
          onClearNeedsYou={(identities) => acknowledge(identities.map((identity) => getRoomsInboxAcknowledgementKey(
            identity.originId,
            identity.sessionAgentId,
          )))}
          projectTree={projectTree}
          hasInlineProjectContent={hasInlineProjectContent}
          mutedSessionIds={mutedSessionIds}
        />
      ) : null}
    </>
  )
}
