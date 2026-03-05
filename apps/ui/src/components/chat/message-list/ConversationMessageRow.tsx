import { useState, useCallback } from 'react'
import { Copy, Check } from 'lucide-react'
import { MarkdownMessage } from '@/components/chat/MarkdownMessage'
import type { ArtifactReference } from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import { MessageAttachments } from './MessageAttachments'
import { MessageFeedback } from './MessageFeedback'
import { SourceBadge, formatTimestamp } from './message-row-utils'
import type { ConversationMessageEntry } from './types'

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

interface ConversationMessageRowProps {
  message: ConversationMessageEntry
  feedbackTargetId?: string
  onArtifactClick?: (artifact: ArtifactReference) => void
  feedbackVote?: 'up' | 'down' | null
  feedbackHasComment?: boolean
  onFeedbackVote?: (
    scope: 'message' | 'session',
    targetId: string,
    value: 'up' | 'down',
    reasonCodes?: string[],
    comment?: string,
  ) => Promise<void>
  onFeedbackComment?: (
    scope: 'message' | 'session',
    targetId: string,
    comment: string,
  ) => Promise<void>
  onFeedbackClearComment?: (scope: 'message' | 'session', targetId: string) => Promise<void>
  isFeedbackSubmitting?: boolean
}

export function ConversationMessageRow({
  message,
  feedbackTargetId,
  onArtifactClick,
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
          <MessageAttachments attachments={attachments} isUser={false} />
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
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-primary px-3 py-2 text-primary-foreground">
          <div className="space-y-2">
            <MessageAttachments attachments={attachments} isUser />
            {hasText ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {normalizedText}
              </p>
            ) : null}
          </div>
          {timestampLabel || sourceContext ? (
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <SourceBadge sourceContext={sourceContext} isUser />
              {timestampLabel ? (
                <p className="text-right text-[10px] leading-none text-primary-foreground/70">
                  {timestampLabel}
                </p>
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

  return (
    <div className="min-w-0 space-y-2 text-foreground">
      {hasText ? (
        <MarkdownMessage content={normalizedText} onArtifactClick={onArtifactClick} />
      ) : null}
      <MessageAttachments attachments={attachments} isUser={false} />
      {timestampLabel || sourceContext || showFeedback ? (
        <div className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground/70">
          <SourceBadge sourceContext={sourceContext} />
          {timestampLabel ? <span>{timestampLabel}</span> : null}
          {hasText ? <CopyButton text={normalizedText} /> : null}
          {showFeedback ? (
            <MessageFeedback
              targetId={resolvedFeedbackTargetId}
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
}
