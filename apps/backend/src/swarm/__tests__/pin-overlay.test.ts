import { describe, expect, it } from "vitest";
import { applyPinOverlay, setPinnedFlagInMemory } from "../session/pin-overlay.js";
import type { ConversationEntryEvent, ConversationMessageEvent } from "../types.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function message(id: string, options: Partial<ConversationMessageEvent> = {}): ConversationMessageEvent {
  return {
    type: "conversation_message",
    agentId: "manager-1",
    id,
    role: "assistant",
    text: id,
    timestamp: FIXED_NOW,
    source: "system",
    ...options
  };
}

function log(pinned?: boolean): ConversationEntryEvent {
  return {
    type: "conversation_log",
    agentId: "manager-1",
    timestamp: FIXED_NOW,
    source: "runtime_log",
    kind: "message_start",
    role: "assistant",
    text: "runtime log",
    pinned
  } as ConversationEntryEvent;
}

describe("pin overlay", () => {
  it("marks conversation messages whose IDs are present in the sidecar set", () => {
    const entries: ConversationEntryEvent[] = [message("keep"), message("pin")];

    applyPinOverlay(entries, new Set(["pin"]));

    expect(entries[0]).not.toHaveProperty("pinned");
    expect(entries[1]).toHaveProperty("pinned", true);
  });

  it("clears stale cached pinned flags not present in the sidecar set", () => {
    const entries: ConversationEntryEvent[] = [message("stale", { pinned: true }), message("fresh", { pinned: true })];

    applyPinOverlay(entries, new Set(["fresh"]));

    expect(entries[0]).not.toHaveProperty("pinned");
    expect(entries[1]).toHaveProperty("pinned", true);
  });

  it("clears all cached pinned flags when the sidecar set is empty", () => {
    const entries: ConversationEntryEvent[] = [message("a", { pinned: true }), message("b", { pinned: true })];

    applyPinOverlay(entries, new Set());

    expect(entries[0]).not.toHaveProperty("pinned");
    expect(entries[1]).not.toHaveProperty("pinned");
  });

  it("clears all cached pinned flags when the sidecar set is missing", () => {
    const entries: ConversationEntryEvent[] = [message("a", { pinned: true }), message("b", { pinned: true })];

    applyPinOverlay(entries);

    expect(entries[0]).not.toHaveProperty("pinned");
    expect(entries[1]).not.toHaveProperty("pinned");
  });

  it("ignores non-conversation entries", () => {
    const activity = log(true);
    const entries: ConversationEntryEvent[] = [activity, message("pin")];

    applyPinOverlay(entries, new Set(["pin"]));

    expect(activity).toHaveProperty("pinned", true);
    expect(entries[1]).toHaveProperty("pinned", true);
  });

  it("toggles one matching message in memory", () => {
    const entries: ConversationEntryEvent[] = [message("target"), message("other")];

    setPinnedFlagInMemory(entries, "target", true);
    expect(entries[0]).toHaveProperty("pinned", true);
    expect(entries[1]).not.toHaveProperty("pinned");

    setPinnedFlagInMemory(entries, "target", false);
    expect(entries[0]).not.toHaveProperty("pinned");
    expect(entries[1]).not.toHaveProperty("pinned");
  });

  it("does nothing when toggling a missing message ID", () => {
    const entries: ConversationEntryEvent[] = [message("existing", { pinned: true }), log(true)];

    setPinnedFlagInMemory(entries, "missing", false);

    expect(entries[0]).toHaveProperty("pinned", true);
    expect(entries[1]).toHaveProperty("pinned", true);
  });
});
