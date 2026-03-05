import { useState } from 'react'
import { ThumbsUp, ThumbsDown } from 'lucide-react'
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
import { FEEDBACK_REASON_CODES, type FeedbackReasonCode } from '@/lib/feedback-types'

const REASON_LABELS: Record<FeedbackReasonCode, string> = {
  accuracy: 'Accuracy',
  instruction_following: 'Instruction Following',
  autonomy: 'Autonomy',
  speed: 'Speed',
  verbosity: 'Verbosity',
  formatting: 'Formatting',
  ux_decision: 'UX Decision',
  over_engineered: 'Over-Engineered',
  great_outcome: 'Great Outcome',
  poor_outcome: 'Poor Outcome',
}

interface MessageFeedbackProps {
  targetId: string
  currentVote: 'up' | 'down' | null
  onVote: (
    scope: 'message' | 'session',
    targetId: string,
    value: 'up' | 'down',
    reasonCodes?: string[],
    comment?: string,
  ) => Promise<void>
  isSubmitting?: boolean
  scope?: 'message' | 'session'
  /** Slightly larger for header-level usage */
  size?: 'sm' | 'md'
}

export function MessageFeedback({
  targetId,
  currentVote,
  onVote,
  isSubmitting = false,
  scope = 'message',
  size = 'sm',
}: MessageFeedbackProps) {
  const [activePopover, setActivePopover] = useState<'up' | 'down' | null>(null)
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
      void onVote(scope, targetId, 'up')
    }
  }

  const handleDownClick = () => {
    if (isSubmitting) return
    if (currentVote === 'down') {
      // Toggle off
      void onVote(scope, targetId, 'down')
      return
    }
    // Open reason picker for new downvote
    setSelectedReasons([])
    setComment('')
    setActivePopover('down')
  }

  const handleReasonToggle = (code: FeedbackReasonCode) => {
    setSelectedReasons((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    )
  }

  const handleSubmit = () => {
    if (!activePopover) return
    void onVote(scope, targetId, activePopover, selectedReasons, comment.trim() || undefined)
    setActivePopover(null)
    setSelectedReasons([])
    setComment('')
  }

  const handleClearVote = () => {
    if (!activePopover) return
    // Send bare vote (no reasons) — hook treats same-value + no reasons as toggle-off
    void onVote(scope, targetId, activePopover)
    setActivePopover(null)
    setSelectedReasons([])
    setComment('')
  }

  const renderPopoverContent = (direction: 'up' | 'down') => (
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
          {FEEDBACK_REASON_CODES.map((code) => (
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
        {renderPopoverContent('up')}
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
        {renderPopoverContent('down')}
      </Popover>
    </span>
  )
}
