import { describe, expect, it, vi } from "vitest";
import { RuntimeCallbackGate } from "../runtime/runtime-callback-gate.js";

describe("RuntimeCallbackGate", () => {
  it("ignores callbacks from stale runtime tokens", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => 2 });

    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 1)).toBe(true);
    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 2)).toBe(false);
  });

  it("accepts callbacks with undefined runtime tokens without consulting handoff state", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => 1 });

    gate.suppressIntentionalStopRuntimeCallbacks("agent-1");
    gate.beginFallbackHandoff("agent-1", 1);

    expect(gate.shouldIgnoreRuntimeCallback("agent-1")).toBe(false);
    expect(gate.isSuppressedRuntimeCallback("agent-1")).toBe(false);
    expect(gate.bufferStatusDuringHandoff("agent-1", undefined, "streaming", 1)).toBe(false);
    expect(gate.bufferAgentEndDuringHandoff("agent-1")).toBe(false);
    expect(gate.getFallbackHandoffSnapshot("agent-1")).toBeUndefined();
  });

  it("adds and clears intentional-stop callback suppression by token", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => 7 });

    gate.suppressIntentionalStopRuntimeCallbacks("agent-1", 7);
    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 7)).toBe(true);

    gate.clearIntentionalStopRuntimeCallbackSuppression("agent-1", 7);
    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 7)).toBe(false);
  });

  it("clears all intentional-stop callback suppression for an agent when token is omitted", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => 8 });

    gate.suppressIntentionalStopRuntimeCallbacks("agent-1", 7);
    gate.suppressIntentionalStopRuntimeCallbacks("agent-1", 8);
    gate.clearIntentionalStopRuntimeCallbackSuppression("agent-1");

    expect(gate.isSuppressedRuntimeCallback("agent-1", 7)).toBe(false);
    expect(gate.isSuppressedRuntimeCallback("agent-1", 8)).toBe(false);
    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 8)).toBe(false);
  });

  it("beginFallbackHandoff suppresses only the matching old runtime token before stale-token checks", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => 2 });

    gate.beginFallbackHandoff("agent-1", 1);

    expect(gate.isSuppressedRuntimeCallback("agent-1", 1)).toBe(true);
    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 1)).toBe(true);
    expect(gate.isSuppressedRuntimeCallback("agent-1", 2)).toBe(false);
    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 2)).toBe(false);
    expect(gate.isSuppressedRuntimeCallback("other-agent", 1)).toBe(false);
  });

  it("buffers status and agent_end only for the suppressed old runtime token", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => 2 });

    gate.beginFallbackHandoff("agent-1", 1);

    expect(gate.bufferStatusDuringHandoff("agent-1", 1, "streaming", 3, {
      tokens: 1,
      contextWindow: 10,
      percent: 5
    })).toBe(true);
    expect(gate.bufferAgentEndDuringHandoff("agent-1", 1)).toBe(true);

    expect(gate.bufferStatusDuringHandoff("agent-1", 2, "idle", 0)).toBe(false);
    expect(gate.bufferAgentEndDuringHandoff("agent-1", 2)).toBe(false);

    expect(gate.getFallbackHandoffSnapshot("agent-1", 1)).toMatchObject({
      suppressedRuntimeToken: 1,
      bufferedStatus: {
        status: "streaming",
        pendingCount: 3,
        contextUsage: { tokens: 1, contextWindow: 10, percent: 5 }
      },
      receivedAgentEnd: true
    });
  });

  it("reconciles abort by clearing handoff before replaying buffered status then agent_end", async () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => 1 });
    const calls: string[] = [];

    gate.beginFallbackHandoff("agent-1", 1);
    gate.bufferStatusDuringHandoff("agent-1", 1, "streaming", 2, {
      tokens: 9,
      contextWindow: 100,
      percent: 9
    });
    gate.bufferAgentEndDuringHandoff("agent-1", 1);

    await gate.reconcileBufferedCallbacksOnAbort("agent-1", 1, {
      handleRuntimeStatus: vi.fn(async (runtimeToken, agentId, status, pendingCount, contextUsage) => {
        expect(gate.isSuppressedRuntimeCallback(agentId, runtimeToken)).toBe(false);
        calls.push(`status:${status}:${pendingCount}:${contextUsage?.tokens}`);
      }),
      handleRuntimeAgentEnd: vi.fn(async (runtimeToken, agentId) => {
        expect(gate.isSuppressedRuntimeCallback(agentId, runtimeToken)).toBe(false);
        calls.push("end");
      })
    });

    expect(calls).toEqual(["status:streaming:2:9", "end"]);
    expect(gate.getFallbackHandoffSnapshot("agent-1", 1)).toBeUndefined();
  });

  it("ends successful fallback handoff and drops buffered old callbacks", async () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => 2 });
    const handleRuntimeStatus = vi.fn();
    const handleRuntimeAgentEnd = vi.fn();

    gate.beginFallbackHandoff("agent-1", 1);
    gate.bufferStatusDuringHandoff("agent-1", 1, "idle", 0);
    gate.bufferAgentEndDuringHandoff("agent-1", 1);
    gate.endFallbackHandoff("agent-1", 1);

    expect(gate.isSuppressedRuntimeCallback("agent-1", 1)).toBe(false);
    expect(gate.bufferStatusDuringHandoff("agent-1", 1, "streaming", 1)).toBe(false);
    await gate.reconcileBufferedCallbacksOnAbort("agent-1", 1, {
      handleRuntimeStatus,
      handleRuntimeAgentEnd
    });
    expect(handleRuntimeStatus).not.toHaveBeenCalled();
    expect(handleRuntimeAgentEnd).not.toHaveBeenCalled();
  });

  it("admits exactly one invalidated manual-stop message_end callback", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => undefined });

    gate.allowInvalidatedManualStopMessageEnd("agent-1", 10);

    expect(gate.shouldIgnoreRuntimeSessionEvent("agent-1", 10, "message_end")).toBe(false);
    expect(gate.shouldIgnoreRuntimeSessionEvent("agent-1", 10, "message_end")).toBe(true);
  });

  it("rejects non-message_end callbacks for invalidated manual-stop allowances", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => undefined });

    gate.allowInvalidatedManualStopMessageEnd("agent-1", 10);

    expect(gate.shouldIgnoreRuntimeSessionEvent("agent-1", 10, "message_delta")).toBe(true);
    expect(gate.shouldIgnoreRuntimeSessionEvent("agent-1", 10, "message_end")).toBe(false);
  });

  it("keeps invalidated manual-stop allowance through intentional-stop cleanup until explicit expiry cleanup", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => undefined });

    gate.allowInvalidatedManualStopMessageEnd("agent-1", 10);
    gate.allowInvalidatedManualStopMessageEnd("agent-1", 11);
    gate.clearIntentionalStopRuntimeCallbackSuppression("agent-1", 10);

    expect(gate.shouldIgnoreRuntimeSessionEvent("agent-1", 10, "message_end")).toBe(false);

    gate.clearInvalidatedManualStopMessageEndAllowance("agent-1", 11);
    expect(gate.shouldIgnoreRuntimeSessionEvent("agent-1", 11, "message_end")).toBe(true);
  });

  it("works without a fallback handoff", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => 1 });

    expect(gate.bufferStatusDuringHandoff("agent-1", 1, "idle", 0)).toBe(false);
    expect(gate.bufferAgentEndDuringHandoff("agent-1", 1)).toBe(false);
    expect(gate.isSuppressedRuntimeCallback("agent-1", 1)).toBe(false);
    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 1)).toBe(false);
  });
});
