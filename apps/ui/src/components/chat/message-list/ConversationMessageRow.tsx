import { memo, useState, useCallback } from 'react'
import { isUserVisibleAssistantConversationMessage } from '@forge/protocol'
import { Copy, Check, GitFork, Pin, Reply } from 'lucide-react'
import { MarkdownMessage } from '@/components/chat/MarkdownMessage'
import type { ArtifactReference } from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import { MessageAttachments } from './MessageAttachments'
import { MessageFeedback } from './MessageFeedback'
import { SourceBadge, formatTimestamp } from './message-row-utils'
import { getAuthorColor, getAuthorInitials } from './collab-author-utils'
import { ExternalThreadContextCard } from './ExternalThreadContextCard'
import { ProjectAgentMessageRow } from './ProjectAgentMessageRow'
import { ReplyPreview } from './ReplyPreview'
import type { ConversationMessageEntry, MessageListSurface } from './types'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [text])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'inline-flex size-5 items-center justify-center rounded-sm transition-colors',
        copied
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-muted-foreground/50 hover:text-muted-foreground',
      )}
      aria-label={copied ? 'Copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy message'}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  )
}

function ForkButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground/50 transition-colors hover:text-muted-foreground"
      aria-label="Fork from this message"
      title="Fork from this message"
    >
      <GitFork className="size-3" />
    </button>
  )
}

function ReplyButton({ onClick, userTone = false }: { onClick: () => void; userTone?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex size-6 items-center justify-center rounded-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        userTone
          ? 'text-primary-foreground/70 hover:bg-primary-foreground/10 hover:text-primary-foreground'
          : 'text-muted-foreground/70 hover:text-foreground',
      )}
      aria-label="Reply to this message"
      title="Reply"
    >
      <Reply className="size-3.5" />
    </button>
  )
}

function PinButton({ pinned, onClick }: { pinned: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex size-5 items-center justify-center rounded-sm transition-colors',
        pinned
          ? 'text-amber-500 dark:text-amber-400'
          : 'text-muted-foreground/50 hover:text-muted-foreground',
      )}
      aria-label={pinned ? 'Unpin message' : 'Pin message (preserve through compaction)'}
      title={pinned ? 'Unpin message' : 'Pin message (preserve through compaction)'}
    >
      <Pin className={cn('size-3', pinned && 'fill-current')} />
    </button>
  )
}

interface ConversationMessageRowProps {
  message: ConversationMessageEntry
  wsUrl?: string
  surface?: MessageListSurface
  currentCollabUserId?: string
  activeAgentDisplayName?: string
  transcriptAgentId?: string | null
  feedbackTargetId?: string
  feedbackLegacyTargetId?: string
  onArtifactClick?: (artifact: ArtifactReference) => void
  onForkFromMessage?: (messageId: string) => void
  onPinMessage?: (messageId: string, pinned: boolean) => void
  onStopExternalThread?: (sidecarAgentId: string) => void
  canStopExternalThread?: boolean
  onReplyToMessage?: (message: ConversationMessageEntry) => void
  onReplyPreviewClick?: (messageId: string) => void
  isReplyTargetLoaded?: (messageId: string) => boolean
  feedbackVote?: 'up' | 'down' | null
  feedbackHasComment?: boolean
  onFeedbackVote?: (
    scope: 'message' | 'session',
    targetId: string,
    value: 'up' | 'down',
    reasonCodes?: string[],
    comment?: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  onFeedbackComment?: (
    scope: 'message' | 'session',
    targetId: string,
    comment: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  onFeedbackClearComment?: (
    scope: 'message' | 'session',
    targetId: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  isFeedbackSubmitting?: boolean
}

export const ConversationMessageRow = memo(function ConversationMessageRow({
  message,
  wsUrl,
  surface = 'builder',
  currentCollabUserId,
  activeAgentDisplayName,
  transcriptAgentId,
  feedbackTargetId,
  feedbackLegacyTargetId,
  onArtifactClick,
  onForkFromMessage,
  onPinMessage,
  onStopExternalThread,
  canStopExternalThread,
  onReplyToMessage,
  onReplyPreviewClick,
  isReplyTargetLoaded,
  feedbackVote,
  feedbackHasComment,
  onFeedbackVote,
  onFeedbackComment,
  onFeedbackClearComment,
  isFeedbackSubmitting,
}: ConversationMessageRowProps) {
  const normalizedText = message.text.trim()
  const hasText = normalizedText.length > 0 && normalizedText !== '.'
  const attachments = message.attachments ?? []
  const externalThreadContext =
    message.role === 'system' && message.externalThreadContext?.type === 'codex_app_server'
      ? message.externalThreadContext
      : null

  if (!hasText && attachments.length === 0 && !externalThreadContext) {
    return null
  }

  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext

  // Attributed message from ANOTHER user: left-aligned with avatar/name.
  // Applies on the collab surface and on builder transcripts whose origin
  // has a signed-in identity (Wave R remote origins, SPEC §5.5). The local
  // origin passes no currentCollabUserId and its messages carry no author,
  // so local transcripts never render chips.
  if (
    (surface === 'collab' || currentCollabUserId !== undefined) &&
    message.role === 'user' &&
    message.collaborationAuthor &&
    message.collaborationAuthor.userId !== currentCollabUserId
  ) {
    return (
      <CollabRemoteUserRow
        message={message}
        timestampLabel={timestampLabel}
        wsUrl={wsUrl}
      />
    )
  }

  if (externalThreadContext) {
    const sidecarAgentId = externalThreadContext.sidecarAgentId?.trim() ?? ''
    const stopDisabled =
      !onStopExternalThread || sidecarAgentId.length === 0 || canStopExternalThread !== true

    return (
      <ExternalThreadContextCard
        context={externalThreadContext}
        text={normalizedText}
        timestampLabel={timestampLabel}
        showStop={canStopExternalThread === true}
        onStop={() => onStopExternalThread?.(sidecarAgentId)}
        stopDisabled={stopDisabled}
      />
    )
  }

  if (message.role === 'system') {
    if (message.source === 'worker_report') {
      const sourceWorkerId = message.sourceWorkerId?.trim()
      const workerLabel = sourceWorkerId ? `Worker result · ${sourceWorkerId}` : 'Worker result'

      return (
        <div
          className="rounded-lg border border-indigo-300/70 bg-indigo-50/70 px-3 py-2 text-sm text-indigo-950 dark:border-indigo-400/30 dark:bg-indigo-500/10 dark:text-indigo-100"
          data-worker-result-source={sourceWorkerId || undefined}
        >
          <div className="break-words text-[11px] font-medium uppercase tracking-wide text-indigo-700 dark:text-indigo-300/90">
            {workerLabel}
          </div>
          <div className="mt-1 space-y-2">
            {hasText ? (
              <p className="whitespace-pre-wrap break-words leading-relaxed">
                {normalizedText}
              </p>
            ) : null}
            <MessageAttachments attachments={attachments} isUser={false} wsUrl={wsUrl} />
          </div>
          {timestampLabel ? (
            <div className="mt-1 text-[11px] text-indigo-700/80 dark:text-indigo-300/80">
              <span>{timestampLabel}</span>
            </div>
          ) : null}
        </div>
      )
    }

    // Informational notices (auto-surfaced worker outcomes) get a calm,
    // neutral presentation; the amber styling stays reserved for warnings and
    // errors so its signal is not diluted.
    const isWorkerOutcomeNotice = message.systemNoticeKind === 'worker_outcome_backstop'
    if (isWorkerOutcomeNotice) {
      return (
        <div className="rounded-lg border border-sky-300/60 bg-sky-50/60 px-3 py-2 text-sm text-sky-950 dark:border-sky-400/25 dark:bg-sky-500/10 dark:text-sky-100">
          <div className="text-[11px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300/90">
            Worker outcome · auto-surfaced
          </div>
          <div className="mt-1 space-y-2">
            {hasText ? (
              <p className="whitespace-pre-wrap break-words leading-relaxed">
                {normalizedText}
              </p>
            ) : null}
          </div>
          {timestampLabel ? (
            <div className="mt-1 text-[11px] text-sky-700/80 dark:text-sky-300/80">
              <span>{timestampLabel}</span>
            </div>
          ) : null}
        </div>
      )
    }

    return (
      <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-sm text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
        <div className="text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300/90">
          System
        </div>
        <div className="mt-1 space-y-2">
          {hasText ? (
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {normalizedText}
            </p>
          ) : null}
          <MessageAttachments attachments={attachments} isUser={false} wsUrl={wsUrl} />
        </div>
        {timestampLabel || sourceContext ? (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-700/80 dark:text-amber-300/80">
            <SourceBadge sourceContext={sourceContext} />
            {timestampLabel ? <span>{timestampLabel}</span> : null}
          </div>
        ) : null}
      </div>
    )
  }

  if (message.role === 'user' && message.source === 'project_agent_input') {
    const senderName = message.projectAgentContext?.fromDisplayName?.trim()
      || message.projectAgentContext?.fromAgentId?.trim()
      || 'Project agent'
    const senderLabel = message.projectAgentContext?.external && message.projectAgentContext.fromProjectName
      ? `${senderName} · ${message.projectAgentContext.fromProjectName}`
      : senderName

    return (
      <ProjectAgentMessageRow
        text={message.text}
        fromLabel={senderLabel}
        toLabel={activeAgentDisplayName?.trim() || 'Manager'}
        outgoing={false}
        timestamp={message.timestamp}
      />
    )
  }

  if (message.role === 'user') {
    const forkMessageId = message.id?.trim() || message.timestamp
    const canPin = onPinMessage && message.id?.trim()
    const isCliMessage = sourceContext?.channel === 'cli'
    return (
      <div className="flex justify-end">
        <div
          className={cn(
            'max-w-[85%] rounded-lg rounded-tr-sm px-3 py-2',
            isCliMessage
              ? 'bg-violet-600 text-white dark:bg-violet-600'
              : 'bg-primary text-primary-foreground',
            message.pinned && 'ring-2 ring-amber-400/60 dark:ring-amber-500/50',
          )}
        >
          {message.pinned ? (
            <div className={cn(
              'mb-1 flex items-center gap-1 text-[10px]',
              isCliMessage ? 'text-white/70' : 'text-primary-foreground/70',
            )}>
              <Pin className="size-2.5 fill-current" />
              <span>Pinned</span>
            </div>
          ) : null}
          <div className="space-y-2">
            {message.replyTo && onReplyPreviewClick ? (
              <ReplyPreview
                target={message.replyTo}
                tone="user-message"
                interactive
                disabled={!isReplyTargetLoaded?.(message.replyTo.messageId)}
                onClick={() => onReplyPreviewClick(message.replyTo!.messageId)}
                className="mb-1"
              />
            ) : message.replyTo ? (
              <ReplyPreview
                target={message.replyTo}
                tone="user-message"
                className="mb-1"
              />
            ) : null}
            <MessageAttachments attachments={attachments} isUser wsUrl={wsUrl} />
            {hasText ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {normalizedText}
              </p>
            ) : null}
          </div>
          {timestampLabel || sourceContext || onForkFromMessage || canPin || onReplyToMessage ? (
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <SourceBadge sourceContext={sourceContext} isUser />
              {timestampLabel ? (
                <p className={cn(
                  'text-right text-[10px] leading-none',
                  isCliMessage ? 'text-white/70' : 'text-primary-foreground/70',
                )}>
                  {timestampLabel}
                </p>
              ) : null}
              {onReplyToMessage && message.id?.trim() ? (
                <ReplyButton
                  userTone
                  onClick={() => onReplyToMessage(message)}
                />
              ) : null}
              {canPin ? (
                <button
                  type="button"
                  onClick={() => onPinMessage(message.id!, !message.pinned)}
                  className={cn(
                    'inline-flex size-5 items-center justify-center rounded-sm transition-colors',
                    message.pinned
                      ? 'text-amber-300 dark:text-amber-300'
                      : isCliMessage
                        ? 'text-white/50 hover:text-white'
                        : 'text-primary-foreground/50 hover:text-primary-foreground',
                  )}
                  aria-label={message.pinned ? 'Unpin message' : 'Pin message (preserve through compaction)'}
                  title={message.pinned ? 'Unpin message' : 'Pin message (preserve through compaction)'}
                >
                  <Pin className={cn('size-3', message.pinned && 'fill-current')} />
                </button>
              ) : null}
              {onForkFromMessage ? (
                <button
                  type="button"
                  onClick={() => onForkFromMessage(forkMessageId)}
                  className={cn(
                    'inline-flex size-5 items-center justify-center rounded-sm transition-colors',
                    isCliMessage
                      ? 'text-white/50 hover:text-white'
                      : 'text-primary-foreground/50 hover:text-primary-foreground',
                  )}
                  aria-label="Fork from this message"
                  title="Fork from this message"
                >
                  <GitFork className="size-3" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  const showFeedback = message.role === 'assistant' && onFeedbackVote
  const resolvedFeedbackTargetId =
    feedbackTargetId?.trim() || message.id?.trim() || message.timestamp
  const resolvedFeedbackLegacyTargetId = feedbackLegacyTargetId?.trim()
  const assistantForkMessageId = message.id?.trim() || message.timestamp
  const canPinAssistant = onPinMessage && message.id?.trim()
  const artifactMessageId = message.id?.trim()
  const artifactTranscriptAgentId =
    artifactMessageId && transcriptAgentId?.trim() && isUserVisibleAssistantConversationMessage(message)
      ? transcriptAgentId.trim()
      : undefined

  return (
    <div
      className={cn(
        'min-w-0 space-y-2 text-foreground',
        message.pinned && 'rounded-lg border-l-2 border-amber-400/60 pl-3 dark:border-amber-500/50',
      )}
    >
      {message.pinned ? (
        <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
          <Pin className="size-2.5 fill-current" />
          <span>Pinned</span>
        </div>
      ) : null}
      {message.replyTo && onReplyPreviewClick ? (
        <ReplyPreview
          target={message.replyTo}
          interactive
          disabled={!isReplyTargetLoaded?.(message.replyTo.messageId)}
          onClick={() => onReplyPreviewClick(message.replyTo!.messageId)}
          className="max-w-2xl"
        />
      ) : message.replyTo ? (
        <ReplyPreview
          target={message.replyTo}
          className="max-w-2xl"
        />
      ) : null}
      {hasText ? (
        <MarkdownMessage
          content={normalizedText}
          onArtifactClick={onArtifactClick}
          artifactSourceAgentId={message.agentId}
          artifactTranscriptAgentId={artifactTranscriptAgentId}
          artifactMessageId={artifactTranscriptAgentId ? artifactMessageId : undefined}
          enableMermaid
        />
      ) : null}
      <MessageAttachments attachments={attachments} isUser={false} wsUrl={wsUrl} />
      {timestampLabel || sourceContext || showFeedback || onForkFromMessage || canPinAssistant || onReplyToMessage ? (
        <div className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground/70">
          <SourceBadge sourceContext={sourceContext} />
          {timestampLabel ? <span>{timestampLabel}</span> : null}
          {hasText ? <CopyButton text={normalizedText} /> : null}
          {onReplyToMessage && message.id?.trim() ? (
            <ReplyButton onClick={() => onReplyToMessage(message)} />
          ) : null}
          {canPinAssistant ? (
            <PinButton
              pinned={!!message.pinned}
              onClick={() => onPinMessage(message.id!, !message.pinned)}
            />
          ) : null}
          {onForkFromMessage ? (
            <ForkButton onClick={() => onForkFromMessage(assistantForkMessageId)} />
          ) : null}
          {showFeedback ? (
            <MessageFeedback
              targetId={resolvedFeedbackTargetId}
              legacyTargetId={
                resolvedFeedbackLegacyTargetId &&
                resolvedFeedbackLegacyTargetId !== resolvedFeedbackTargetId
                  ? resolvedFeedbackLegacyTargetId
                  : undefined
              }
              currentVote={feedbackVote ?? null}
              hasComment={feedbackHasComment}
              onVote={onFeedbackVote}
              onComment={onFeedbackComment}
              onClearComment={onFeedbackClearComment}
              isSubmitting={isFeedbackSubmitting}
              scope="message"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Collab remote user row — left-aligned with avatar and author name
// ---------------------------------------------------------------------------

function CollabRemoteUserRow({
  message,
  timestampLabel,
  wsUrl,
}: {
  message: ConversationMessageEntry
  timestampLabel: string
  wsUrl?: string
}) {
  const author = message.collaborationAuthor
  const authorName = author?.displayName?.trim() || 'User'
  const authorId = author?.userId ?? authorName
  const avatarColor = getAuthorColor(authorId)
  const initials = getAuthorInitials(authorName)
  const normalizedText = message.text.trim()
  const hasText = normalizedText.length > 0 && normalizedText !== '.'
  const attachments = message.attachments ?? []

  return (
    <div className="flex items-start gap-3">
      <div className="flex w-10 shrink-0 justify-center pt-0.5">
        <div
          className="flex size-9 items-center justify-center rounded-full text-xs font-semibold text-white shadow-sm"
          style={{ backgroundColor: avatarColor }}
          aria-hidden="true"
        >
          {initials}
        </div>
      </div>

      <div className="min-w-0 max-w-2xl flex-1 lg:max-w-3xl">
        <div className="mb-1 px-1 text-sm font-medium text-foreground">
          {authorName}
        </div>

        <div className="rounded-2xl rounded-tl-md border border-border/60 bg-card/80 px-4 py-2.5 text-sm text-foreground shadow-sm">
          {attachments.length > 0 ? (
            <div className={cn(hasText && 'mb-2')}>
              <MessageAttachments attachments={attachments} isUser={false} wsUrl={wsUrl} />
            </div>
          ) : null}
          {hasText ? (
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {normalizedText}
            </p>
          ) : null}
        </div>

        {timestampLabel ? (
          <div className="mt-1 px-1 text-[11px] text-muted-foreground">{timestampLabel}</div>
        ) : null}
      </div>
    </div>
  )
}
