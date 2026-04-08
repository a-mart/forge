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
}

export type ChoiceRequestStatus = 'pending' | 'answered' | 'cancelled' | 'expired'

export interface ChoiceAnswer {
  questionId: string
  selectedOptionIds: string[]
  text?: string
}
