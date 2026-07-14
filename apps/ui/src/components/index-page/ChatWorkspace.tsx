import { useEffect, useState, type ComponentPropsWithoutRef, type RefObject } from 'react'
import { OnboardingCallout } from '@/components/chat/cortex/OnboardingCallout'
import { ChatHeader } from '@/components/chat/ChatHeader'
import { ChatSearchBar } from '@/components/chat/ChatSearchBar'
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput'
import { MessageList, type MessageListHandle } from '@/components/chat/MessageList'
import { PlanDockIndicator } from '@/components/chat/plan'
import { GoalBar } from '@/components/chat/goal'
import { SessionAuditDrawer } from '@/components/chat/SessionAuditDrawer'
import { WorkerBackBar } from '@/components/chat/WorkerBackBar'
import { WorkerPillBar } from '@/components/chat/WorkerPillBar'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import { cn } from '@/lib/utils'
import type {
  RestartRecoverySnapshot,
  SessionGoalControlAction,
  SessionGoalSnapshotEvent,
  SessionPlanSnapshotEvent,
} from '@forge/protocol'

interface ChatWorkspaceProps {
  headerProps: ComponentPropsWithoutRef<typeof ChatHeader>
  lastError: string | null
  lastSuccess: string | null
  restartRecovery: RestartRecoverySnapshot | null
  onResumeRestartRecovery: () => void
  onDismissRestartRecovery: () => void
  chatSearchBarProps: ComponentPropsWithoutRef<typeof ChatSearchBar>
  showWelcomeForm: boolean
  showCreateManagerState: boolean
  welcomeCalloutProps: ComponentPropsWithoutRef<typeof OnboardingCallout>
  readyCalloutProps: ComponentPropsWithoutRef<typeof OnboardingCallout>
  isMessageListHidden: boolean
  messageListRef: RefObject<MessageListHandle | null>
  messageListProps: ComponentPropsWithoutRef<typeof MessageList>
  planSnapshot?: SessionPlanSnapshotEvent | null
  goalSnapshot?: SessionGoalSnapshotEvent | null
  onGoalAction: (action: SessionGoalControlAction) => void
  workerPillBarProps?: ComponentPropsWithoutRef<typeof WorkerPillBar>
  workerBackBarProps?: ComponentPropsWithoutRef<typeof WorkerBackBar>
  terminalPanelProps: ComponentPropsWithoutRef<typeof TerminalPanel>
  messageInputRef: RefObject<MessageInputHandle | null>
  messageInputProps: ComponentPropsWithoutRef<typeof MessageInput>
}

export function ChatWorkspace({
  headerProps,
  lastError,
  lastSuccess,
  restartRecovery,
  onResumeRestartRecovery,
  onDismissRestartRecovery,
  chatSearchBarProps,
  showWelcomeForm,
  showCreateManagerState,
  welcomeCalloutProps,
  readyCalloutProps,
  isMessageListHidden,
  messageListRef,
  messageListProps,
  planSnapshot,
  goalSnapshot,
  onGoalAction,
  workerPillBarProps,
  workerBackBarProps,
  terminalPanelProps,
  messageInputRef,
  messageInputProps,
}: ChatWorkspaceProps) {
  const [sessionAuditOpen, setSessionAuditOpen] = useState(false)
  const showSessionAudit = headerProps.activeAgentRole === 'manager' && Boolean(headerProps.activeAgentId)

  useEffect(() => {
    if (!showSessionAudit && sessionAuditOpen) {
      setSessionAuditOpen(false)
    }
  }, [sessionAuditOpen, showSessionAudit])

  return (
    <>
      <ChatHeader
        {...headerProps}
        showSessionAudit={showSessionAudit}
        onOpenSessionAudit={showSessionAudit ? () => setSessionAuditOpen(true) : undefined}
      />
      <SessionAuditDrawer
        open={sessionAuditOpen}
        onOpenChange={setSessionAuditOpen}
        sessionAgentId={showSessionAudit ? headerProps.activeAgentId : null}
        sessionLabel={headerProps.activeAgentLabel}
        wsUrl={headerProps.wsUrl}
      />

      <GoalBar snapshot={goalSnapshot} onAction={onGoalAction} />

      <RestartRecoveryBanner
        snapshot={restartRecovery}
        onResume={onResumeRestartRecovery}
        onDismiss={onDismissRestartRecovery}
      />

      {lastError ? (
        <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {lastError}
        </div>
      ) : null}

      {lastSuccess ? (
        <div className="border-b border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
          {lastSuccess}
        </div>
      ) : null}

      <ChatSearchBar {...chatSearchBarProps} />

      {showWelcomeForm ? (
        <OnboardingCallout {...welcomeCalloutProps} />
      ) : showCreateManagerState ? (
        <OnboardingCallout {...readyCalloutProps} />
      ) : (
        <>
          <div
            className={cn(
              'min-h-0 flex flex-1 flex-col overflow-hidden',
              isMessageListHidden && 'hidden',
            )}
          >
            <MessageList ref={messageListRef} {...messageListProps} />
          </div>

          <PlanDockIndicator snapshot={planSnapshot} />
          {workerPillBarProps ? <WorkerPillBar {...workerPillBarProps} /> : null}
          {workerBackBarProps ? <WorkerBackBar {...workerBackBarProps} /> : null}

          <div className="px-3">
            <TerminalPanel {...terminalPanelProps} />
          </div>

          <MessageInput ref={messageInputRef} {...messageInputProps} />
        </>
      )}
    </>
  )
}

function RestartRecoveryBanner({
  snapshot,
  onResume,
  onDismiss,
}: {
  snapshot: RestartRecoverySnapshot | null
  onResume: () => void
  onDismiss: () => void
}) {
  if (!snapshot || snapshot.dismissedAt || snapshot.resumedAt) {
    return null
  }

  const sessionIds = new Set<string>([
    ...snapshot.interruptedManagers,
    ...snapshot.undeliveredReports.map((report) => report.toAgentId),
  ])
  const workerCount = snapshot.interruptedWorkers.length

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
      <span className="font-medium">
        Restart interrupted {sessionIds.size} {sessionIds.size === 1 ? 'session' : 'sessions'} / {workerCount}{' '}
        {workerCount === 1 ? 'worker' : 'workers'}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className="rounded border border-amber-300/40 px-2 py-1 text-amber-50 hover:bg-amber-300/15"
          onClick={onResume}
        >
          Resume all
        </button>
        <button
          type="button"
          className="rounded border border-transparent px-2 py-1 text-amber-100/80 hover:bg-amber-300/10"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
