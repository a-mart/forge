import { describe, expect, it, vi } from "vitest";
import {
  assertForgeRuntimeEligibleDescriptor,
  interruptExternalThreadWorkerDescriptor,
  reconcilePersistedExternalThreadSidecarsForBoot,
  shouldIncludeDescriptorInBootInterruptedToolReconciliation,
  shouldPreserveExternalThreadWorkerOnSessionStop,
  shouldInterruptExternalThreadSidecar,
  isActiveExternalThreadSidecar,
} from "../external-thread-compatibility.js";
import { createCodexExternalThreadWorkerDescriptor, createWorkerDescriptor } from "../../test-support/fixtures.js";

describe("external-thread compatibility policy", () => {
  it("rejects Forge runtime creation for external-thread sidecars", () => {
    const codex = createCodexExternalThreadWorkerDescriptor("/tmp", "mgr-1");
    expect(() => assertForgeRuntimeEligibleDescriptor(codex, "create runtime")).toThrow(/external-thread sidecar/);
    expect(() => assertForgeRuntimeEligibleDescriptor(createWorkerDescriptor("/tmp", "mgr-1"), "create runtime")).not.toThrow();
  });

  it("interrupts external-thread workers to idle without Forge runtime teardown", () => {
    const codex = createCodexExternalThreadWorkerDescriptor("/tmp", "mgr-1", { status: "streaming" });
    const emitStatusEvent = vi.fn();

    interruptExternalThreadWorkerDescriptor(codex, {
      abort: true,
      emitStatus: true,
      now: () => "2026-05-30T00:00:00.000Z",
      emitStatusEvent,
    });

    expect(codex.status).toBe("idle");
    expect(codex.contextUsage).toBeUndefined();
    expect(emitStatusEvent).toHaveBeenCalledWith(codex.agentId, "idle", 0);
  });

  it("reconciles persisted streaming external-thread sidecars to idle on boot", () => {
    const codex = createCodexExternalThreadWorkerDescriptor("/tmp", "mgr-1", { status: "streaming" });
    const forgeWorker = createWorkerDescriptor("/tmp", "mgr-1", { agentId: "worker-1", status: "streaming" });
    const upsertDescriptor = vi.fn();

    const reconciled = reconcilePersistedExternalThreadSidecarsForBoot({
      descriptors: [codex, forgeWorker],
      now: () => "2026-05-30T00:00:00.000Z",
      upsertDescriptor,
    });

    expect(reconciled).toEqual([codex.agentId]);
    expect(codex.status).toBe("idle");
    expect(forgeWorker.status).toBe("streaming");
    expect(upsertDescriptor).toHaveBeenCalledWith(codex);
  });

  it("preserves external-thread workers on stop session but not on deleteWorkers", () => {
    const codex = createCodexExternalThreadWorkerDescriptor("/tmp", "mgr-1");
    expect(shouldPreserveExternalThreadWorkerOnSessionStop(codex, false)).toBe(true);
    expect(shouldPreserveExternalThreadWorkerOnSessionStop(codex, undefined)).toBe(true);
    expect(shouldPreserveExternalThreadWorkerOnSessionStop(codex, true)).toBe(false);
  });

  it("excludes external-thread sidecars from boot interrupted-tool reconciliation inputs", () => {
    const codex = createCodexExternalThreadWorkerDescriptor("/tmp", "mgr-1", { status: "streaming" });
    const forgeWorker = createWorkerDescriptor("/tmp", "mgr-1", { status: "streaming" });

    expect(shouldIncludeDescriptorInBootInterruptedToolReconciliation(codex)).toBe(false);
    expect(shouldIncludeDescriptorInBootInterruptedToolReconciliation(forgeWorker)).toBe(true);
    expect(shouldIncludeDescriptorInBootInterruptedToolReconciliation({ ...forgeWorker, status: "idle" })).toBe(false);
  });

  it("only treats streaming external-thread sidecars as interruptible", () => {
    const streaming = createCodexExternalThreadWorkerDescriptor("/tmp", "mgr-1", { status: "streaming" });
    const idle = createCodexExternalThreadWorkerDescriptor("/tmp", "mgr-1", { status: "idle" });
    const terminated = createCodexExternalThreadWorkerDescriptor("/tmp", "mgr-1", { status: "terminated" });
    const forgeWorker = createWorkerDescriptor("/tmp", "mgr-1", { status: "streaming" });

    expect(isActiveExternalThreadSidecar(streaming)).toBe(true);
    expect(shouldInterruptExternalThreadSidecar(streaming)).toBe(true);
    expect(isActiveExternalThreadSidecar(idle)).toBe(false);
    expect(shouldInterruptExternalThreadSidecar(idle)).toBe(false);
    expect(isActiveExternalThreadSidecar(terminated)).toBe(false);
    expect(shouldInterruptExternalThreadSidecar(terminated)).toBe(false);
    expect(isActiveExternalThreadSidecar(forgeWorker)).toBe(false);
    expect(shouldInterruptExternalThreadSidecar(forgeWorker)).toBe(false);
  });
});
