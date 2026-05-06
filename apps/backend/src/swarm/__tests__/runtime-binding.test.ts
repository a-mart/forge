import type { AgentRuntimeExtensionSnapshot } from "@forge/protocol";
import { describe, expect, it, vi } from "vitest";
import { RuntimeBinding } from "../runtime/runtime-binding.js";
import type { SwarmAgentRuntime } from "../runtime-contracts.js";

function createBinding() {
  return {
    deactivateRuntimeBindings: vi.fn(),
    clearIntentionalStopRuntimeCallbackSuppression: vi.fn(),
  };
}

function runtime(name: string): SwarmAgentRuntime {
  return { name } as unknown as SwarmAgentRuntime;
}

function snapshot(overrides: Partial<AgentRuntimeExtensionSnapshot>): AgentRuntimeExtensionSnapshot {
  return {
    agentId: "agent",
    role: "worker",
    managerId: "manager",
    loadedAt: "2026-01-01T00:00:00.000Z",
    extensions: [
      {
        displayName: "Extension",
        path: "/ext",
        resolvedPath: "/ext/index.ts",
        source: "profile",
        events: ["session_start"],
        tools: ["tool_a"],
      },
    ],
    loadErrors: [{ path: "/bad", error: "boom" }],
    ...overrides,
  };
}

describe("RuntimeBinding", () => {
  it("allocating a second token makes the first stale and current reader returns the second", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);

    const first = binding.allocateRuntimeToken("agent-1");
    const second = binding.allocateRuntimeToken("agent-1");

    expect(first).not.toBe(second);
    expect(binding.getRuntimeToken("agent-1")).toBe(second);
    expect(binding.isCurrentRuntimeToken("agent-1", first)).toBe(false);
    expect(binding.isCurrentRuntimeToken("agent-1", second)).toBe(true);
  });

  it("clearing a stale token deactivates that Forge binding but preserves current token and runtime", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);
    const staleToken = binding.allocateRuntimeToken("agent-1");
    const currentRuntime = runtime("current");
    binding.attachRuntime("agent-1", currentRuntime);
    const currentToken = binding.allocateRuntimeToken("agent-1");

    binding.clearRuntimeToken("agent-1", staleToken);

    expect(options.deactivateRuntimeBindings).toHaveBeenCalledWith(`forge-runtime-${staleToken}`);
    expect(binding.getRuntimeToken("agent-1")).toBe(currentToken);
    expect(binding.runtimes.get("agent-1")).toBe(currentRuntime);
  });

  it("clearing the current token removes token and extension snapshot", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);
    const token = binding.allocateRuntimeToken("agent-1");
    binding.recordRuntimeExtensionSnapshot("agent-1", snapshot({ agentId: "agent-1" }));

    binding.clearRuntimeToken("agent-1", token);

    expect(options.deactivateRuntimeBindings).toHaveBeenCalledWith(`forge-runtime-${token}`);
    expect(binding.getRuntimeToken("agent-1")).toBeUndefined();
    expect(binding.runtimeExtensionSnapshotsByAgentId.has("agent-1")).toBe(false);
  });

  it("detachRuntime(staleToken) returns false, preserves runtime/current token, and deactivates stale binding", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);
    const staleToken = binding.allocateRuntimeToken("agent-1");
    const currentRuntime = runtime("current");
    binding.attachRuntime("agent-1", currentRuntime);
    const currentToken = binding.allocateRuntimeToken("agent-1");

    expect(binding.detachRuntime("agent-1", staleToken)).toBe(false);

    expect(options.deactivateRuntimeBindings).toHaveBeenCalledWith(`forge-runtime-${staleToken}`);
    expect(binding.runtimes.get("agent-1")).toBe(currentRuntime);
    expect(binding.getRuntimeToken("agent-1")).toBe(currentToken);
  });

  it("detachRuntime(currentToken) returns true and removes runtime/current token", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);
    const currentRuntime = runtime("current");
    binding.attachRuntime("agent-1", currentRuntime);
    const currentToken = binding.allocateRuntimeToken("agent-1");

    expect(binding.detachRuntime("agent-1", currentToken)).toBe(true);

    expect(binding.runtimes.has("agent-1")).toBe(false);
    expect(binding.getRuntimeToken("agent-1")).toBeUndefined();
    expect(options.deactivateRuntimeBindings).toHaveBeenCalledWith(`forge-runtime-${currentToken}`);
  });

  it("tracks creation promise lifecycle without clearing newer promise", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);
    const first = Promise.resolve(runtime("first"));
    const second = Promise.resolve(runtime("second"));

    binding.setRuntimeCreationPromise("agent-1", first);
    expect(binding.getRuntimeCreationPromise("agent-1")).toBe(first);

    binding.setRuntimeCreationPromise("agent-1", second);
    expect(binding.clearRuntimeCreationPromiseIfCurrent("agent-1", first)).toBe(false);
    expect(binding.getRuntimeCreationPromise("agent-1")).toBe(second);

    expect(binding.clearRuntimeCreationPromiseIfCurrent("agent-1", second)).toBe(true);
    expect(binding.getRuntimeCreationPromise("agent-1")).toBeUndefined();
  });

  it("restores runtime token for fallback rollback", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);

    binding.allocateRuntimeToken("agent-1");
    binding.restoreRuntimeTokenForFallbackRollback("agent-1", 42);

    expect(binding.getRuntimeToken("agent-1")).toBe(42);
  });

  it("detachRuntimeIfMatches preserves concurrent runtime and supports tokenless detach", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);
    const original = runtime("original");
    const concurrent = runtime("concurrent");

    binding.attachRuntime("agent-1", original);
    const originalToken = binding.allocateRuntimeToken("agent-1");
    binding.attachRuntime("agent-1", concurrent);
    const concurrentToken = binding.allocateRuntimeToken("agent-1");

    expect(binding.detachRuntimeIfMatches("agent-1", original, originalToken)).toBe(false);
    expect(options.deactivateRuntimeBindings).toHaveBeenCalledWith(`forge-runtime-${originalToken}`);
    expect(options.clearIntentionalStopRuntimeCallbackSuppression).toHaveBeenCalledWith("agent-1", originalToken);
    expect(binding.runtimes.get("agent-1")).toBe(concurrent);
    expect(binding.getRuntimeToken("agent-1")).toBe(concurrentToken);

    expect(binding.detachRuntimeIfMatches("agent-1", concurrent)).toBe(true);
    expect(binding.runtimes.has("agent-1")).toBe(false);
    expect(binding.getRuntimeToken("agent-1")).toBe(concurrentToken);
  });

  it("detachRuntimeIfMatches preserves a mismatched current runtime/token instead of clearing it", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);
    const original = runtime("original");
    const concurrent = runtime("concurrent");

    binding.attachRuntime("agent-1", original);
    binding.attachRuntime("agent-1", concurrent);
    const concurrentToken = binding.allocateRuntimeToken("agent-1");
    binding.recordRuntimeExtensionSnapshot("agent-1", snapshot({ agentId: "agent-1" }));

    expect(binding.detachRuntimeIfMatches("agent-1", original, concurrentToken)).toBe(false);

    expect(options.deactivateRuntimeBindings).not.toHaveBeenCalled();
    expect(binding.runtimes.get("agent-1")).toBe(concurrent);
    expect(binding.getRuntimeToken("agent-1")).toBe(concurrentToken);
    expect(binding.runtimeExtensionSnapshotsByAgentId.has("agent-1")).toBe(true);
  });

  it("detachRuntimeIfMatches token-specific path clears only matching current runtime", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);
    const current = runtime("current");
    binding.attachRuntime("agent-1", current);
    const token = binding.allocateRuntimeToken("agent-1");

    expect(binding.detachRuntimeIfMatches("agent-1", current, token)).toBe(true);

    expect(binding.runtimes.has("agent-1")).toBe(false);
    expect(binding.getRuntimeToken("agent-1")).toBeUndefined();
    expect(options.deactivateRuntimeBindings).toHaveBeenCalledWith(`forge-runtime-${token}`);
  });

  it("extension snapshots are defensively cloned and sorted like controller behavior", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);
    const workerB = snapshot({ agentId: "worker-b", role: "worker", managerId: "manager-b", profileId: "profile-b" });
    const managerA = snapshot({ agentId: "manager-a", role: "manager", managerId: "manager-a", profileId: "profile-a" });
    const workerA = snapshot({ agentId: "worker-a", role: "worker", managerId: "manager-a", profileId: "profile-a" });

    binding.recordRuntimeExtensionSnapshot(workerB.agentId, workerB);
    binding.recordRuntimeExtensionSnapshot(managerA.agentId, managerA);
    binding.recordRuntimeExtensionSnapshot(workerA.agentId, workerA);
    workerB.extensions[0]?.events.push("mutated_input");
    workerB.loadErrors[0]!.error = "mutated input";

    const listed = binding.listRuntimeExtensionSnapshots();
    listed[2]!.extensions[0]?.tools.push("mutated_output");
    listed[2]!.loadErrors[0]!.error = "mutated output";

    expect(listed.map((entry) => entry.agentId)).toEqual(["manager-a", "worker-a", "worker-b"]);
    expect(listed[2]!.extensions[0]!.events).toEqual(["session_start"]);
    expect(binding.listRuntimeExtensionSnapshots()[2]!.extensions[0]!.tools).toEqual(["tool_a"]);
    expect(binding.listRuntimeExtensionSnapshots()[2]!.loadErrors[0]!.error).toBe("boom");
  });

  it("invokes intentional-stop suppression clear callback for token-specific and tokenless clear paths", () => {
    const options = createBinding();
    const binding = new RuntimeBinding(options);
    const staleToken = binding.allocateRuntimeToken("agent-1");
    const currentToken = binding.allocateRuntimeToken("agent-1");

    binding.clearRuntimeToken("agent-1", staleToken);
    binding.clearRuntimeToken("agent-1");

    expect(options.clearIntentionalStopRuntimeCallbackSuppression).toHaveBeenCalledWith("agent-1", staleToken);
    expect(options.clearIntentionalStopRuntimeCallbackSuppression).toHaveBeenCalledWith("agent-1", undefined);
    expect(binding.getRuntimeToken("agent-1")).toBeUndefined();
    expect(options.deactivateRuntimeBindings).toHaveBeenCalledTimes(1);
    expect(options.deactivateRuntimeBindings).toHaveBeenCalledWith(`forge-runtime-${staleToken}`);
    expect(currentToken).toBeGreaterThan(staleToken);
  });
});
