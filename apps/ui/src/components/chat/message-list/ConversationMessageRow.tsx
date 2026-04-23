import { memo, useState, useCallback } from 'react'
import { Copy, Check, GitFork, Pin } from 'lucide-react'
import { MarkdownMessage } from '@/components/chat/MarkdownMessage'
import type { ArtifactReference } from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import { MessageAttachments } from './MessageAttachments'
import { MessageFeedback } from './MessageFeedback'
import { SourceBadge, formatTimestamp } from './message-row-utils'
import { getAuthorColor, getAuthorInitials } from './collab-author-utils'
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
  feedbackTargetId?: string
  feedbackLegacyTargetId?: string
  onArtifactClick?: (artifact: ArtifactReference) => void
  onForkFromMessage?: (messageId: string) => void
  onPinMessage?: (messageId: string, pinned: boolean) => void
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
  feedbackTargetId,
  feedbackLegacyTargetId,
  onArtifactClick,
  onForkFromMessage,
  onPinMessage,
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

  if (!hasText && attachments.length === 0) {
    return null
  }

  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext

  // Collab remote user: left-aligned with avatar/name
  if (
    surface === 'collab' &&
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

  if (message.role === 'system') {
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

  if (message.role === 'user') {
    const forkMessageId = message.id?.trim() || message.timestamp
    const canPin = onPinMessage && message.id?.trim()
    const isProjectAgentMessage = message.source === 'project_agent_input'
    const projectAgentSenderName = isProjectAgentMessage
      ? message.projectAgentContext?.fromDisplayName
      : undefined
    return (
      <div className="flex justify-end">
        <div
          className={cn(
            'max-w-[85%] rounded-lg rounded-tr-sm px-3 py-2',
            isProjectAgentMessage
              ? 'bg-blue-600 text-white dark:bg-blue-600'
              : 'bg-primary text-primary-foreground',
            message.pinned && 'ring-2 ring-amber-400/60 dark:ring-amber-500/50',
          )}
        >
          {message.pinned ? (
            <div className={cn(
              'mb-1 flex items-center gap-1 text-[10px]',
              isProjectAgentMessage ? 'text-white/70' : 'text-primary-foreground/70',
            )}>
              <Pin className="size-2.5 fill-current" />
              <span>Pinned</span>
            </div>
          ) : null}
          <div className="space-y-2">
            <MessageAttachments attachments={attachments} isUser wsUrl={wsUrl} />
            {hasText ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {normalizedText}
              </p>
            ) : null}
          </div>
          {timestampLabel || sourceContext || onForkFromMessage || canPin || projectAgentSenderName ? (
            <div className="mt-1 flex items-center justify-end gap-1.5">
              {projectAgentSenderName ? (
                <span className={cn(
                  'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
                  isProjectAgentMessage
                    ? 'border-white/30 bg-white/10 text-white/90'
                    : 'border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground/90',
                )}>
                  {projectAgentSenderName}
                </span>
              ) : (
                <SourceBadge sourceContext={sourceContext} isUser />
              )}
              {timestampLabel ? (
                <p className={cn(
                  'text-right text-[10px] leading-none',
                  isProjectAgentMessage ? 'text-white/70' : 'text-primary-foreground/70',
                )}>
                  {timestampLabel}
                </p>
              ) : null}
              {canPin ? (
                <button
                  type="button"
                  onClick={() => onPinMessage(message.id!, !message.pinned)}
                  className={cn(
                    'inline-flex size-5 items-center justify-center rounded-sm transition-colors',
                    message.pinned
                      ? 'text-amber-300 dark:text-amber-300'
                      : isProjectAgentMessage
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
                    isProjectAgentMessage
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
      {hasText ? (
        <MarkdownMessage
          content={normalizedText}
          onArtifactClick={onArtifactClick}
          artifactSourceAgentId={message.agentId}
          enableMermaid
        />
      ) : null}
      <MessageAttachments attachments={attachments} isUser={false} wsUrl={wsUrl} />
      {timestampLabel || sourceContext || showFeedback || onForkFromMessage || canPinAssistant ? (
        <div className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground/70">
          <SourceBadge sourceContext={sourceContext} />
          {timestampLabel ? <span>{timestampLabel}</span> : null}
          {hasText ? <CopyButton text={normalizedText} /> : null}
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
