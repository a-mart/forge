import { describe, expect, it, vi } from "vitest";
import { RuntimeErrorProjector, type RuntimeErrorProjectorDeps } from "../runtime/runtime-error-projector.js";
import type { RuntimeErrorEvent } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";

function baseDescriptor(overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId" | "role" | "managerId">): AgentDescriptor {
  const now = "2026-05-06T00:00:00.000Z";
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role: overrides.role,
    managerId: overrides.managerId,
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    cwd: overrides.cwd ?? "/tmp",
    sessionFile: overrides.sessionFile ?? "/tmp/session.jsonl",
    model: overrides.model ?? {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    ...overrides
  };
}

function createHarness(): {
  projector: RuntimeErrorProjector;
  deps: RuntimeErrorProjectorDeps;
  descriptors: Map<string, AgentDescriptor>;
} {
  const descriptors = new Map<string, AgentDescriptor>();
  const deps: RuntimeErrorProjectorDeps = {
    descriptors,
    getRuntimeToken: vi.fn(() => undefined),
    now: vi.fn(() => "2026-05-06T00:00:01.000Z"),
    maybeRecordModelCapacityBlock: vi.fn(),
    dispatchRuntimeError: vi.fn(async () => undefined),
    maybeRecoverWorkerWithSpecialistFallback: vi.fn(async () => false),
    incrementSessionCompactionCount: vi.fn(async () => undefined),
    patchDescriptorFromRuntimeStatus: vi.fn(async (agentId: string, patch: Partial<AgentDescriptor>) => {
      const descriptor = descriptors.get(agentId);
      if (!descriptor) return undefined;
      const updated = { ...descriptor, ...patch };
      descriptors.set(agentId, updated);
      return updated;
    }),
    emitConversationMessage: vi.fn(),
    logDebug: vi.fn()
  };

  return { projector: new RuntimeErrorProjector(deps), deps, descriptors };
}

const defaultError = (overrides: Partial<RuntimeErrorEvent> = {}): RuntimeErrorEvent => ({
  phase: "startup",
  message: "boom",
  ...overrides
});

function emittedText(deps: RuntimeErrorProjectorDeps): string {
  return vi.mocked(deps.emitConversationMessage).mock.calls.at(-1)?.[0].text ?? "";
}

describe("RuntimeErrorProjector", () => {
  it("does nothing when descriptor is missing", async () => {
    const { projector, deps } = createHarness();

    await projector.projectError({ agentId: "missing", error: defaultError() });

    expect(deps.maybeRecordModelCapacityBlock).not.toHaveBeenCalled();
    expect(deps.dispatchRuntimeError).not.toHaveBeenCalled();
    expect(deps.emitConversationMessage).not.toHaveBeenCalled();
  });

  it("normalizes blank messages before capacity recording, extension dispatch, fallback, logging, and emitted text", async () => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-1", role: "worker", managerId: "manager-1" });
    descriptors.set(worker.agentId, worker);

    await projector.projectError({
      runtimeToken: 7,
      agentId: worker.agentId,
      error: defaultError({ phase: "prompt_start", message: "  \t  " })
    });

    expect(deps.maybeRecordModelCapacityBlock).toHaveBeenCalledWith(
      worker.agentId,
      worker,
      expect.objectContaining({ message: "Unknown runtime error" })
    );
    expect(deps.dispatchRuntimeError).toHaveBeenCalledWith(7, expect.objectContaining({ message: "Unknown runtime error" }));
    expect(deps.maybeRecoverWorkerWithSpecialistFallback).toHaveBeenCalledWith(
      worker.agentId,
      "Unknown runtime error",
      "prompt_start",
      7
    );
    expect(deps.logDebug).toHaveBeenCalledWith(
      "runtime:error",
      expect.objectContaining({ message: "Unknown runtime error" })
    );
    expect(emittedText(deps)).toBe("⚠️ Agent error: Unknown runtime error. Message may need to be resent.");
  });

  it("dispatches Forge runtime errors before fallback, and fallback suppresses system message", async () => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-1", role: "worker", managerId: "manager-1" });
    descriptors.set(worker.agentId, worker);
    vi.mocked(deps.maybeRecoverWorkerWithSpecialistFallback).mockResolvedValue(true);

    await projector.projectError({
      runtimeToken: 11,
      agentId: worker.agentId,
      error: defaultError({ phase: "prompt_dispatch", message: "failed" })
    });

    expect(deps.dispatchRuntimeError).toHaveBeenCalledWith(11, expect.objectContaining({ message: "failed" }));
    expect(deps.maybeRecoverWorkerWithSpecialistFallback).toHaveBeenCalledWith(
      worker.agentId,
      "failed",
      "prompt_dispatch",
      11
    );
    expect(deps.emitConversationMessage).not.toHaveBeenCalled();
    expect(vi.mocked(deps.dispatchRuntimeError).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.maybeRecoverWorkerWithSpecialistFallback).mock.invocationCallOrder[0]
    );
  });

  it("uses explicit runtime token before current token fallback and skips dispatch without either token", async () => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-1", role: "worker", managerId: "manager-1" });
    descriptors.set(worker.agentId, worker);
    vi.mocked(deps.getRuntimeToken).mockReturnValue(22);

    await projector.projectError({ runtimeToken: 21, agentId: worker.agentId, error: defaultError() });
    await projector.projectError({ agentId: worker.agentId, error: defaultError({ message: "fallback token" }) });
    vi.mocked(deps.getRuntimeToken).mockReturnValue(undefined);
    await projector.projectError({ agentId: worker.agentId, error: defaultError({ message: "no token" }) });

    expect(deps.dispatchRuntimeError).toHaveBeenNthCalledWith(1, 21, expect.objectContaining({ message: "boom" }));
    expect(deps.dispatchRuntimeError).toHaveBeenNthCalledWith(2, 22, expect.objectContaining({ message: "fallback token" }));
    expect(deps.dispatchRuntimeError).toHaveBeenCalledTimes(2);
  });

  it("preserves compaction text matrix and patches successful auto-compaction count", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({ agentId: "manager-1", role: "manager", managerId: "manager-1", profileId: "profile-1" });
    descriptors.set(manager.agentId, manager);
    vi.mocked(deps.incrementSessionCompactionCount).mockResolvedValue(3);

    await projector.projectError({
      agentId: manager.agentId,
      error: defaultError({ phase: "compaction", message: "Auto-compaction complete", details: { recoveryStage: "auto_compaction_succeeded" } })
    });
    expect(emittedText(deps)).toBe("📋 Auto-compaction complete.");
    expect(deps.incrementSessionCompactionCount).toHaveBeenCalledWith(
      "profile-1",
      manager.agentId,
      "runtime:compact:count-increment-failed"
    );
    expect(deps.patchDescriptorFromRuntimeStatus).toHaveBeenCalledWith(manager.agentId, { compactionCount: 3 });

    await projector.projectError({
      agentId: manager.agentId,
      error: defaultError({ phase: "compaction", message: "too large", details: { recoveryStage: "recovery_failed" } })
    });
    expect(emittedText(deps)).toBe(
      "🚨 Context recovery failed: too large. Start a new session or manually trim history/compact before continuing."
    );

    await projector.projectError({
      agentId: manager.agentId,
      error: defaultError({ phase: "compaction", message: "retrying", details: { attempt: 2, maxAttempts: 3 } })
    });
    expect(emittedText(deps)).toBe("⚠️ Compaction error (attempt 2/3): retrying. Attempting fallback recovery.");
  });

  it("preserves context guard text matrix", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({ agentId: "manager-1", role: "manager", managerId: "manager-1" });
    descriptors.set(manager.agentId, manager);

    await projector.projectError({
      agentId: manager.agentId,
      error: defaultError({ phase: "context_guard", message: "Compaction started", details: { recoveryStage: "guard_started" } })
    });
    expect(emittedText(deps)).toBe("📋 Compaction started.");

    await projector.projectError({
      agentId: manager.agentId,
      error: defaultError({ phase: "context_guard", message: "guard failed", details: { attempt: 1, maxAttempts: 2 } })
    });
    expect(emittedText(deps)).toBe("⚠️ Context guard error (attempt 1/2): guard failed.");
  });

  it("preserves extension text matrix", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({ agentId: "manager-1", role: "manager", managerId: "manager-1" });
    descriptors.set(manager.agentId, manager);

    await projector.projectError({
      agentId: manager.agentId,
      error: defaultError({ phase: "extension", message: "bad", details: { extensionPath: "/tmp/my-ext.ts", event: "runtime:error" } })
    });
    expect(emittedText(deps)).toBe("⚠️ Extension error (my-ext.ts · runtime:error): bad");

    await projector.projectError({
      agentId: manager.agentId,
      error: defaultError({ phase: "extension", message: "bad", details: { extensionPath: "/tmp/my-ext.ts" } })
    });
    expect(emittedText(deps)).toBe("⚠️ Extension error (my-ext.ts): bad");

    await projector.projectError({ agentId: manager.agentId, error: defaultError({ phase: "extension", message: "bad" }) });
    expect(emittedText(deps)).toBe("⚠️ Extension error: bad");
  });

  it("preserves dropped pending pluralization and retry label formatting", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({ agentId: "manager-1", role: "manager", managerId: "manager-1" });
    descriptors.set(manager.agentId, manager);

    await projector.projectError({
      agentId: manager.agentId,
      error: defaultError({ message: "queued", details: { attempt: 2, maxAttempts: 3, droppedPendingCount: 1 } })
    });
    expect(emittedText(deps)).toBe(
      "⚠️ Agent error (attempt 2/3): queued. 1 queued message could not be delivered and were dropped. Please resend."
    );

    await projector.projectError({
      agentId: manager.agentId,
      error: defaultError({ message: "queued", details: { droppedPendingCount: 2 } })
    });
    expect(emittedText(deps)).toBe(
      "⚠️ Agent error: queued. 2 queued messages could not be delivered and were dropped. Please resend."
    );

    await projector.projectError({
      agentId: manager.agentId,
      error: defaultError({ message: "queued", details: { attempt: 1, maxAttempts: 1 } })
    });
    expect(emittedText(deps)).toBe("⚠️ Agent error: queued. Message may need to be resent.");
  });

  it("lets userFacingMessage override generated copy", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({ agentId: "manager-1", role: "manager", managerId: "manager-1" });
    descriptors.set(manager.agentId, manager);

    await projector.projectError({
      agentId: manager.agentId,
      error: defaultError({ phase: "compaction", message: "generated", details: { userFacingMessage: "Custom user-facing copy." } })
    });

    expect(emittedText(deps)).toBe("Custom user-facing copy.");
  });
});
