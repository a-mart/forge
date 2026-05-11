import { describe, expect, it } from "vitest";
import { isConversationEntryEvent } from "../session/conversation-validators.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

describe("conversation validators", () => {
  it("accepts CLI source context on persisted conversation messages", () => {
    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        id: "message-1",
        role: "user",
        text: "from cli",
        timestamp: FIXED_NOW,
        source: "user_input",
        sourceContext: { channel: "cli", userId: "run-1" }
      })
    ).toBe(true);
  });

  it("accepts CLI source context on persisted agent message activity", () => {
    expect(
      isConversationEntryEvent({
        type: "agent_message",
        agentId: "manager-1",
        timestamp: FIXED_NOW,
        source: "user_to_agent",
        toAgentId: "manager-1",
        text: "from cli",
        sourceContext: { channel: "cli", messageId: "dispatch-1" }
      })
    ).toBe(true);
  });
});
