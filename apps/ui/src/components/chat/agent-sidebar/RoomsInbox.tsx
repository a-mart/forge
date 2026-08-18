import type React from 'react'
import { BellOff, CheckCheck, CircleAlert, Globe, Inbox, Pin } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LOCAL_ORIGIN_ID } from '@/lib/origin-store'
import { SidebarRoomAvatar } from './shared'
import { formatRoomsInboxRelativeTime, presentRoomsInboxReason } from './rooms-inbox-presenter'
import type {
  RoomsInboxIdentity,
  RoomsInboxSections,
  RoomsInboxSessionViewModel,
} from './rooms-inbox-selectors'

export function RoomsInbox({
  sections,
  selected,
  onSelectSession,
  onShowProjects,
  onNewProject,
  onAcknowledgeNeedsYou,
  onClearNeedsYou,
  dismissError,
  projectTree,
  hasInlineProjectContent = false,
  mutedSessionIds,
  now,
}: {
  sections: RoomsInboxSections
  selected?: Pick<RoomsInboxIdentity, 'originId' | 'sessionAgentId'> | null
  onSelectSession: (identity: RoomsInboxIdentity) => void
  onShowProjects: () => void
  onNewProject: () => void
  onAcknowledgeNeedsYou: (session: RoomsInboxSessionViewModel) => void
  onClearNeedsYou: (sessions: readonly RoomsInboxSessionViewModel[]) => void
  dismissError?: string | null
  /** The same Rooms v2 project tree rendered in the Projects tab. */
  projectTree?: React.ReactNode
  /** Derived from the shared tree's rows and visible remote status cards. */
  hasInlineProjectContent?: boolean
  /** Presentation-only mute affordance; this does not participate in Inbox classification. */
  mutedSessionIds?: ReadonlySet<string>
  now?: Date
}) {
  // The shared tree is the authoritative Projects-mode render model: it may
  // contain a session/worker-only search match, an inactive Project Agent, or
  // a remote sign-in/retry card even when the Inbox shortcut count is zero.
  // The element itself is always supplied by production composition, so its
  // presence cannot determine whether the Inbox has visible content.
  const hasInlineProjects = hasInlineProjectContent
  // Existing mute preferences are local Builder preferences; do not let a
  // coincident remote agent ID borrow a local visual marker.
  const isMuted = (session: RoomsInboxSessionViewModel) => session.identity.originId === LOCAL_ORIGIN_ID
    && mutedSessionIds?.has(session.identity.sessionAgentId) === true
  const isEmpty = sections.needsYou.length === 0
    && sections.active.length === 0
    && sections.recent.length === 0
    && !hasInlineProjects

  if (isEmpty) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center" data-testid="rooms-inbox-empty">
        <Inbox className="size-5 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-sidebar-foreground">Your Inbox is clear</p>
          <p className="mt-1 text-xs text-muted-foreground">Start a project to begin working.</p>
        </div>
        <button
          type="button"
          onClick={onNewProject}
          className="min-h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
        >
          New Project
        </button>
      </section>
    )
  }

  return (
    <div className="sidebar-room-inbox" data-testid="rooms-inbox">
      {sections.needsYou.length > 0 ? (
        <InboxSection
          title="Needs you"
          testId="needs-you"
          action={(
            <button
              type="button"
              onClick={() => onClearNeedsYou(sections.needsYou)}
              className="sidebar-room-clear-needs-you focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
            >
              <CheckCheck className="size-3" aria-hidden="true" />
              Clear
            </button>
          )}
        >
          {dismissError ? (
            <p
              role="alert"
              className="mx-2 mb-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
            >
              {dismissError}
            </p>
          ) : null}
          {sections.needsYou.map((session) => (
            <InboxSessionRow
              key={`${session.identity.originId}::${session.identity.sessionAgentId}`}
              session={session}
              selected={selected}
              onSelectSession={onSelectSession}
              onAcknowledge={() => onAcknowledgeNeedsYou(session)}
              showDone
              section="needs-you"
              muted={isMuted(session)}
              now={now}
            />
          ))}
        </InboxSection>
      ) : null}

      {sections.active.length > 0 ? (
        <InboxSection title="Active" detail={`${sections.activeWorkerCount} worker${sections.activeWorkerCount === 1 ? '' : 's'}`} testId="active">
          {sections.active.map((session) => (
            <InboxSessionRow
              key={`${session.identity.originId}::${session.identity.sessionAgentId}`}
              session={session}
              selected={selected}
              onSelectSession={onSelectSession}
              section="active"
              muted={isMuted(session)}
              now={now}
            />
          ))}
          {sections.activeOverflowCount > 0 ? (
            <button
              type="button"
              onClick={onShowProjects}
              className="sidebar-room-inbox-more focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
            >
              {sections.activeOverflowCount} more
            </button>
          ) : null}
        </InboxSection>
      ) : null}

      {sections.recent.length > 0 ? (
        <InboxSection title="Recent" testId="recent">
          {sections.recent.map((session) => (
            <InboxSessionRow
              key={`${session.identity.originId}::${session.identity.sessionAgentId}`}
              session={session}
              selected={selected}
              onSelectSession={onSelectSession}
              section="recent"
              muted={isMuted(session)}
              now={now}
            />
          ))}
        </InboxSection>
      ) : null}

      {hasInlineProjects ? (
        <InboxSection title="Projects" detail="recently used" testId="projects">
          <div className="sidebar-room-inbox-project-list">{projectTree}</div>
        </InboxSection>
      ) : null}
    </div>
  )
}

function InboxSection({
  title,
  detail,
  action,
  testId,
  children,
}: {
  title: string
  detail?: string
  action?: React.ReactNode
  testId: string
  children: React.ReactNode
}) {
  return (
    <section
      data-inbox-section={testId}
      className={cn('sidebar-room-inbox-section', `sidebar-room-inbox-section--${testId}`)}
    >
      <div className="sidebar-room-inbox-section-header">
        <h2 className="sidebar-room-inbox-section-label">{title}</h2>
        {detail ? (
          <span className={cn(
            'sidebar-room-inbox-section-detail',
            testId === 'active' ? 'sidebar-room-inbox-section-detail--active' : undefined,
          )}>
            {testId === 'active' ? <span className="sidebar-room-active-dot" aria-hidden="true" /> : null}
            {detail}
          </span>
        ) : null}
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      <div className="sidebar-room-inbox-section-rows">{children}</div>
    </section>
  )
}

function InboxSessionRow({
  session,
  selected,
  onSelectSession,
  onAcknowledge,
  showDone = false,
  section,
  muted = false,
  now,
}: {
  session: RoomsInboxSessionViewModel
  selected?: Pick<RoomsInboxIdentity, 'originId' | 'sessionAgentId'> | null
  onSelectSession: (identity: RoomsInboxIdentity) => void
  onAcknowledge?: () => void
  showDone?: boolean
  section: 'needs-you' | 'active' | 'recent'
  muted?: boolean
  now?: Date
}) {
  const presentation = presentRoomsInboxReason(session.reason)
  const isSelected = selected?.originId === session.identity.originId
    && selected.sessionAgentId === session.identity.sessionAgentId
  const relativeTime = session.reason === 'recently_updated'
    ? formatRoomsInboxRelativeTime(session.timestamp, now)
    : ''
  const reasonClass = session.reason

  return (
    <div
      className={cn(
        'sidebar-room-inbox-row group focus-within:ring-2 focus-within:ring-sidebar-ring/60',
        isSelected
          ? section === 'active'
            ? 'sidebar-room-row-selected'
            : 'sidebar-room-inbox-row-selected-neutral'
          : undefined,
      )}
    >
      <button
        type="button"
        data-inbox-row={`${session.identity.originId}::${session.identity.sessionAgentId}`}
        aria-current={isSelected ? 'true' : undefined}
        onClick={() => onSelectSession(session.identity)}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none"
      >
        <SidebarRoomAvatar
          label={session.profileName}
          toneKey={session.identity.profileId}
        />
        <span className="min-w-0 flex-1">
          <span className="sidebar-room-inbox-title">{session.label}</span>
          <span className={cn('sidebar-room-inbox-reason', `sidebar-room-inbox-reason--${reasonClass}`)}>
            {session.profileName} · {presentation.subtitle}
          </span>
        </span>
        <span className="sidebar-room-inbox-trailing">
          {session.pinnedAt ? <Pin className="sidebar-room-inbox-marker" aria-label="Pinned" /> : null}
          {muted ? <BellOff className="sidebar-room-inbox-marker" aria-label="Muted" /> : null}
          <InboxStatusPill session={session} />
          {session.identity.originId !== LOCAL_ORIGIN_ID ? <Globe className="sidebar-room-remote-marker" aria-label="Remote project" /> : null}
          {relativeTime ? <span className="sidebar-room-inbox-relative-time">{relativeTime}</span> : null}
        </span>
      </button>
      {showDone && onAcknowledge ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onAcknowledge()
          }}
          className="sidebar-room-inbox-done focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
          aria-label={`Mark "${session.label}" done for ${session.profileName} on ${session.identity.originId} (${session.identity.sessionAgentId})`}
        >
          Done
        </button>
      ) : null}
    </div>
  )
}

function InboxStatusPill({ session }: { session: RoomsInboxSessionViewModel }) {
  if (session.reason === 'decision_waiting') {
    return <span className="sidebar-room-status-pill sidebar-room-status-pill--awaiting" aria-label="Decision needed">?</span>
  }
  if (session.reason === 'awaiting_review') {
    return <span className="sidebar-room-status-pill sidebar-room-status-pill--review" aria-label="Ready for review" />
  }
  if (session.reason === 'compacting') {
    return <span className="sidebar-room-status-pill sidebar-room-status-pill--compacting sidebar-room-glow sidebar-room-compaction-glow" aria-label="Compacting context">C</span>
  }
  if (session.reason === 'manager_working') {
    if (session.activeWorkerCount > 0) {
      return <span className="sidebar-room-status-pill sidebar-room-status-pill--workers sidebar-room-glow" aria-label={`${session.activeWorkerCount} workers active`}>{session.activeWorkerCount}</span>
    }
    return <span className="sidebar-room-status-pill sidebar-room-status-pill--streaming sidebar-room-glow" aria-label="Manager streaming" />
  }
  if (session.reason === 'work_failed') {
    return <span className="sidebar-room-status-pill sidebar-room-status-pill--error" aria-label="Run failed"><CircleAlert className="size-3" aria-hidden="true" /></span>
  }
  if (session.attentionId && session.unreadCount > 0) {
    return <span className="sidebar-room-unread-badge" aria-label={`${session.unreadCount} unread updates`}>{session.unreadCount > 99 ? '99+' : session.unreadCount}</span>
  }
  return null
}
