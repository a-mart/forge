export const ONBOARDING_STATUSES = ['pending', 'completed', 'skipped'] as const
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number]

export const ONBOARDING_TECHNICAL_LEVEL_VALUES = [
  'developer',
  'technical_non_developer',
  'semi_technical',
  'non_technical',
] as const
export type OnboardingTechnicalLevel = (typeof ONBOARDING_TECHNICAL_LEVEL_VALUES)[number]

export interface OnboardingPreferences {
  preferredName: string | null
  technicalLevel: OnboardingTechnicalLevel | null
  additionalPreferences: string | null
}

export interface OnboardingState {
  status: OnboardingStatus
  completedAt: string | null
  skippedAt: string | null
  preferences: OnboardingPreferences | null
}
