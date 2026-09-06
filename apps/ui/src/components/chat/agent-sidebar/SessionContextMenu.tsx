import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  BellOff,
  Copy,
  Edit3,
  EyeOff,
  GitFork,
  History,
  Pause,
  Pin,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  Share2,
  Terminal,
  Trash2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { isSessionRunning } from '@/lib/agent-hierarchy'
import type { SessionRow } from '@/lib/agent-hierarchy'

export interface SessionContextMenuActions {
  onStop?: () => void
  onResume?: () => void
  onDelete?: () => void
  onArchive?: () => void
  archiveDisabledReason?: string
  onRename?: () => void
  onFork?: () => void
  onMarkUnread?: () => void
  onPinSession?: (agentId: string, pinned: boolean) => void
  onPromoteToProjectAgent?: () => void
  onOpenProjectAgentSharing?: () => void
  onOpenProjectAgentSettings?: () => void
  onDemoteProjectAgent?: () => void
  onViewCreationHistory?: () => void
  onChangeSessionModel?: () => void
  onUseProjectDefault?: () => void
  isMutedSession?: boolean
  onToggleMute?: () => void
  hideCliSessions?: boolean
  onToggleHideCliSessions?: () => void
}

export function SessionContextMenu({
  session,
  actions,
  children,
}: {
  session: SessionRow
  actions: SessionContextMenuActions
  children: ReactNode
}) {
  const { sessionAgent, isDefault } = session
  const running = isSessionRunning(sessionAgent)
  const isProjectAgent = Boolean(sessionAgent.projectAgent)
  const isRepoSourcedAgent = sessionAgent.projectAgent?.sourceKind === 'repo' || sessionAgent.projectAgent?.source?.type === 'repo'
  const isPinned = Boolean(sessionAgent.pinnedAt)
  const isModelOverridden = sessionAgent.modelOrigin === 'session_override'
  const {
    onStop,
    onResume,
    onDelete,
    onArchive,
    archiveDisabledReason,
    onRename,
    onFork,
    onMarkUnread,
    onPinSession,
    onPromoteToProjectAgent,
    onOpenProjectAgentSharing,
    onOpenProjectAgentSettings,
    onDemoteProjectAgent,
    onViewCreationHistory,
    onChangeSessionModel,
    onUseProjectDefault,
    isMutedSession,
    onToggleMute,
    hideCliSessions,
    onToggleHideCliSessions,
  } = actions

  // Pre-compute whether each context-menu group has visible items so
  // separators are only rendered between non-empty groups.
  const hasGroup2 = Boolean(onRename)
    || (Boolean(onFork) && sessionAgent.sessionPurpose !== 'agent_creator')
    || (running && Boolean(onStop))
    || (!running && Boolean(onResume))
  const hasGroup3 = Boolean(onChangeSessionModel)
    || (isModelOverridden && Boolean(onUseProjectDefault))
    || (Boolean(onPromoteToProjectAgent) && !isProjectAgent && sessionAgent.sessionPurpose !== 'cortex_review' && sessionAgent.sessionPurpose !== 'agent_creator')
  const hasProjectAgentGroup = isProjectAgent && (
    Boolean(onOpenProjectAgentSharing)
    || Boolean(onOpenProjectAgentSettings)
    || Boolean(onViewCreationHistory)
    || Boolean(onDemoteProjectAgent)
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* ── Group 1: Quick state / visibility ── */}
        {onMarkUnread ? (
          <ContextMenuItem onClick={() => onMarkUnread()}>
            <EyeOff className="mr-2 size-3.5" />
            Mark as unread
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          onClick={() => {
            const sessionDir = sessionAgent.sessionFile.replace(/\/[^/]+$/, '')
            navigator.clipboard.writeText(sessionDir)
          }}
        >
          <Copy className="mr-2 size-3.5" />
          Copy session data path
        </ContextMenuItem>
        {onPinSession && sessionAgent.profileId ? (
          <ContextMenuItem onClick={() => onPinSession(sessionAgent.agentId, !isPinned)}>
            <Pin className="mr-2 size-3.5" />
            {isPinned ? 'Unpin' : 'Pin'}
          </ContextMenuItem>
        ) : null}
        {onToggleMute ? (
          <ContextMenuItem onClick={() => onToggleMute()}>
            <BellOff className="mr-2 size-3.5" />
            {isMutedSession ? 'Unmute' : 'Mute'}
          </ContextMenuItem>
        ) : null}
        {onToggleHideCliSessions && Boolean(sessionAgent.cli) ? (
          <ContextMenuItem onClick={() => onToggleHideCliSessions()}>
            <Terminal className="mr-2 size-3.5" />
            {hideCliSessions ? 'Show CLI Sessions' : 'Hide CLI Sessions'}
          </ContextMenuItem>
        ) : null}

        {/* ── Group 2: Session operations ── */}
        {hasGroup2 ? <ContextMenuSeparator /> : null}
        {onRename ? (
          <ContextMenuItem onClick={() => onRename()}>
            <Edit3 className="mr-2 size-3.5" />
            Rename
          </ContextMenuItem>
        ) : null}
        {onFork && sessionAgent.sessionPurpose !== 'agent_creator' ? (
          <ContextMenuItem onClick={() => onFork()}>
            <GitFork className="mr-2 size-3.5" />
            Fork
          </ContextMenuItem>
        ) : null}
        {running && onStop ? (
          <ContextMenuItem onClick={() => onStop()}>
            <Pause className="mr-2 size-3.5" />
            Stop
          </ContextMenuItem>
        ) : null}
        {!running && onResume ? (
          <ContextMenuItem onClick={() => onResume()}>
            <Play className="mr-2 size-3.5" />
            Resume
          </ContextMenuItem>
        ) : null}

        {/* ── Group 3: Configuration & agent lifecycle ── */}
        {hasGroup3 ? <ContextMenuSeparator /> : null}
        {onChangeSessionModel ? (
          <ContextMenuItem onClick={() => onChangeSessionModel()}>
            <RefreshCw className="mr-2 size-3.5" />
            {isModelOverridden ? 'Change Session Model' : 'Override Session Model'}
          </ContextMenuItem>
        ) : null}
        {isModelOverridden && onUseProjectDefault ? (
          <ContextMenuItem onClick={() => onUseProjectDefault()}>
            <RotateCcw className="mr-2 size-3.5" />
            Use Project Default
          </ContextMenuItem>
        ) : null}
        {onPromoteToProjectAgent && !isProjectAgent && sessionAgent.sessionPurpose !== 'cortex_review' && sessionAgent.sessionPurpose !== 'agent_creator' ? (
          <ContextMenuItem onClick={() => onPromoteToProjectAgent()}>
            <ArrowUpFromLine className="mr-2 size-3.5" />
            Promote to Project Agent
          </ContextMenuItem>
        ) : null}
        {/* ── Group 4: Project Agent sharing & lifecycle ── */}
        {hasProjectAgentGroup ? <ContextMenuSeparator /> : null}
        {isProjectAgent && onOpenProjectAgentSharing ? (
          <ContextMenuItem onClick={() => onOpenProjectAgentSharing()}>
            <Share2 className="mr-2 size-3.5" />
            Share Project Agent…
          </ContextMenuItem>
        ) : null}
        {isProjectAgent && onOpenProjectAgentSettings ? (
          <ContextMenuItem onClick={() => onOpenProjectAgentSettings()}>
            <Settings className="mr-2 size-3.5" />
            Project Agent Settings
          </ContextMenuItem>
        ) : null}
        {isProjectAgent && onViewCreationHistory ? (
          <ContextMenuItem onClick={() => onViewCreationHistory()}>
            <History className="mr-2 size-3.5" />
            View Creation History
          </ContextMenuItem>
        ) : null}
        {isProjectAgent && onDemoteProjectAgent ? (
          <ContextMenuItem onClick={() => {
            try {
              void Promise.resolve(onDemoteProjectAgent()).catch((err) => {
                console.error(isRepoSourcedAgent ? 'Failed to unlink repository project agent:' : 'Failed to demote project agent:', err)
              })
            } catch (err) {
              console.error(isRepoSourcedAgent ? 'Failed to unlink repository project agent:' : 'Failed to demote project agent:', err)
            }
          }}>
            <ArrowDownToLine className="mr-2 size-3.5" />
            {isRepoSourcedAgent ? 'Unlink from Repository Definition' : 'Demote to Session'}
          </ContextMenuItem>
        ) : null}

        {/* ── Group 5: Archive / destructive ── */}
        {(onArchive || archiveDisabledReason || (!isDefault && onDelete)) ? (
          <ContextMenuSeparator />
        ) : null}
        {onArchive ? (
          <ContextMenuItem onClick={() => onArchive()}>
            <Archive className="mr-2 size-3.5" />
            Archive
          </ContextMenuItem>
        ) : archiveDisabledReason ? (
          <ContextMenuItem disabled title={archiveDisabledReason}>
            <Archive className="mr-2 size-3.5" />
            {archiveDisabledReason}
          </ContextMenuItem>
        ) : null}
        {!isDefault && onDelete ? (
          <ContextMenuItem variant="destructive" onClick={() => onDelete()}>
            <Trash2 className="mr-2 size-3.5" />
            Delete
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
