import {
  BaseConnectionState,
  BaseStatusEvent,
  BaseStatusTracker,
  type BaseStatusUpdate
} from "../base-status-tracker.js";

export type TelegramConnectionState = BaseConnectionState;

export interface TelegramStatusEvent
  extends BaseStatusEvent<"telegram_status", TelegramConnectionState> {
  botId?: string;
  botUsername?: string;
}

export type TelegramStatusUpdate = BaseStatusUpdate<TelegramStatusEvent>;

export class TelegramStatusTracker extends BaseStatusTracker<TelegramStatusEvent> {
  constructor(initial?: Partial<Omit<TelegramStatusEvent, "type" | "updatedAt">>) {
    super({
      type: "telegram_status",
      initial,
      extraFields: ["botId", "botUsername"] as const
    });
  }
}
