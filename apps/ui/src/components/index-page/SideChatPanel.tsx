import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Loader2, MessageSquareDashed, PanelRightClose, Trash2 } from 'lucide-react'
import type { ConversationAttachment } from '@forge/protocol'
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput'
import type { MessageInputSendOptions } from '@/components/chat/message-input/types'
import { MessageList, type MessageListHandle } from '@/components/chat/MessageList'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { usePendingResponse } from '@/hooks/index-page/use-pending-response'
import { useSideChatConnection } from '@/hooks/index-page/use-side-chat-connection'
import { useVisibleMessages } from '@/hooks/index-page/use-visible-messages'
import { useDrawerResize } from '@/hooks/use-drawer-resize'
import type { SideChatInitialMessage } from '@/hooks/index-page/use-side-chat'
import { cn } from '@/lib/utils'

const EMPTY_PENDING_CHOICE_IDS = new Set<string>()
const SIDE_CHAT_WIDTH_KEY = 'forge-side-chat-width'
const DEFAULT_SIDE_CHAT_WIDTH = 480
const MIN_SIDE_CHAT_WIDTH = 320
const MAX_SIDE_CHAT_WIDTH = 1200
/** Width the main chat always keeps beside the side chat. */
const MAIN_CHAT_MIN_REM = 28

export interface SideChatPanelProps {
  wsUrl: string
  originId: string
  /** Null while the fork is being created. */
  sideChatAgentId: string | null
  sourceLabel: string
  isExpanded: boolean
  initialMessage: SideChatInitialMessage | null
  onInitialMessageSent: () => void
  onExpand: () => void
  onCollapse: () => void
  onDiscard: () => void
}

export function SideChatPanel({
  wsUrl,
  originId,
  sideChatAgentId,
  sourceLabel,
  isExpanded,
  initialMessage,
  onInitialMessageSent,
  onExpand,
  onCollapse,
  onDiscard,
}: SideChatPanelProps) {
  // Collapsed panels do not hold a connection; expanding reconnects and rehydrates.
  const { clientRef, state } = useSideChatConnection({
    wsUrl,
    originId,
    agentId: isExpanded ? sideChatAgentId : null,
  })
  const asideRef = useRef<HTMLElement | null>(null)
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState(false)
  const getAvailableWidth = useCallback(() => {
    const container = asideRef.current?.parentElement
    if (!container) return MAX_SIDE_CHAT_WIDTH
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    return container.clientWidth - MAIN_CHAT_MIN_REM * rem
  }, [])
  const { width, isResizing, handleResizeStart } = useDrawerResize({
    storageKey: SIDE_CHAT_WIDTH_KEY,
    defaultWidth: DEFAULT_SIDE_CHAT_WIDTH,
    minWidth: MIN_SIDE_CHAT_WIDTH,
    maxWidth: MAX_SIDE_CHAT_WIDTH,
    getAvailableWidth,
  })
  const messageListRef = useRef<MessageListHandle | null>(null)
  const messageInputRef = useRef<MessageInputHandle | null>(null)

  // Guard against a client that fell back to another session (e.g. the side chat was deleted).
  const scopedState = state && sideChatAgentId && state.targetAgentId === sideChatAgentId ? state : null
  const sideChatAgent = scopedState?.agents.find((agent) => agent.agentId === sideChatAgentId) ?? null
  const status = sideChatAgentId ? scopedState?.statuses[sideChatAgentId]?.status ?? sideChatAgent?.status ?? null : null
  const messages = scopedState?.messages ?? []
  const { markPendingResponse, isAwaitingResponseStart } = usePendingResponse({
    activeAgentId: sideChatAgentId,
    activeAgentStatus: status,
    messages,
  })
  const { visibleMessages } = useVisibleMessages({
    messages,
    activityMessages: scopedState?.activityMessages ?? [],
    agents: scopedState?.agents ?? [],
    activeAgent: sideChatAgent,
    channelView: 'web',
  })
  const isLoading = status === 'streaming' || isAwaitingResponseStart
  const canSend = Boolean(
    scopedState?.connected &&
      scopedState.hasReceivedAgentsSnapshot &&
      scopedState.subscribedAgentId === sideChatAgentId,
  )

  const send = (text: string, attachments?: ConversationAttachment[], options?: MessageInputSendOptions) => {
    const client = clientRef.current
    if (!client || !sideChatAgentId || !canSend) return false
    markPendingResponse(sideChatAgentId, client.getState().messages.length)
    client.sendUserMessage(text, {
      agentId: sideChatAgentId,
      delivery: 'steer',
      attachments,
      replyTo: options?.replyTo,
    })
    return true
  }

  useEffect(() => {
    if (!initialMessage || initialMessage.agentId !== sideChatAgentId || !canSend) return
    onInitialMessageSent()
    send(initialMessage.text)
    // `send` reads fresh render state; only the readiness transition should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSend, initialMessage, onInitialMessageSent, sideChatAgentId])

  if (!isExpanded) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="absolute right-3 top-[70px] z-20 gap-1.5 shadow-sm"
        onClick={onExpand}
        aria-label="Open side chat"
      >
        <MessageSquareDashed className="size-3.5" aria-hidden="true" />
        Side chat
      </Button>
    )
  }

  const isCreating = !sideChatAgentId
  const isConnecting = !isCreating && !scopedState?.hasReceivedAgentsSnapshot

  return (
    <aside
      ref={asideRef}
      className={cn(
        // Drags stop at MAIN_CHAT_MIN_REM; the CSS cap also holds when the window later shrinks.
        'relative flex h-full shrink-0 flex-col bg-card/50 md:w-[var(--side-chat-width)] md:max-w-[calc(100%-28rem)] md:border-l md:border-border/80',
        'max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:bg-card',
      )}
      style={{ '--side-chat-width': `${width}px` } as CSSProperties}
      aria-label="Side chat"
    >
      <div
        className={cn(
          'absolute -left-1 top-0 bottom-0 z-10 hidden w-2 cursor-col-resize select-none md:block',
          'hover:bg-primary/20',
          isResizing && 'bg-primary/30',
        )}
        onMouseDown={handleResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side chat"
        aria-valuenow={width}
        aria-valuemin={MIN_SIDE_CHAT_WIDTH}
        aria-valuemax={MAX_SIDE_CHAT_WIDTH}
        title="Drag to resize"
      />
      <div className="flex h-[62px] shrink-0 items-center gap-2 border-b border-border/80 px-3">
        <MessageSquareDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">Side chat</h2>
          <p className="truncate text-[11px] text-muted-foreground">Forked from {sourceLabel}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          onClick={onCollapse}
          disabled={isCreating}
          aria-label="Hide side chat"
          title="Hide side chat"
        >
          <PanelRightClose className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setIsConfirmingDiscard(true)}
          aria-label="Discard side chat"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          Discard
        </Button>
        <AlertDialog open={isConfirmingDiscard} onOpenChange={setIsConfirmingDiscard}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard this side chat?</AlertDialogTitle>
              <AlertDialogDescription>
                The side chat and its conversation will be deleted. The main session is not affected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={onDiscard}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Discard
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {scopedState?.lastError ? (
        <div role="alert" className="whitespace-pre-wrap break-words border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {scopedState.lastError}
        </div>
      ) : null}

      {isCreating || isConnecting ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground" role="status">
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          {isCreating ? 'Starting side chat…' : 'Connecting…'}
        </div>
      ) : (
        <div className="min-h-0 flex flex-1 flex-col overflow-hidden">
          <MessageList
            ref={messageListRef}
            messages={visibleMessages}
            agents={scopedState?.agents}
            isLoading={isLoading}
            wsUrl={wsUrl}
            activeAgentId={sideChatAgentId}
            pendingChoiceIds={scopedState?.pendingChoiceIds ?? EMPTY_PENDING_CHOICE_IDS}
            onChoiceSubmit={(agentId, choiceId, answers) => clientRef.current?.sendChoiceResponse(agentId, choiceId, answers)}
            onChoiceCancel={(agentId, choiceId) => clientRef.current?.sendChoiceCancel(agentId, choiceId)}
            statuses={scopedState?.statuses}
            hasOlder={scopedState?.conversationPage?.hasOlder ?? false}
            olderCursor={scopedState?.conversationPage?.nextCursor}
            isLoadingOlder={scopedState?.conversationPageLoading ?? false}
            historyCompleteness={scopedState?.conversationPage?.completeness ?? 'complete'}
            historyMutation={scopedState?.conversationHistoryMutation}
            onLoadOlder={() => clientRef.current?.loadOlderConversation()}
            conversationBootstrapPhase={scopedState?.conversationBootstrap.phase}
            bootstrapErrorMessage={scopedState?.conversationBootstrap.errorMessage}
            onRetryBootstrap={() => clientRef.current?.retryConversationBootstrap()}
            streamingStartedAt={status === 'streaming' && sideChatAgentId ? scopedState?.statuses[sideChatAgentId]?.streamingStartedAt : undefined}
          />
        </div>
      )}

      <MessageInput
        ref={messageInputRef}
        onSend={send}
        onSubmitted={() => messageListRef.current?.scrollToBottom('smooth')}
        isLoading={isLoading}
        disabled={!canSend}
        allowWhileLoading
        agentLabel="side chat"
        wsUrl={wsUrl}
        agentId={sideChatAgentId ?? undefined}
      />
    </aside>
  )
}
