import { describe, expect, it, vi } from "vitest";
import { RuntimeCallbackGate, type RuntimeCallbackFallbackHandoffAdapter } from "../runtime/runtime-callback-gate.js";

function createFallbackAdapter(overrides: Partial<RuntimeCallbackFallbackHandoffAdapter> = {}): RuntimeCallbackFallbackHandoffAdapter {
  return {
    bufferStatusDuringHandoff: vi.fn(() => false),
    bufferAgentEndDuringHandoff: vi.fn(() => false),
    isSuppressedRuntimeCallback: vi.fn(() => false),
    ...overrides
  };
}

describe("RuntimeCallbackGate", () => {
  it("ignores callbacks from stale runtime tokens", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => 2 });

    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 1)).toBe(true);
    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 2)).toBe(false);
  });

  it("accepts callbacks with undefined runtime tokens", () => {
    const fallback = createFallbackAdapter({
      isSuppressedRuntimeCallback: vi.fn(() => true)
    });
    const gate = new RuntimeCallbackGate({
      getCurrentRuntimeToken: () => 1,
      fallbackHandoff: fallback
    });

    gate.suppressIntentionalStopRuntimeCallbacks("agent-1");

    expect(gate.shouldIgnoreRuntimeCallback("agent-1")).toBe(false);
    expect(gate.isSuppressedRuntimeCallback("agent-1")).toBe(false);
    expect(fallback.isSuppressedRuntimeCallback).not.toHaveBeenCalled();
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

  it("checks fallback suppression before stale-token suppression", () => {
    const fallback = createFallbackAdapter({
      isSuppressedRuntimeCallback: vi.fn(() => true)
    });
    const gate = new RuntimeCallbackGate({
      getCurrentRuntimeToken: () => 2,
      fallbackHandoff: fallback
    });

    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 1)).toBe(true);
    expect(fallback.isSuppressedRuntimeCallback).toHaveBeenCalledWith("agent-1", 1);
  });

  it("buffers status during fallback handoff before suppression checks", () => {
    const fallback = createFallbackAdapter({
      bufferStatusDuringHandoff: vi.fn(() => true),
      isSuppressedRuntimeCallback: vi.fn(() => true)
    });
    const gate = new RuntimeCallbackGate({
      getCurrentRuntimeToken: () => 2,
      fallbackHandoff: fallback
    });

    expect(gate.bufferStatusDuringHandoff("agent-1", 1, "streaming", 3, { tokens: 1 })).toBe(true);
    expect(fallback.bufferStatusDuringHandoff).toHaveBeenCalledWith(
      "agent-1",
      1,
      "streaming",
      3,
      expect.objectContaining({ tokens: 1 })
    );
    expect(fallback.isSuppressedRuntimeCallback).not.toHaveBeenCalled();
  });

  it("buffers agent_end during fallback handoff before suppression checks", () => {
    const fallback = createFallbackAdapter({
      bufferAgentEndDuringHandoff: vi.fn(() => true),
      isSuppressedRuntimeCallback: vi.fn(() => true)
    });
    const gate = new RuntimeCallbackGate({
      getCurrentRuntimeToken: () => 2,
      fallbackHandoff: fallback
    });

    expect(gate.bufferAgentEndDuringHandoff("agent-1", 1)).toBe(true);
    expect(fallback.bufferAgentEndDuringHandoff).toHaveBeenCalledWith("agent-1", 1);
    expect(fallback.isSuppressedRuntimeCallback).not.toHaveBeenCalled();
  });

  it("works without a fallback handoff adapter", () => {
    const gate = new RuntimeCallbackGate({ getCurrentRuntimeToken: () => 1 });

    expect(gate.bufferStatusDuringHandoff("agent-1", 1, "idle", 0)).toBe(false);
    expect(gate.bufferAgentEndDuringHandoff("agent-1", 1)).toBe(false);
    expect(gate.isSuppressedRuntimeCallback("agent-1", 1)).toBe(false);
    expect(gate.shouldIgnoreRuntimeCallback("agent-1", 1)).toBe(false);
  });
});
