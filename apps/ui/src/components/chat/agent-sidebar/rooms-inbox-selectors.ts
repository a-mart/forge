import type { AgentStatus } from '@forge/protocol'
import { LOCAL_ORIGIN_ID, type OriginId } from '@/lib/origin-store'
import { isSessionActivelyWorking } from './utils'
import type { StatusMap } from './types'
import {
  getRoomsInboxAcknowledgementKey,
  type RoomsInboxAcknowledgement,
  type RoomsInboxAttentionReason,
  type RoomsInboxAttentionSignal,
} from './rooms-inbox-ack'

export type RoomsInboxReason =
  | RoomsInboxAttentionReason
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
  sessions: readonly RoomsInboxSessionInput[]
  projects: readonly RoomsInboxProjectInput[]
}

export interface RoomsInboxSessionViewModel extends RoomsInboxSessionInput {
  reason: RoomsInboxReason
  timestamp: string
  /** Present only for sticky Needs You rows, which are ordered by this value. */
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
  attentionEntries?: Readonly<Record<string, RoomsInboxAcknowledgement>>
}

const MAX_SECTION_ITEMS = 5
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

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

function attentionSignal(
  session: RoomsInboxSessionInput,
  activelyWorking: boolean,
): Omit<RoomsInboxAttentionSignal, 'key'> | null {
  // The precedence is intentional: one session has one explicit user-facing
  // reason even when a completed unread result also has a pending choice.
  if (session.pendingChoiceCount > 0) {
    return { reason: 'awaiting_choice', signature: `choice:${session.pendingChoiceCount}` }
  }
  if (session.agentStatus === 'error') {
    return { reason: 'error', signature: `error:${session.updatedAt ?? ''}` }
  }
  if (session.unreadCount > 0 && !activelyWorking) {
    return { reason: 'unread_result', signature: `unread:${session.unreadCount}:${session.updatedAt ?? ''}` }
  }
  return null
}

function compareNeedsYou(
  left: { session: RoomsInboxSessionInput; reason: RoomsInboxAttentionReason; raisedAt: number },
  right: { session: RoomsInboxSessionInput; reason: RoomsInboxAttentionReason; raisedAt: number },
): number {
  const raisedOrder = right.raisedAt - left.raisedAt
  if (raisedOrder !== 0) return raisedOrder
  return compareIdentity(left.session, right.session)
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
  if (timestampOrder !== 0) return timestampOrder
  return compareIdentity(left, right)
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
  // Keep the Inbox definition aligned with room-card counters. This intentionally
  // excludes idle runtimes and queued prompt counts.
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
    const key = getRoomsInboxAcknowledgementKey(session.identity.originId, session.identity.sessionAgentId)
    if (!sessionByIdentity.has(key)) sessionByIdentity.set(key, session)
  }
  return [...sessionByIdentity.values()]
    .filter((session) => !session.archived && !session.agentCreatorResult)
    .filter((session) => !options.hideCliSessions || !session.cli || isSelected(session, options.selected))
}

function attentionSignalsForSessions(
  sessions: readonly RoomsInboxSessionInput[],
): RoomsInboxAttentionSignal[] {
  return sessions.flatMap((session) => {
    const signal = attentionSignal(session, isRoomsInboxSessionActive(session))
    return signal ? [{
      ...signal,
      key: getRoomsInboxAcknowledgementKey(session.identity.originId, session.identity.sessionAgentId),
    }] : []
  })
}

/** Eager display attention only; plan snapshots must never enter here. */
export function selectRoomsInboxAttentionSignals(
  origins: readonly RoomsInboxOriginInput[],
  options: Pick<SelectRoomsInboxOptions, 'selected' | 'hideCliSessions'> = {},
): RoomsInboxAttentionSignal[] {
  return attentionSignalsForSessions(getRoomsInboxVisibleSessions(origins, options))
}

/**
 * Reconciliation signals deliberately ignore every user-facing display filter.
 * They are the only signals permitted to advance acknowledgement lifecycles.
 */
export function selectRoomsInboxLifecycleAttentionSignals(
  origins: readonly RoomsInboxOriginInput[],
): RoomsInboxAttentionSignal[] {
  return attentionSignalsForSessions(getRoomsInboxVisibleSessions(origins))
}

/**
 * Derive all Inbox sections from eager session summaries. No plan snapshot is
 * accepted here: plan state is subscription-scoped and cannot safely describe
 * attention for every sidebar session.
 */
export function selectRoomsInboxSections(
  origins: readonly RoomsInboxOriginInput[],
  options: SelectRoomsInboxOptions = {},
): RoomsInboxSections {
  const nowMs = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now()
  const searchQuery = options.searchQuery ?? ''
  const sessions = getRoomsInboxVisibleSessions(origins, options)
  const attentionEntries = options.attentionEntries ?? {}
  const liveSignals = new Map(selectRoomsInboxAttentionSignals(origins, options).map((signal) => [signal.key, signal]))
  const attentionSessionKeys = new Set<string>()
  const dismissedAttentionSessionKeys = new Set<string>()
  const needsYouCandidates: { session: RoomsInboxSessionInput; reason: RoomsInboxAttentionReason; raisedAt: number }[] = []

  for (const session of sessions) {
    const key = getRoomsInboxAcknowledgementKey(session.identity.originId, session.identity.sessionAgentId)
    const liveSignal = liveSignals.get(key)
    const entry = attentionEntries[key]

    // A current attention signal never falls through to Active/Recent, even
    // after dismissal. Dismissal means "handled", not "it became recent".
    if (liveSignal) attentionSessionKeys.add(key)

    if (liveSignal && (!entry || entry.ackedAt === undefined || entry.signature !== liveSignal.signature)) {
      attentionSessionKeys.add(key)
      needsYouCandidates.push({
        session,
        reason: liveSignal.reason,
        raisedAt: entry?.raisedAt ?? nowMs,
      })
      continue
    }

    // Once raised, an unacknowledged entry remains visible even if opening the
    // session immediately clears the underlying unread counter. A dismissed,
    // now-cleared entry stays out of Recent too: Done must actually hide the
    // row, not silently move it to another Inbox section.
    if (!liveSignal && entry) {
      if (entry.ackedAt !== undefined) {
        dismissedAttentionSessionKeys.add(key)
      } else {
        attentionSessionKeys.add(key)
        needsYouCandidates.push({
          session,
          reason: entry.reason,
          raisedAt: entry.raisedAt,
        })
      }
    }
  }

  const needsYou = needsYouCandidates
    .filter(({ session }) => matchesSearch(session, searchQuery))
    .sort(compareNeedsYou)
    .map(({ session, reason, raisedAt }) => ({
      ...session,
      reason,
      timestamp: sessionTimestamp(session),
      raisedAt,
    }))

  const activeCandidates = sessions
    .filter((session) => !attentionSessionKeys.has(getRoomsInboxAcknowledgementKey(
      session.identity.originId,
      session.identity.sessionAgentId,
    )))
    .filter((session) => isRoomsInboxSessionActive(session))
    .filter((session) => matchesSearch(session, searchQuery))
    .sort(compareActive(options.selected))
  const activeIds = new Set(activeCandidates.map((session) => getRoomsInboxAcknowledgementKey(
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
    .filter((session) => !attentionSessionKeys.has(getRoomsInboxAcknowledgementKey(
      session.identity.originId,
      session.identity.sessionAgentId,
    )))
    .filter((session) => !activeIds.has(getRoomsInboxAcknowledgementKey(
      session.identity.originId,
      session.identity.sessionAgentId,
    )))
    .filter((session) => !dismissedAttentionSessionKeys.has(getRoomsInboxAcknowledgementKey(
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
