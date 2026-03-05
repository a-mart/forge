import { useState } from 'react'
import { ThumbsUp, ThumbsDown } from 'lucide-react'
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
  const [reasonPopoverOpen, setReasonPopoverOpen] = useState(false)
  const [selectedReasons, setSelectedReasons] = useState<FeedbackReasonCode[]>([])
  const [comment, setComment] = useState('')

  const iconSize = size === 'sm' ? 'size-3' : 'size-3.5'
  const buttonSize = size === 'sm' ? 'size-5' : 'size-6'

  const handleUpClick = () => {
    if (isSubmitting) return
    void onVote(scope, targetId, 'up')
  }

  const handleDownClick = () => {
    if (isSubmitting) return
    // If already voted down, toggle it off directly
    if (currentVote === 'down') {
      void onVote(scope, targetId, 'down')
      return
    }
    // Open reason picker for new downvote
    setSelectedReasons([])
    setComment('')
    setReasonPopoverOpen(true)
  }

  const handleReasonToggle = (code: FeedbackReasonCode) => {
    setSelectedReasons((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    )
  }

  const handleSubmitDown = () => {
    void onVote(scope, targetId, 'down', selectedReasons, comment.trim() || undefined)
    setReasonPopoverOpen(false)
    setSelectedReasons([])
    setComment('')
  }

  return (
    <span className="inline-flex items-center gap-0.5">
      {/* Thumbs Up */}
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

      {/* Thumbs Down — with reason picker popover */}
      <Popover open={reasonPopoverOpen} onOpenChange={setReasonPopoverOpen}>
        <PopoverTrigger asChild>
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
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          className="w-64 p-3"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="space-y-3">
            <p className="text-xs font-medium text-foreground">What went wrong?</p>
            <div className="space-y-1.5">
              {FEEDBACK_REASON_CODES.map((code) => (
                <div key={code} className="flex items-center gap-2">
                  <Checkbox
                    id={`reason-${targetId}-${code}`}
                    checked={selectedReasons.includes(code)}
                    onCheckedChange={() => handleReasonToggle(code)}
                    className="size-3.5"
                  />
                  <Label
                    htmlFor={`reason-${targetId}-${code}`}
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
            <Button
              size="sm"
              className="h-7 w-full text-xs"
              onClick={handleSubmitDown}
              disabled={isSubmitting}
            >
              Submit
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  )
}
