import { useId, useMemo, useState } from 'react'
import { Check, ChevronRight, Clock, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChoiceAnswer, ChoiceQuestion, ChoiceRequestStatus } from '@forge/protocol'

interface ChoiceAnsweredRowProps {
  choiceId: string
  questions: ChoiceQuestion[]
  answers: ChoiceAnswer[]
  status: ChoiceRequestStatus
  timestamp: string
}

const STATUS_CONFIG: Record<
  Exclude<ChoiceRequestStatus, 'pending'>,
  { icon: typeof Check; label: string; className: string }
> = {
  answered: { icon: Check, label: 'Answered', className: 'text-green-500' },
  cancelled: { icon: XCircle, label: 'Cancelled', className: 'text-muted-foreground' },
  expired: { icon: Clock, label: 'Expired', className: 'text-muted-foreground' },
}

function formatTimestamp(timestamp: string): string | null {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function ChoiceAnsweredRow({
  choiceId,
  questions,
  answers,
  status,
  timestamp,
}: ChoiceAnsweredRowProps) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()

  const resolvedStatus = status === 'pending' ? 'expired' : status
  const config = STATUS_CONFIG[resolvedStatus]
  const StatusIcon = config.icon
  const formattedTimestamp = formatTimestamp(timestamp)

  const summary = useMemo(() => {
    if (resolvedStatus !== 'answered') {
      return config.label
    }

    return answers
      .map((answer) => {
        const question = questions.find((entry) => entry.id === answer.questionId)
        const labels = answer.selectedOptionIds.map(
          (optionId) => question?.options?.find((option) => option.id === optionId)?.label ?? optionId,
        )
        const parts = [...labels, answer.text].filter((part): part is string => Boolean(part))
        return parts.join(', ')
      })
      .filter(Boolean)
      .join(' · ')
  }, [answers, config.label, questions, resolvedStatus])

  return (
    <div className="group py-1 text-sm text-muted-foreground" data-choice-id={choiceId}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((previous) => !previous)}
        className="flex max-w-full items-center gap-1.5 text-left transition-colors hover:text-foreground"
        title={choiceId}
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', expanded ? 'rotate-90' : undefined)}
        />
        <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', config.className)} />
        <span className="truncate max-w-[500px]">
          {resolvedStatus === 'answered' ? `Choice: ${summary}` : `Choice ${config.label.toLowerCase()}`}
        </span>
        {formattedTimestamp ? (
          <span className="shrink-0 text-xs text-muted-foreground/80">{formattedTimestamp}</span>
        ) : null}
      </button>

      {expanded ? (
        <div id={contentId} className="ml-6 mt-2 space-y-3 text-sm">
          {questions.map((question) => {
            const answer = answers.find((entry) => entry.questionId === question.id)
            return (
              <div key={question.id} className="space-y-1">
                {question.header ? (
                  <p className="font-medium text-foreground">{question.header}</p>
                ) : null}
                <p className="text-muted-foreground">{question.question}</p>
                {question.options?.map((option) => {
                  const isSelected = answer?.selectedOptionIds.includes(option.id) ?? false
                  return (
                    <div
                      key={option.id}
                      className={cn('ml-2', isSelected ? 'font-medium text-primary' : undefined)}
                    >
                      {isSelected ? '● ' : '○ '}
                      {option.label}
                    </div>
                  )
                })}
                {answer?.text ? (
                  <p className="ml-2 italic text-muted-foreground">&quot;{answer.text}&quot;</p>
                ) : null}
                {!answer && resolvedStatus !== 'answered' ? (
                  <p className="ml-2 italic text-muted-foreground">(no response)</p>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
