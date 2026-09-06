import type React from 'react'
import { useMemo, useRef, useState } from 'react'
import { SESSION_ATTENTION_MAX_DISMISS_IDS } from '@forge/protocol'
import { LOCAL_ORIGIN_ID, originRegistry, useAllOrigins } from '@/lib/origin-store'
import type { ManagerWsState } from '@/lib/ws-state'
import { RoomsInbox } from './RoomsInbox'
import { RoomsModeSwitch, type RoomsMode } from './RoomsModeSwitch'
import {
  selectRoomsInboxSections,
  type RoomsInboxIdentity,
  type RoomsInboxOriginInput,
  type RoomsInboxProjectInput,
  type RoomsInboxSessionInput,
  type RoomsInboxSessionViewModel,
} from './rooms-inbox-selectors'

interface InboxOriginSnapshot {
  connected: boolean
  /** Both inventories must be complete before a missing session can be GCed. */
  inventoryReady: boolean
  attentionAvailable: boolean
  attentions: RoomsInboxOriginInput['attentions']
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
  const attentionAvailable = state.sessionAttentionAvailable
  const attentions = Object.values(state.sessionAttentions)
  const signature = JSON.stringify({
    connected: state.connected,
    inventoryReady,
    attentionAvailable,
    attentions,
    sessions,
    projects,
  })
  return { connected: state.connected, inventoryReady, attentionAvailable, attentions, sessions, projects, signature }
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
  /** Local mute preference: hides Needs You rows and the Inbox badge for those rooms. */
  mutedSessionIds?: ReadonlySet<string>
  /** Direct component consumers may not have an origin store yet (tests/bootstrap). */
  fallbackOrigins?: readonly RoomsInboxOriginInput[]
}) {
  const originSnapshots = useAllOrigins(selectInboxOriginSnapshot, {
    selectorKey: 'sidebar.rooms-inbox',
    equalityFn: equalInboxOriginSnapshot,
  })
  const dismissalAttemptRef = useRef(0)
  const [dismissError, setDismissError] = useState<string | null>(null)
  const origins = useMemo<RoomsInboxOriginInput[]>(() => {
    const liveOrigins = originSnapshots.map(({ originId, value }) => ({
      originId,
      connected: value.connected,
      inventoryReady: value.inventoryReady,
      attentionAvailable: value.attentionAvailable,
      attentions: value.attentions,
      sessions: value.sessions.map((session) => ({
        ...session,
        identity: { ...session.identity, originId },
      })),
      projects: value.projects.map((project) => ({ ...project, originId })),
    }))
    const liveOriginIds = new Set(liveOrigins.map((origin) => origin.originId))
    return [...liveOrigins, ...fallbackOrigins.filter((origin) => !liveOriginIds.has(origin.originId))]
  }, [fallbackOrigins, originSnapshots])
  const sections = useMemo(() => selectRoomsInboxSections(origins, {
    selected,
    searchQuery,
    hideCliSessions,
    mutedSessionIds,
  }), [hideCliSessions, mutedSessionIds, origins, searchQuery, selected])

  // The Inbox badge is a global attention claim, so it must ignore the search
  // filter. Filtering it would let an unrelated query report that nothing needs
  // the user while eager global Needs You sessions still exist.
  const needsYouTotal = useMemo(() => selectRoomsInboxSections(origins, {
    selected,
    hideCliSessions,
    mutedSessionIds,
  }).needsYou.length, [hideCliSessions, mutedSessionIds, origins, selected])

  const handleSelectSession = (identity: RoomsInboxIdentity) => {
    if (identity.originId === LOCAL_ORIGIN_ID) {
      onSelectLocal(identity.sessionAgentId)
    } else {
      onSelectRemote?.(identity.originId, identity.sessionAgentId)
    }
  }

  const dismissNeedsYou = (sessions: readonly RoomsInboxSessionViewModel[]) => {
    const attempt = ++dismissalAttemptRef.current
    setDismissError(null)
    const attentionIdsByOrigin = new Map<string, string[]>()
    for (const session of sessions) {
      if (!session.attentionId) continue
      const attentionIds = attentionIdsByOrigin.get(session.identity.originId) ?? []
      attentionIds.push(session.attentionId)
      attentionIdsByOrigin.set(session.identity.originId, attentionIds)
    }
    const batches = [...attentionIdsByOrigin].flatMap(([originId, attentionIds]) => {
      const originBatches: Array<{ originId: string; attentionIds: string[] }> = []
      for (let index = 0; index < attentionIds.length; index += SESSION_ATTENTION_MAX_DISMISS_IDS) {
        originBatches.push({
          originId,
          attentionIds: attentionIds.slice(index, index + SESSION_ATTENTION_MAX_DISMISS_IDS),
        })
      }
      return originBatches
    })
    void Promise.allSettled(batches.map(async ({ originId, attentionIds }) => {
      const store = originRegistry.getOrigin(originId)
      if (!store) throw new Error(`Origin ${originId} is unavailable.`)
      return store.getClient().dismissSessionAttention(attentionIds)
    })).then((results) => {
      if (attempt !== dismissalAttemptRef.current) return
      if (results.some((result) => result.status === 'rejected')) {
        setDismissError('Some Needs You items could not be cleared. Try again.')
      }
    })
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
          onAcknowledgeNeedsYou={(session) => dismissNeedsYou([session])}
          onClearNeedsYou={dismissNeedsYou}
          dismissError={dismissError}
          projectTree={projectTree}
          hasInlineProjectContent={hasInlineProjectContent}
          mutedSessionIds={mutedSessionIds}
          searchQuery={searchQuery}
        />
      ) : null}
    </>
  )
}
