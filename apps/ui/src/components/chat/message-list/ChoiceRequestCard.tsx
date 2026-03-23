import { useCallback, useMemo, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { ChoiceAnswer, ChoiceQuestion } from '@forge/protocol'

interface ChoiceRequestCardProps {
  choiceId: string
  agentId: string
  questions: ChoiceQuestion[]
  onSubmit: (agentId: string, choiceId: string, answers: ChoiceAnswer[]) => void
  onCancel: (agentId: string, choiceId: string) => void
}

interface QuestionSelectionState {
  selectedOptionId: string | null
  text: string
}

export function ChoiceRequestCard({
  choiceId,
  agentId,
  questions,
  onSubmit,
  onCancel,
}: ChoiceRequestCardProps) {
  const [selections, setSelections] = useState<Record<string, QuestionSelectionState>>(() => {
    const initial: Record<string, QuestionSelectionState> = {}
    for (const question of questions) {
      initial[question.id] = { selectedOptionId: null, text: '' }
    }
    return initial
  })

  const toggleOption = useCallback((questionId: string, optionId: string) => {
    setSelections((previous) => {
      const current = previous[questionId]
      if (!current) {
        return previous
      }

      return {
        ...previous,
        [questionId]: {
          ...current,
          selectedOptionId: current.selectedOptionId === optionId ? null : optionId,
        },
      }
    })
  }, [])

  const setText = useCallback((questionId: string, text: string) => {
    setSelections((previous) => {
      const current = previous[questionId]
      if (!current) {
        return previous
      }

      return {
        ...previous,
        [questionId]: {
          ...current,
          text,
        },
      }
    })
  }, [])

  const [isSubmitting, setIsSubmitting] = useState(false)

  const isValid = useMemo(
    () =>
      questions.every((question) => {
        const selection = selections[question.id]
        if (!selection) {
          return false
        }

        if (question.isOther) {
          return selection.text.trim().length > 0
        }

        return selection.selectedOptionId !== null || selection.text.trim().length > 0
      }),
    [questions, selections],
  )

  const handleSubmit = useCallback(() => {
    if (isSubmitting) return
    setIsSubmitting(true)

    const answers: ChoiceAnswer[] = questions.map((question) => {
      const selection = selections[question.id] ?? { selectedOptionId: null, text: '' }
      return {
        questionId: question.id,
        selectedOptionIds: selection.selectedOptionId ? [selection.selectedOptionId] : [],
        text: selection.text.trim() || undefined,
      }
    })

    onSubmit(agentId, choiceId, answers)
  }, [isSubmitting, agentId, choiceId, onSubmit, questions, selections])

  return (
    <div className="max-w-2xl space-y-4 rounded-lg border border-primary/20 bg-card p-4">
      <div className="flex items-center gap-2 text-foreground">
        <MessageSquare className="h-4 w-4 text-primary" aria-hidden="true" />
        <span className="text-sm font-medium">Input requested</span>
      </div>

      {questions.map((question) => (
        <div key={question.id} className="space-y-2">
          {question.header ? (
            <h4 className="text-sm font-semibold text-foreground">{question.header}</h4>
          ) : null}
          <p className="text-sm text-foreground">{question.question}</p>

          {question.options && !question.isOther ? (
            <div className="flex flex-col gap-1.5">
              {question.options.map((option) => {
                const isSelected = selections[question.id]?.selectedOptionId === option.id

                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => toggleOption(question.id, option.id)}
                    className={cn(
                      'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      isSelected
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-transparent hover:border-primary/40 hover:bg-muted/30',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{option.label}</span>
                      {option.recommended && (
                        <span className="text-xs text-muted-foreground font-normal">(Recommended)</span>
                      )}
                    </span>
                    {option.description ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ) : null}

          <Textarea
            placeholder={
              question.placeholder ??
              (question.isOther || !question.options?.length
                ? 'Type your answer...'
                : 'Add notes (optional)...')
            }
            value={selections[question.id]?.text ?? ''}
            onChange={(event) => setText(question.id, event.target.value)}
            className="min-h-[60px] text-sm"
          />
        </div>
      ))}

      <div className="flex gap-2">
        <Button size="sm" onClick={handleSubmit} disabled={!isValid || isSubmitting}>
          {isSubmitting ? 'Submitting…' : 'Submit'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onCancel(agentId, choiceId)} disabled={isSubmitting}>
          Skip
        </Button>
      </div>
    </div>
  )
}
