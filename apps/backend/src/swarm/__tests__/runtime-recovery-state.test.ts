import { describe, expect, it } from "vitest";
import { RuntimeRecoveryState } from "../runtime/runtime-recovery-state.js";

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

    state.clearPendingManagerRuntimeRecycle("m1");
    expect(state.hasPendingManagerRuntimeRecycle("m1")).toBe(false);
    expect(state.getPendingManagerRuntimeRecycleReason("m1")).toBeUndefined();
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
