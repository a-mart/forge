import {
  BaseConnectionState,
  BaseStatusEvent,
  BaseStatusTracker,
  type BaseStatusUpdate
} from "../base-status-tracker.js";

export type SlackConnectionState = BaseConnectionState;

export interface SlackStatusEvent extends BaseStatusEvent<"slack_status", SlackConnectionState> {
  teamId?: string;
  botUserId?: string;
}

export type SlackStatusUpdate = BaseStatusUpdate<SlackStatusEvent>;

export class SlackStatusTracker extends BaseStatusTracker<SlackStatusEvent> {
  constructor(initial?: Partial<Omit<SlackStatusEvent, "type" | "updatedAt">>) {
    super({
      type: "slack_status",
      initial,
      extraFields: ["teamId", "botUserId"] as const
    });
  }
}
