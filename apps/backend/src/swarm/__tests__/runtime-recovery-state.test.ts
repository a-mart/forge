import { describe, expect, it } from "vitest";
import {
  isRuntimeRecoveryActiveForRuntime,
  RuntimeRecoveryState
} from "../runtime/runtime-recovery-state.js";

describe("RuntimeRecoveryState", () => {
  it("tracks pending manager runtime recycle reasons", () => {
    const state = new RuntimeRecoveryState();

    expect(state.hasPendingManagerRuntimeRecycle("m1")).toBe(false);
    expect(state.getPendingManagerRuntimeRecycleReason("m1")).toBeUndefined();

    state.setPendingManagerRuntimeRecycle("m1", "cwd_change");

    expect(state.hasPendingManagerRuntimeRecycle("m1")).toBe(true);
    expect(state.getPendingManagerRuntimeRecycleReason("m1")).toBe("cwd_change");

    state.setPendingManagerRuntimeRecycle("m1", "specialist_roster_change");
    expect(state.getPendingManagerRuntimeRecycleReason("m1")).toBe("specialist_roster_change");

    state.setPendingManagerRuntimeRecycle("m1", "secure_session_mode_change");
    expect(state.getPendingManagerRuntimeRecycleReason("m1")).toBe("secure_session_mode_change");

    state.clearPendingManagerRuntimeRecycle("m1");
    expect(state.hasPendingManagerRuntimeRecycle("m1")).toBe(false);
    expect(state.getPendingManagerRuntimeRecycleReason("m1")).toBeUndefined();
  });

  it("tracks recovery-aborted worker turns independently from pending recycle state", () => {
    const state = new RuntimeRecoveryState();

    expect(state.hasRecoveryAbortedWorkerTurn("w1")).toBe(false);
    state.markRecoveryAbortedWorkerTurn("w1");

    expect(state.hasRecoveryAbortedWorkerTurn("w1")).toBe(true);
    expect(state.hasPendingManagerRuntimeRecycle("w1")).toBe(false);

    state.setPendingManagerRuntimeRecycle("m1", "model_change");
    state.clearRecoveryAbortedWorkerTurn("w1");

    expect(state.hasRecoveryAbortedWorkerTurn("w1")).toBe(false);
    expect(state.hasPendingManagerRuntimeRecycle("m1")).toBe(true);
  });

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
