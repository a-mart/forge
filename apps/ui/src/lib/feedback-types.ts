// Local feedback types (will be replaced with @middleman/protocol imports after integration)

export interface FeedbackEvent {
  id: string
  createdAt: string
  profileId: string
  sessionId: string
  scope: 'message' | 'session'
  targetId: string
  value: 'up' | 'down' | 'clear'
  reasonCodes: string[]
  comment: string
  channel: 'web' | 'telegram' | 'slack'
  actor: 'user'
}

export const FEEDBACK_REASON_CODES = [
  'accuracy',
  'instruction_following',
  'autonomy',
  'speed',
  'verbosity',
  'formatting',
  'ux_decision',
  'over_engineered',
  'great_outcome',
  'poor_outcome',
] as const

export type FeedbackReasonCode = (typeof FEEDBACK_REASON_CODES)[number]

export interface FeedbackState {
  targetId: string
  scope: 'message' | 'session'
  value: 'up' | 'down' | null
  latestEventId: string
  latestAt: string
}
