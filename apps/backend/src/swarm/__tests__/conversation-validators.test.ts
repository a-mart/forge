import { describe, expect, it } from "vitest";
import { isConversationEntryEvent } from "../session/conversation-validators.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function makeModelCacheObservation(overrides: Record<string, unknown> = {}) {
  return {
    type: "model_cache_observation",
    agentId: "manager-1",
    id: "cache-obs-1",
    timestamp: FIXED_NOW,
    runtimeType: "pi",
    provider: "openai",
    modelId: "gpt-5",
    tokens: {
      promptInputTokens: 2000,
      cachedInputTokens: 1600,
      cacheWriteInputTokens: 0,
      uncachedInputTokens: 400,
      outputTokens: 120,
      totalTokens: 2120,
      normalization: "raw_input_tokens_total",
    },
    classification: {
      version: 1,
      status: "hit",
      cachedRatio: 0.8,
      thresholdTokens: 1024,
      hitRatioThreshold: 0.8,
    },
    ...overrides,
  };
}

describe("conversation validators", () => {
  it("accepts assistant output sources and rejects unknown conversation message sources", () => {
    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "projected",
        timestamp: FIXED_NOW,
        source: "assistant_output",
        sourceContext: { channel: "web" }
      })
    ).toBe(true);

    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "still working",
        timestamp: FIXED_NOW,
        source: "assistant_progress",
        sourceContext: { channel: "web" }
      })
    ).toBe(true);

    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "bad",
        timestamp: FIXED_NOW,
        source: "unknown_output"
      })
    ).toBe(false);
  });

  it("rejects conversation message role/source pairs that cannot be produced by the runtime contract", () => {
    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "impossible",
        timestamp: FIXED_NOW,
        source: "user_input",
      })
    ).toBe(false);

    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        role: "user",
        text: "impossible",
        timestamp: FIXED_NOW,
        source: "assistant_output",
      })
    ).toBe(false);

    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        role: "user",
        text: "impossible",
        timestamp: FIXED_NOW,
        source: "assistant_progress",
      })
    ).toBe(false);

    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "valid",
        timestamp: FIXED_NOW,
        source: "speak_to_user",
      })
    ).toBe(true);

    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        role: "system",
        text: "valid",
        timestamp: FIXED_NOW,
        source: "system",
      })
    ).toBe(true);

    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "legacy-compatible",
        timestamp: FIXED_NOW,
        source: "system",
      })
    ).toBe(true);
  });

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

  it("accepts worker_report conversation messages with additive fields", () => {
    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        id: "worker-report-1",
        role: "system",
        text: "Worker completed.",
        timestamp: FIXED_NOW,
        source: "worker_report",
        terminal: true,
        sourceWorkerId: "worker-1",
        excludeFromModelContext: true,
      })
    ).toBe(true);
  });

  it("rejects worker_report messages with non-system roles", () => {
    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "Worker completed.",
        timestamp: FIXED_NOW,
        source: "worker_report",
        terminal: true,
        sourceWorkerId: "worker-1",
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

  it("accepts a valid model_cache_observation entry", () => {
    expect(isConversationEntryEvent(makeModelCacheObservation())).toBe(true);
  });

  it("accepts completed plan summaries and rejects mutable or malformed snapshots", () => {
    const summary = {
      type: "plan_summary",
      id: "plan-summary-1",
      agentId: "manager-1",
      timestamp: FIXED_NOW,
      revision: 2,
      updatedAt: FIXED_NOW,
      explanation: "The plan is complete.",
      plan: [{ step: "Verify the result", status: "completed" }],
    };

    expect(isConversationEntryEvent(summary)).toBe(true);
    expect(isConversationEntryEvent({ ...summary, id: "" })).toBe(false);
    expect(isConversationEntryEvent({
      ...summary,
      plan: [{ step: "Verify the result", status: "in_progress" }],
    })).toBe(false);
  });

  it("rejects malformed model_cache_observation token and classification invariants", () => {
    expect(isConversationEntryEvent(makeModelCacheObservation({ id: "" }))).toBe(false);
    expect(
      isConversationEntryEvent(
        makeModelCacheObservation({
          tokens: {
            promptInputTokens: 2000,
            cachedInputTokens: 1500,
            cacheWriteInputTokens: 800,
            uncachedInputTokens: 0,
            outputTokens: 10,
            totalTokens: 2010,
            normalization: "raw_input_tokens_total",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isConversationEntryEvent(
        makeModelCacheObservation({
          classification: {
            version: 1,
            status: "miss",
            cachedRatio: 0.8,
            thresholdTokens: 1024,
            hitRatioThreshold: 0.8,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isConversationEntryEvent(
        makeModelCacheObservation({
          tokens: {
            promptInputTokens: 900,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            uncachedInputTokens: 900,
            outputTokens: 10,
            totalTokens: 910,
            normalization: "raw_input_tokens_total",
          },
        }),
      ),
    ).toBe(false);
  });

  it("accepts conversation_message replyTo metadata and rejects malformed reply targets", () => {
    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        id: "msg-1",
        role: "user",
        text: "Follow-up",
        timestamp: FIXED_NOW,
        source: "user_input",
        replyTo: {
          messageId: "msg-target",
          role: "assistant",
          timestamp: FIXED_NOW,
          text: "Quoted",
          source: "assistant_output",
          attachmentCount: 0,
          truncated: true,
        },
      }),
    ).toBe(true);

    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        id: "msg-1",
        role: "user",
        text: "Follow-up",
        timestamp: FIXED_NOW,
        source: "user_input",
        replyTo: {
          messageId: "",
          role: "assistant",
          timestamp: FIXED_NOW,
          text: "Quoted",
        },
      }),
    ).toBe(false);

    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        id: "msg-1",
        role: "user",
        text: "Follow-up",
        timestamp: FIXED_NOW,
        source: "user_input",
        replyTo: {
          messageId: "msg-target",
          role: "assistant",
          timestamp: FIXED_NOW,
          text: "Quoted",
          source: "assistant_output",
          attachmentCount: 1.5,
        },
      }),
    ).toBe(false);

    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        id: "msg-1",
        role: "user",
        text: "Follow-up",
        timestamp: FIXED_NOW,
        source: "user_input",
        replyTo: {
          messageId: "msg-target",
          role: "assistant",
          timestamp: FIXED_NOW,
          text: "Quoted",
          source: "user_input",
        },
      }),
    ).toBe(false);
  });
});
