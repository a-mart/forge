export { FEEDBACK_REASON_CODES, type FeedbackReasonCode } from '@forge/protocol'

export interface FeedbackEvent {
  id: string
  createdAt: string
  profileId: string
  sessionId: string
  scope: 'message' | 'session'
  targetId: string
  value: 'up' | 'down' | 'comment' | 'clear'
  reasonCodes: string[]
  comment: string
  channel: 'web' | 'telegram'
  actor: 'user'
}

export interface FeedbackState {
  targetId: string
  scope: 'message' | 'session'
  kind: 'vote' | 'comment'
  value: 'up' | 'down' | 'comment' | null
  latestEventId: string
  latestAt: string
}
