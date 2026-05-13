export interface ChoiceOption {
  id: string
  label: string
  description?: string
  recommended?: boolean
}

export interface ChoiceQuestion {
  id: string
  header?: string
  question: string
  options?: ChoiceOption[]
  isOther?: boolean
  placeholder?: string
  multiSelect?: boolean
  minSelections?: number
  maxSelections?: number
}

export type ChoiceRequestStatus = 'pending' | 'answered' | 'cancelled' | 'expired'

export interface ChoiceAnswer {
  questionId: string
  selectedOptionIds: string[]
  text?: string
}

export function isChoiceAnswer(value: unknown): value is ChoiceAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const maybe = value as Record<string, unknown>
  if (typeof maybe.questionId !== 'string' || maybe.questionId.trim().length === 0) return false
  if (!Array.isArray(maybe.selectedOptionIds)) return false
  if (maybe.selectedOptionIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) return false
  if (maybe.text !== undefined && typeof maybe.text !== 'string') return false
  return true
}

export function validateChoiceAnswers(
  questions: ChoiceQuestion[],
  answers: ChoiceAnswer[],
): string | null {
  const questionMap = new Map<string, ChoiceQuestion>()

  for (const question of questions) {
    if (questionMap.has(question.id)) return `Duplicate questionId: ${question.id}`
    questionMap.set(question.id, question)
  }

  if (answers.length !== questions.length) {
    return `Expected ${questions.length} answer(s), received ${answers.length}`
  }

  const seenAnswers = new Set<string>()
  for (const answer of answers) {
    if (!isChoiceAnswer(answer)) return 'Invalid ChoiceAnswer object'

    const question = questionMap.get(answer.questionId)
    if (!question) return `Unknown questionId: ${answer.questionId}`
    if (seenAnswers.has(answer.questionId)) return `Duplicate answer for questionId: ${answer.questionId}`
    seenAnswers.add(answer.questionId)

    const selectedIds = answer.selectedOptionIds
    const selectedSet = new Set(selectedIds)
    if (selectedSet.size !== selectedIds.length) {
      return `Duplicate selected optionId for question ${answer.questionId}`
    }

    const text = answer.text?.trim()
    const options = question.options ?? []
    const isFreeformOnly = question.isOther === true || options.length === 0
    if (isFreeformOnly) {
      if (selectedIds.length > 0) return `Freeform question ${answer.questionId} cannot include selected options`
      if (!text) return `Freeform question ${answer.questionId} requires text`
      continue
    }

    if (answer.text !== undefined && !text) {
      return `Text for question ${answer.questionId} must be non-empty when provided`
    }

    const allowedOptions = new Set(options.map((option) => option.id))
    for (const optionId of selectedIds) {
      if (!allowedOptions.has(optionId)) return `Unknown optionId ${optionId} for question ${answer.questionId}`
    }

    if (question.multiSelect) {
      const optionCount = options.length
      const minSelections = clampInteger(question.minSelections ?? 0, 0, optionCount)
      const configuredMax = question.maxSelections ?? optionCount
      const maxSelections = clampInteger(configuredMax, minSelections, optionCount)
      if (selectedIds.length < minSelections) {
        return `Question ${answer.questionId} requires at least ${minSelections} selected option(s)`
      }
      if (selectedIds.length > maxSelections) {
        return `Question ${answer.questionId} allows at most ${maxSelections} selected option(s)`
      }
      continue
    }

    if (selectedIds.length !== 1) {
      return `Question ${answer.questionId} requires exactly one selected option`
    }
  }

  return null
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  const integer = Math.trunc(value)
  return Math.min(Math.max(integer, min), max)
}
