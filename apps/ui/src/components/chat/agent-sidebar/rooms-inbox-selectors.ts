import type { AgentStatus, SessionAttention, SessionAttentionReason } from '@forge/protocol'
import { LOCAL_ORIGIN_ID, type OriginId } from '@/lib/origin-store'
import { isSessionActivelyWorking } from './utils'
import type { StatusMap } from './types'

export type RoomsInboxReason =
  | SessionAttentionReason
  | 'compacting'
  | 'manager_working'
  | 'recently_updated'

export interface RoomsInboxIdentity {
  originId: OriginId
  profileId: string
  sessionAgentId: string
}

/** A deliberately compact, origin-scoped summary for Inbox classification. */
export interface RoomsInboxSessionInput {
  identity: RoomsInboxIdentity
  label: string
  profileName: string
  agentStatus: AgentStatus
  activeWorkerCount: number
  pendingChoiceCount: number
  unreadCount: number
  contextRecoveryInProgress: boolean
  streamingStartedAt?: number
  updatedAt?: string
  lastUserMessageAt?: string
  createdAt: string
  /** Presentation-only Inbox marker; it does not affect section membership. */
  pinnedAt?: string
  cli?: boolean
  archived?: boolean
  agentCreatorResult?: boolean
}

export interface RoomsInboxProjectInput {
  originId: OriginId
  profileId: string
  profileName: string
  updatedAt?: string
  createdAt: string
  archived?: boolean
}

export interface RoomsInboxOriginInput {
  originId: OriginId
  /** Remote origins are included only while connected; local remains available offline. */
  connected: boolean
  /** False while this origin is still receiving its agent/profile bootstrap snapshots. */
  inventoryReady?: boolean
  /** Unsupported origins keep Active/Recent but never synthesize Needs You. */
  attentionAvailable?: boolean
  attentions?: readonly SessionAttention[]
  sessions: readonly RoomsInboxSessionInput[]
  projects: readonly RoomsInboxProjectInput[]
}

export interface RoomsInboxSessionViewModel extends RoomsInboxSessionInput {
  reason: RoomsInboxReason
  timestamp: string
  /** Exact server occurrence identifier, present only for Needs You rows. */
  attentionId?: string
  /** Present only for Needs You rows, which are ordered by this value. */
  raisedAt?: number
}

export interface RoomsInboxProjectViewModel extends RoomsInboxProjectInput {
  timestamp: string
}

export interface RoomsInboxSections {
  needsYou: RoomsInboxSessionViewModel[]
  active: RoomsInboxSessionViewModel[]
  activeOverflowCount: number
  activeWorkerCount: number
  recent: RoomsInboxSessionViewModel[]
  projects: RoomsInboxProjectViewModel[]
  projectCount: number
}

export interface SelectRoomsInboxOptions {
  selected?: Pick<RoomsInboxIdentity, 'originId' | 'sessionAgentId'> | null
  now?: Date | number
  searchQuery?: string
  hideCliSessions?: boolean
  /** Local mute preference: hides Needs You only; Active/Recent still list the room. */
  mutedSessionIds?: ReadonlySet<string>
}

const MAX_SECTION_ITEMS = 5
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function getRoomsInboxIdentityKey(originId: string, sessionAgentId: string): string {
  return `${originId}::${sessionAgentId}`
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sessionTimestamp(session: RoomsInboxSessionInput): string {
  return session.updatedAt || session.createdAt
}

function projectTimestamp(project: RoomsInboxProjectInput, sessions: readonly RoomsInboxSessionInput[]): string {
  const sessionTimestampValue = sessions
    .filter((session) => session.identity.originId === project.originId && session.identity.profileId === project.profileId)
    .reduce((latest, session) => {
      const candidate = session.updatedAt || session.lastUserMessageAt || session.createdAt
      return timestampMs(candidate) > timestampMs(latest) ? candidate : latest
    }, '')
  return sessionTimestampValue || project.updatedAt || project.createdAt
}

function isSelected(
  session: RoomsInboxSessionInput,
  selected: SelectRoomsInboxOptions['selected'],
): boolean {
  return selected?.originId === session.identity.originId
    && selected.sessionAgentId === session.identity.sessionAgentId
}

function compareIdentity(left: RoomsInboxSessionInput, right: RoomsInboxSessionInput): number {
  return left.identity.sessionAgentId.localeCompare(right.identity.sessionAgentId)
    || left.identity.originId.localeCompare(right.identity.originId)
    || left.identity.profileId.localeCompare(right.identity.profileId)
}

function compareNeedsYou(
  left: { session: RoomsInboxSessionInput; attention: SessionAttention; raisedAt: number },
  right: { session: RoomsInboxSessionInput; attention: SessionAttention; raisedAt: number },
): number {
  const raisedOrder = right.raisedAt - left.raisedAt
  return raisedOrder || compareIdentity(left.session, right.session)
}

function compareActive(
  selected: SelectRoomsInboxOptions['selected'],
): (left: RoomsInboxSessionInput, right: RoomsInboxSessionInput) => number {
  return (left, right) => {
    const selectedOrder = Number(isSelected(right, selected)) - Number(isSelected(left, selected))
    if (selectedOrder !== 0) return selectedOrder
    const compactionOrder = Number(right.contextRecoveryInProgress) - Number(left.contextRecoveryInProgress)
    if (compactionOrder !== 0) return compactionOrder
    const workersOrder = right.activeWorkerCount - left.activeWorkerCount
    if (workersOrder !== 0) return workersOrder
    const activityOrder = (right.streamingStartedAt ?? timestampMs(sessionTimestamp(right)))
      - (left.streamingStartedAt ?? timestampMs(sessionTimestamp(left)))
    if (activityOrder !== 0) return activityOrder
    return compareIdentity(left, right)
  }
}

function compareRecent(left: RoomsInboxSessionInput, right: RoomsInboxSessionInput): number {
  const timestampOrder = timestampMs(sessionTimestamp(right)) - timestampMs(sessionTimestamp(left))
  return timestampOrder || compareIdentity(left, right)
}

function isLocallyMuted(
  session: RoomsInboxSessionInput,
  mutedSessionIds: ReadonlySet<string> | undefined,
): boolean {
  return session.identity.originId === LOCAL_ORIGIN_ID
    && mutedSessionIds?.has(session.identity.sessionAgentId) === true
}

function matchesSearch(
  value: Pick<RoomsInboxSessionInput, 'identity' | 'label' | 'profileName'>,
  searchQuery: string,
): boolean {
  const term = searchQuery.trim().toLocaleLowerCase()
  if (!term) return true
  return value.label.toLocaleLowerCase().includes(term)
    || value.profileName.toLocaleLowerCase().includes(term)
    || value.identity.sessionAgentId.toLocaleLowerCase().includes(term)
}

function activeStatusMap(session: RoomsInboxSessionInput): StatusMap {
  return {
    [session.identity.sessionAgentId]: {
      status: session.agentStatus,
      pendingCount: 0,
      contextRecoveryInProgress: session.contextRecoveryInProgress,
    },
  }
}

export function isRoomsInboxSessionActive(session: RoomsInboxSessionInput): boolean {
  return isSessionActivelyWorking({
    sessionAgent: {
      agentId: session.identity.sessionAgentId,
      status: session.agentStatus,
      activeWorkerCount: session.activeWorkerCount,
    },
  }, activeStatusMap(session))
}

function reasonForActive(session: RoomsInboxSessionInput): RoomsInboxReason {
  return session.contextRecoveryInProgress ? 'compacting' : 'manager_working'
}

/** Returns all sessions to which the origin-global Inbox rules can apply. */
export function getRoomsInboxVisibleSessions(
  origins: readonly RoomsInboxOriginInput[],
  options: Pick<SelectRoomsInboxOptions, 'selected' | 'hideCliSessions'> = {},
): RoomsInboxSessionInput[] {
  const visibleOrigins = origins.filter((origin) => origin.originId === LOCAL_ORIGIN_ID || origin.connected)
  const sessionByIdentity = new Map<string, RoomsInboxSessionInput>()
  for (const session of visibleOrigins.flatMap((origin) => origin.sessions)) {
    const key = getRoomsInboxIdentityKey(session.identity.originId, session.identity.sessionAgentId)
    if (!sessionByIdentity.has(key)) sessionByIdentity.set(key, session)
  }
  return [...sessionByIdentity.values()]
    .filter((session) => !session.archived && !session.agentCreatorResult)
    .filter((session) => !options.hideCliSessions || !session.cli || isSelected(session, options.selected))
}

function getVisibleAttentionBySession(origins: readonly RoomsInboxOriginInput[]): Map<string, SessionAttention> {
  const attentions = new Map<string, SessionAttention>()
  for (const origin of origins) {
    if ((origin.originId !== LOCAL_ORIGIN_ID && !origin.connected) || !origin.attentionAvailable) continue
    for (const attention of origin.attentions ?? []) {
      if (!attentions.has(getRoomsInboxIdentityKey(origin.originId, attention.sessionAgentId))) {
        attentions.set(getRoomsInboxIdentityKey(origin.originId, attention.sessionAgentId), attention)
      }
    }
  }
  return attentions
}

/**
 * Derive Needs You only from server attention. Active/Recent remain descriptor-derived
 * and unread/choice/status fields never manufacture or clear an attention occurrence.
 */
export function selectRoomsInboxSections(
  origins: readonly RoomsInboxOriginInput[],
  options: SelectRoomsInboxOptions = {},
): RoomsInboxSections {
  const nowMs = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now()
  const searchQuery = options.searchQuery ?? ''
  const sessions = getRoomsInboxVisibleSessions(origins, options)
  const attentionBySession = getVisibleAttentionBySession(origins)
  const attentionSessionKeys = new Set<string>()
  const needsYouCandidates: Array<{
    session: RoomsInboxSessionInput
    attention: SessionAttention
    raisedAt: number
  }> = []

  for (const session of sessions) {
    const key = getRoomsInboxIdentityKey(session.identity.originId, session.identity.sessionAgentId)
    const attention = attentionBySession.get(key)
    if (!attention) continue
    // Mute is a local display preference. It must not dismiss server attention,
    // but it also must not claim the user's attention.
    if (isLocallyMuted(session, options.mutedSessionIds)) continue
    attentionSessionKeys.add(key)
    needsYouCandidates.push({
      session,
      attention,
      raisedAt: timestampMs(attention.raisedAt),
    })
  }

  const needsYou = needsYouCandidates
    .filter(({ session }) => matchesSearch(session, searchQuery))
    .sort(compareNeedsYou)
    .map(({ session, attention, raisedAt }) => ({
      ...session,
      reason: attention.reason,
      timestamp: attention.raisedAt,
      attentionId: attention.attentionId,
      raisedAt,
    }))

  const activeCandidates = sessions
    .filter((session) => !attentionSessionKeys.has(getRoomsInboxIdentityKey(
      session.identity.originId,
      session.identity.sessionAgentId,
    )))
    .filter((session) => isRoomsInboxSessionActive(session))
    .filter((session) => matchesSearch(session, searchQuery))
    .sort(compareActive(options.selected))
  const activeIds = new Set(activeCandidates.map((session) => getRoomsInboxIdentityKey(
    session.identity.originId,
    session.identity.sessionAgentId,
  )))
  const activeWorkerCount = activeCandidates.reduce((total, session) => total + session.activeWorkerCount, 0)
  const active = activeCandidates.slice(0, MAX_SECTION_ITEMS).map((session) => ({
    ...session,
    reason: reasonForActive(session),
    timestamp: sessionTimestamp(session),
  }))

  const recent = sessions
    .filter((session) => !attentionSessionKeys.has(getRoomsInboxIdentityKey(
      session.identity.originId,
      session.identity.sessionAgentId,
    )))
    .filter((session) => !activeIds.has(getRoomsInboxIdentityKey(
      session.identity.originId,
      session.identity.sessionAgentId,
    )))
    .filter((session) => timestampMs(sessionTimestamp(session)) >= nowMs - RECENT_WINDOW_MS)
    .filter((session) => matchesSearch(session, searchQuery))
    .sort(compareRecent)
    .slice(0, MAX_SECTION_ITEMS)
    .map((session) => ({
      ...session,
      reason: 'recently_updated' as const,
      timestamp: sessionTimestamp(session),
    }))

  const visibleOrigins = origins.filter((origin) => origin.originId === LOCAL_ORIGIN_ID || origin.connected)
  const projects = visibleOrigins
    .flatMap((origin) => origin.projects)
    .filter((project) => !project.archived)
    .map((project) => ({
      ...project,
      timestamp: projectTimestamp(project, sessions),
    }))
    .filter((project) => matchesSearch({
      identity: { originId: project.originId, profileId: project.profileId, sessionAgentId: project.profileId },
      label: project.profileName,
      profileName: project.profileName,
    }, searchQuery))
    .sort((left, right) => timestampMs(right.timestamp) - timestampMs(left.timestamp)
      || left.profileName.localeCompare(right.profileName)
      || left.originId.localeCompare(right.originId)
      || left.profileId.localeCompare(right.profileId))

  return {
    needsYou,
    active,
    activeOverflowCount: Math.max(0, activeCandidates.length - active.length),
    activeWorkerCount,
    recent,
    projects: projects.slice(0, MAX_SECTION_ITEMS),
    projectCount: projects.length,
  }
}
