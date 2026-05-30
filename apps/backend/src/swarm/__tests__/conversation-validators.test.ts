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

  it("accepts Codex external-thread display/control cards on conversation messages", () => {
    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        id: "codex-request-1",
        role: "system",
        text: "Sent to Codex",
        timestamp: FIXED_NOW,
        source: "system",
        externalThreadContext: {
          type: "codex_app_server",
          sidecarAgentId: "manager-1--codex",
          requestId: "req-1",
          turnCorrelationId: "turn-1",
          status: "sent",
          promptPreview: "hello",
          excludeFromModelContext: true
        }
      })
    ).toBe(true);
  });

  it("rejects Codex external-thread cards missing excludeFromModelContext", () => {
    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        role: "system",
        text: "Sent to Codex",
        timestamp: FIXED_NOW,
        source: "system",
        externalThreadContext: {
          type: "codex_app_server",
          sidecarAgentId: "manager-1--codex",
          requestId: "req-1",
          turnCorrelationId: "turn-1",
          status: "sent"
        }
      })
    ).toBe(false);
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
