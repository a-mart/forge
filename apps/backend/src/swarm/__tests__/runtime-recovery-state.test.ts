import { describe, expect, it } from "vitest";
import {
  isRuntimeRecoveryActiveForRuntime,
  RuntimeRecoveryState
} from "../runtime/runtime-recovery-state.js";

describe("RuntimeRecoveryState", () => {
  it("detects active recovery with active helper before in-progress fallback", () => {
    expect(isRuntimeRecoveryActiveForRuntime()).toBe(false);
    expect(isRuntimeRecoveryActiveForRuntime({
      isContextRecoveryInProgress: () => true
    })).toBe(true);
    expect(isRuntimeRecoveryActiveForRuntime({
      isContextRecoveryActive: () => false,
      isContextRecoveryInProgress: () => true
    })).toBe(false);
    expect(isRuntimeRecoveryActiveForRuntime({
      isContextRecoveryActive: () => true,
      isContextRecoveryInProgress: () => false
    })).toBe(true);
  });

  it("lists cloned pending recycle entries sorted by agent id", () => {
    const state = new RuntimeRecoveryState();
    state.setPendingManagerRuntimeRecycle("m2", "model_change");
    state.setPendingManagerRuntimeRecycle("m1", "prompt_mode_change");

    const listed = state.listPendingManagerRuntimeRecycles();
    listed[0]!.reason = "cwd_change";

    expect(listed).toEqual([
      { agentId: "m1", reason: "cwd_change" },
      { agentId: "m2", reason: "model_change" }
    ]);
    expect(state.listPendingManagerRuntimeRecycles()).toEqual([
      { agentId: "m1", reason: "prompt_mode_change" },
      { agentId: "m2", reason: "model_change" }
    ]);
  });
});
