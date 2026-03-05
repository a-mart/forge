import { useState } from 'react'
import { ThumbsUp, ThumbsDown, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
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
  const [activePopover, setActivePopover] = useState<'up' | 'down' | 'comment' | null>(null)
  const [selectedReasons, setSelectedReasons] = useState<FeedbackReasonCode[]>([])
  const [comment, setComment] = useState('')

  const iconSize = size === 'sm' ? 'size-3' : 'size-3.5'
  const buttonSize = size === 'sm' ? 'size-5' : 'size-6'

  const handleUpClick = () => {
    if (isSubmitting) return
    if (currentVote === 'up') {
      // Already upvoted — open popover to add reasons/comment
      setSelectedReasons([])
      setComment('')
      setActivePopover('up')
    } else {
      // Instant upvote
      void onVote(scope, targetId, 'up', undefined, undefined, legacyTargetId)
    }
  }

  const handleDownClick = () => {
    if (isSubmitting) return
    if (currentVote === 'down') {
      // Toggle off
      void onVote(scope, targetId, 'down', undefined, undefined, legacyTargetId)
      return
    }
    // Open reason picker for new downvote
    setSelectedReasons([])
    setComment('')
    setActivePopover('down')
  }

  const handleCommentClick = () => {
    if (isSubmitting) return
    setComment('')
    setActivePopover('comment')
  }

  const handleReasonToggle = (code: FeedbackReasonCode) => {
    setSelectedReasons((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    )
  }

  const handleSubmit = () => {
    if (!activePopover) return
    if (activePopover === 'comment') {
      if (onComment && comment.trim()) {
        void onComment(scope, targetId, comment.trim(), legacyTargetId)
      }
    } else {
      void onVote(
        scope,
        targetId,
        activePopover,
        selectedReasons,
        comment.trim() || undefined,
        legacyTargetId,
      )
    }
    setActivePopover(null)
    setSelectedReasons([])
    setComment('')
  }

  const handleClearVote = () => {
    if (!activePopover) return
    // Send bare vote (no reasons) — hook treats same-value + no reasons as toggle-off
    void onVote(
      scope,
      targetId,
      activePopover as 'up' | 'down',
      undefined,
      undefined,
      legacyTargetId,
    )
    setActivePopover(null)
    setSelectedReasons([])
    setComment('')
  }

  const handleClearComment = () => {
    if (onClearComment) {
      void onClearComment(scope, targetId, legacyTargetId)
    }
    setActivePopover(null)
    setComment('')
  }

  const renderVotePopoverContent = (direction: 'up' | 'down') => (
    <PopoverContent
      side="bottom"
      align="start"
      sideOffset={6}
      className="w-64 p-3"
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <div className="space-y-3">
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
          {direction === 'up' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={handleClearVote}
              disabled={isSubmitting}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
    </PopoverContent>
  )

  const renderCommentPopoverContent = () => (
    <PopoverContent
      side="bottom"
      align="start"
      sideOffset={6}
      className="w-64 p-3"
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <div className="space-y-3">
        <p className="text-xs font-medium text-foreground">Add a comment</p>
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
          {hasComment && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={handleClearComment}
              disabled={isSubmitting}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
    </PopoverContent>
  )

  return (
    <span className="inline-flex items-center gap-0.5">
      {/* Thumbs Up — with reason picker popover on re-click */}
      <Popover
        open={activePopover === 'up'}
        onOpenChange={(open) => { if (!open) setActivePopover(null) }}
      >
        <PopoverAnchor asChild>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleUpClick}
            className={cn(
              'inline-flex items-center justify-center rounded-sm transition-colors',
              buttonSize,
              currentVote === 'up'
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-muted-foreground/50 hover:text-muted-foreground',
              isSubmitting && 'pointer-events-none opacity-50',
            )}
            aria-label="Thumbs up"
            aria-pressed={currentVote === 'up'}
          >
            <ThumbsUp
              className={cn(iconSize, currentVote === 'up' && 'fill-current')}
            />
          </button>
        </PopoverAnchor>
        {renderVotePopoverContent('up')}
      </Popover>

      {/* Thumbs Down — with reason picker popover */}
      <Popover
        open={activePopover === 'down'}
        onOpenChange={(open) => { if (!open) setActivePopover(null) }}
      >
        <PopoverAnchor asChild>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleDownClick}
            className={cn(
              'inline-flex items-center justify-center rounded-sm transition-colors',
              buttonSize,
              currentVote === 'down'
                ? 'text-red-500 dark:text-red-400'
                : 'text-muted-foreground/50 hover:text-muted-foreground',
              isSubmitting && 'pointer-events-none opacity-50',
            )}
            aria-label="Thumbs down"
            aria-pressed={currentVote === 'down'}
          >
            <ThumbsDown
              className={cn(iconSize, currentVote === 'down' && 'fill-current')}
            />
          </button>
        </PopoverAnchor>
        {renderVotePopoverContent('down')}
      </Popover>

      {/* Comment — standalone comment button */}
      {onComment && (
        <Popover
          open={activePopover === 'comment'}
          onOpenChange={(open) => { if (!open) setActivePopover(null) }}
        >
          <PopoverAnchor asChild>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={handleCommentClick}
              className={cn(
                'inline-flex items-center justify-center rounded-sm transition-colors',
                buttonSize,
                hasComment
                  ? 'text-blue-500 dark:text-blue-400'
                  : 'text-muted-foreground/50 hover:text-muted-foreground',
                isSubmitting && 'pointer-events-none opacity-50',
              )}
              aria-label="Add comment"
              aria-pressed={hasComment}
            >
              <MessageSquare
                className={cn(iconSize, hasComment && 'fill-current')}
              />
            </button>
          </PopoverAnchor>
          {renderCommentPopoverContent()}
        </Popover>
      )}
    </span>
  )
}
