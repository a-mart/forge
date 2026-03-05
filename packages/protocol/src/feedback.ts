// Feedback event stored per target (current state)
export type FeedbackValue = "up" | "down";

// Input values accepted by the feedback submit endpoint.
export type FeedbackSubmitValue = FeedbackValue | "clear";

// Feedback event (persisted feedback state)
export interface FeedbackEvent {
  id: string;
  createdAt: string;
  profileId: string;
  sessionId: string;
  scope: "message" | "session";
  targetId: string;
  value: FeedbackValue;
  reasonCodes: string[];
  comment: string;
  channel: "web" | "telegram" | "slack";
  actor: "user";
}

export interface FeedbackSubmitEvent extends Omit<FeedbackEvent, "value"> {
  value: FeedbackSubmitValue;
}

export const FEEDBACK_REASON_CODES = [
  "accuracy",
  "instruction_following",
  "autonomy",
  "speed",
  "verbosity",
  "formatting",
  "ux_decision",
  "over_engineered",
  "great_outcome",
  "poor_outcome"
] as const;

export type FeedbackReasonCode = (typeof FEEDBACK_REASON_CODES)[number];

// Latest resolved feedback per target (computed from current state)
export interface FeedbackState {
  targetId: string;
  scope: "message" | "session";
  value: "up" | "down" | null;
  latestEventId: string;
  latestAt: string;
}
