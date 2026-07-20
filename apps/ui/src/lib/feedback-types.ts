export {
  FEEDBACK_REASON_CODES,
  type FeedbackReasonCode,
  type FeedbackState,
} from '@forge/protocol'

import type {
  FeedbackEvent as PersistedFeedbackEvent,
  FeedbackSubmitEvent,
} from '@forge/protocol'

/** Feedback returned by either active submission or persisted-state APIs. */
export type FeedbackEvent = PersistedFeedbackEvent | FeedbackSubmitEvent
