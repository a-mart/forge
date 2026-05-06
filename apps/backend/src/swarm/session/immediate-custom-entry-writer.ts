import {
  appendImmediateCustomEntryViaTimeline,
  type ImmediateCustomEntryTimelineOptions,
  type ImmediateCustomEntryTimelineResult
} from "./conversation-timeline.js";

export interface ImmediateCustomEntryWriteOptions extends ImmediateCustomEntryTimelineOptions {}

export interface ImmediateCustomEntryWriteResult extends ImmediateCustomEntryTimelineResult {}

export async function appendImmediateCustomEntry(
  options: ImmediateCustomEntryWriteOptions
): Promise<ImmediateCustomEntryWriteResult> {
  return appendImmediateCustomEntryViaTimeline(options);
}
