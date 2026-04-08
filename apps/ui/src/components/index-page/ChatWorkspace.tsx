import type { ComponentPropsWithoutRef, RefObject } from 'react'
import { OnboardingCallout } from '@/components/chat/cortex/OnboardingCallout'
import { ChatHeader } from '@/components/chat/ChatHeader'
import { ChatSearchBar } from '@/components/chat/ChatSearchBar'
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput'
import { MessageList, type MessageListHandle } from '@/components/chat/MessageList'
import { WorkerBackBar } from '@/components/chat/WorkerBackBar'
import { WorkerPillBar } from '@/components/chat/WorkerPillBar'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import { cn } from '@/lib/utils'

interface ChatWorkspaceProps {
  headerProps: ComponentPropsWithoutRef<typeof ChatHeader>
  lastError: string | null
  lastSuccess: string | null
  chatSearchBarProps: ComponentPropsWithoutRef<typeof ChatSearchBar>
  showWelcomeForm: boolean
  showCreateManagerState: boolean
  welcomeCalloutProps: ComponentPropsWithoutRef<typeof OnboardingCallout>
  readyCalloutProps: ComponentPropsWithoutRef<typeof OnboardingCallout>
  isMessageListHidden: boolean
  messageListRef: RefObject<MessageListHandle | null>
  messageListProps: ComponentPropsWithoutRef<typeof MessageList>
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
  chatSearchBarProps,
  showWelcomeForm,
  showCreateManagerState,
  welcomeCalloutProps,
  readyCalloutProps,
  isMessageListHidden,
  messageListRef,
  messageListProps,
  workerPillBarProps,
  workerBackBarProps,
  terminalPanelProps,
  messageInputRef,
  messageInputProps,
}: ChatWorkspaceProps) {
  return (
    <>
      <ChatHeader {...headerProps} />

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
