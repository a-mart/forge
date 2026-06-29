import { useState } from 'react'
import { MessageCircleMore, ThumbsDown, ThumbsUp, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { type FeedbackReasonCode } from '@/lib/feedback-types'

const REASON_LABELS: Record<FeedbackReasonCode, string> = {
  accuracy: 'Accuracy',
  instruction_following: 'Instruction Following',
  autonomy: 'Autonomy',
  speed: 'Speed',
  verbosity: 'Verbosity',
  formatting: 'Formatting',
  product_ux_direction: 'Product/UX Direction',
  needs_clarification: 'Needs Clarification',
  over_engineered: 'Over-Engineered',
  great_outcome: 'Great Outcome',
  poor_outcome: 'Poor Outcome',
}

const UP_REASON_CODES: FeedbackReasonCode[] = [
  'accuracy',
  'instruction_following',
  'formatting',
  'product_ux_direction',
  'needs_clarification',
  'great_outcome',
]

const DOWN_REASON_CODES: FeedbackReasonCode[] = [
  'accuracy',
  'instruction_following',
  'speed',
  'verbosity',
  'formatting',
  'product_ux_direction',
  'needs_clarification',
  'over_engineered',
]

interface MessageFeedbackProps {
  targetId: string
  legacyTargetId?: string
  currentVote: 'up' | 'down' | null
  hasComment?: boolean
  onVote: (
    scope: 'message' | 'session',
    targetId: string,
    value: 'up' | 'down',
    reasonCodes?: string[],
    comment?: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  onComment?: (
    scope: 'message' | 'session',
    targetId: string,
    comment: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  onClearComment?: (
    scope: 'message' | 'session',
    targetId: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  isSubmitting?: boolean
  scope?: 'message' | 'session'
  /** Slightly larger for header-level usage */
  size?: 'sm' | 'md'
}

type FeedbackMode = 'menu' | 'up' | 'down' | 'comment'

export function MessageFeedback({
  targetId,
  legacyTargetId,
  currentVote,
  hasComment = false,
  onVote,
  onComment,
  onClearComment,
  isSubmitting = false,
  scope = 'message',
  size = 'sm',
}: MessageFeedbackProps) {
  const [mode, setMode] = useState<FeedbackMode>('menu')
  const [isOpen, setIsOpen] = useState(false)
  const [selectedReasons, setSelectedReasons] = useState<FeedbackReasonCode[]>([])
  const [comment, setComment] = useState('')

  const iconSize = size === 'sm' ? 'size-3.5' : 'size-4'
  const buttonSize = size === 'sm' ? 'size-6' : 'size-7'

  const resetDraft = () => {
    setSelectedReasons([])
    setComment('')
  }

  const openMode = (nextMode: FeedbackMode) => {
    resetDraft()
    setMode(nextMode)
    setIsOpen(true)
  }

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    if (!open) {
      setMode('menu')
      resetDraft()
    }
  }

  const handleGoodResponse = () => {
    if (isSubmitting) return
    if (currentVote === 'up') {
      openMode('up')
      return
    }
    void onVote(scope, targetId, 'up', undefined, undefined, legacyTargetId)
    handleOpenChange(false)
  }

  const handleNeedsWork = () => {
    if (isSubmitting) return
    openMode('down')
  }

  const handleCommentClick = () => {
    if (isSubmitting || !onComment) return
    openMode('comment')
  }

  const handleReasonToggle = (code: FeedbackReasonCode) => {
    setSelectedReasons((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    )
  }

  const handleSubmit = () => {
    if (mode === 'comment') {
      if (onComment && comment.trim()) {
        void onComment(scope, targetId, comment.trim(), legacyTargetId)
      }
    } else if (mode === 'up' || mode === 'down') {
      void onVote(
        scope,
        targetId,
        mode,
        selectedReasons,
        comment.trim() || undefined,
        legacyTargetId,
      )
    }
    handleOpenChange(false)
  }

  const handleClearVote = () => {
    if (mode !== 'up' && mode !== 'down') return
    // Send bare vote (no reasons) — hook treats same-value + no reasons as toggle-off.
    void onVote(
      scope,
      targetId,
      mode,
      undefined,
      undefined,
      legacyTargetId,
    )
    handleOpenChange(false)
  }

  const handleClearComment = () => {
    if (onClearComment) {
      void onClearComment(scope, targetId, legacyTargetId)
    }
    handleOpenChange(false)
  }

  const triggerLabel = currentVote === 'up'
    ? 'Feedback: good response'
    : currentVote === 'down'
      ? 'Feedback: needs work'
      : hasComment
        ? 'Feedback: comment added'
        : 'Feedback'

  const triggerTone = currentVote === 'up'
    ? 'text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300'
    : currentVote === 'down'
      ? 'text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300'
      : hasComment
        ? 'text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300'
        : 'text-muted-foreground/55 hover:text-muted-foreground'

  const renderMenu = () => (
    <div className="space-y-1 p-1" role="menu" aria-label="Feedback options">
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted focus:bg-muted focus:outline-none"
        onClick={handleGoodResponse}
        disabled={isSubmitting}
      >
        <ThumbsUp
          className={cn(
            'size-3.5',
            currentVote === 'up' && 'fill-current text-emerald-600 dark:text-emerald-400',
          )}
        />
        <span>Good response</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted focus:bg-muted focus:outline-none"
        onClick={handleNeedsWork}
        disabled={isSubmitting}
      >
        <ThumbsDown
          className={cn(
            'size-3.5',
            currentVote === 'down' && 'fill-current text-red-500 dark:text-red-400',
          )}
        />
        <span>Needs work</span>
      </button>
      {onComment ? (
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted focus:bg-muted focus:outline-none"
          onClick={handleCommentClick}
          disabled={isSubmitting}
        >
          <MessageSquare
            className={cn(
              'size-3.5',
              hasComment && 'fill-current text-blue-500 dark:text-blue-400',
            )}
          />
          <span>{hasComment ? 'Edit comment' : 'Add comment'}</span>
        </button>
      ) : null}
    </div>
  )

  const renderVoteContent = (direction: 'up' | 'down') => (
    <div className="space-y-3 p-3">
      <p className="text-xs font-medium text-foreground">
        {direction === 'up' ? 'What was good?' : 'What went wrong?'}
      </p>
      <div className="space-y-1.5">
        {(direction === 'up' ? UP_REASON_CODES : DOWN_REASON_CODES).map((code) => (
          <div key={code} className="flex items-center gap-2">
            <Checkbox
              id={`reason-${targetId}-${direction}-${code}`}
              checked={selectedReasons.includes(code)}
              onCheckedChange={() => handleReasonToggle(code)}
              className="size-3.5"
            />
            <Label
              htmlFor={`reason-${targetId}-${direction}-${code}`}
              className="cursor-pointer text-xs font-normal text-foreground/80"
            >
              {REASON_LABELS[code]}
            </Label>
          </div>
        ))}
      </div>
      <Textarea
        placeholder="Optional comment…"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="min-h-[52px] resize-none text-xs"
        rows={2}
        maxLength={2000}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 flex-1 text-xs"
          onClick={handleSubmit}
          disabled={isSubmitting}
        >
          Submit
        </Button>
        {currentVote === direction ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={handleClearVote}
            disabled={isSubmitting}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  )

  const renderCommentContent = () => (
    <div className="space-y-3 p-3">
      <p className="text-xs font-medium text-foreground">
        {hasComment ? 'Edit comment' : 'Add a comment'}
      </p>
      <Textarea
        placeholder="Your comment…"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="min-h-[60px] resize-none text-xs"
        rows={3}
        maxLength={2000}
        autoFocus
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 flex-1 text-xs"
          onClick={handleSubmit}
          disabled={isSubmitting || !comment.trim()}
        >
          Submit
        </Button>
        {hasComment ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={handleClearComment}
            disabled={isSubmitting}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  )

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={isSubmitting}
          className={cn(
            'inline-flex items-center justify-center rounded-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            buttonSize,
            triggerTone,
            isSubmitting && 'pointer-events-none opacity-50',
          )}
          aria-label={triggerLabel}
          aria-pressed={currentVote !== null || hasComment}
          title="Feedback"
        >
          <MessageCircleMore
            className={cn(iconSize, (currentVote !== null || hasComment) && 'fill-current')}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        className={cn('p-0', mode === 'menu' ? 'w-44' : 'w-64')}
        onOpenAutoFocus={(event) => {
          if (mode !== 'comment') event.preventDefault()
        }}
      >
        {mode === 'menu'
          ? renderMenu()
          : mode === 'comment'
            ? renderCommentContent()
            : renderVoteContent(mode)}
      </PopoverContent>
    </Popover>
  )
}
