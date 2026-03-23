// Feedback event stored per target (current state)
export type FeedbackValue = "up" | "down" | "comment";

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
  channel: "web" | "telegram";
  actor: "user";
}

export interface FeedbackSubmitEvent extends Omit<FeedbackEvent, "value"> {
  value: FeedbackSubmitValue;
  /** When value is "clear", specifies whether to clear the vote or comment entry. Defaults to "vote". */
  clearKind?: "vote" | "comment";
}

export const FEEDBACK_REASON_CODES = [
  "accuracy",
  "instruction_following",
  "autonomy",
  "speed",
  "verbosity",
  "formatting",
  "product_ux_direction",
  "needs_clarification",
  "over_engineered",
  "great_outcome",
  "poor_outcome"
] as const;

export type FeedbackReasonCode = (typeof FEEDBACK_REASON_CODES)[number];

// Latest resolved feedback per target (computed from current state)
export interface FeedbackState {
  targetId: string;
  scope: "message" | "session";
  /** "vote" for up/down, "comment" for standalone comments */
  kind: "vote" | "comment";
  value: "up" | "down" | "comment" | null;
  latestEventId: string;
  latestAt: string;
}
