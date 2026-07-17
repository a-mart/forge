import type { SessionGoalSnapshot } from "@forge/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  SessionGoalCoordinator,
  type SessionGoalCoordinatorOptions,
  type SessionGoalOwner,
} from "../goals/session-goal-coordinator.js";
import type { SessionGoalState } from "../goals/session-goal-state.js";
import type { SessionGoalStore } from "../goals/session-goal-store.js";
import type { AgentDescriptor } from "../types.js";

const NOW = "2026-07-14T15:00:00.000Z";
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

describe("SessionGoalCoordinator continuation cancellation", () => {
  it("does not send when cancellation invalidates a continuation already awaiting persistence", async () => {
    const harness = createHarness();
    const incremented = makeState("active", 2);
    let markIncrementStarted!: () => void;
    let releaseIncrement!: () => void;
    const incrementStarted = new Promise<void>((resolve) => {
      markIncrementStarted = resolve;
    });
    const incrementGate = new Promise<void>((resolve) => {
      releaseIncrement = resolve;
    });
    const store = {
      incrementTurn: vi.fn(async () => {
        markIncrementStarted();
        await incrementGate;
        return incremented;
      }),
    } as unknown as SessionGoalStore;
    stubContinuationState(harness.coordinator, makeState("active", 1), store);

    const continuation = harness.coordinator.runContinuation("manager");
    await incrementStarted;
    harness.coordinator.cancelScheduledContinuation("manager");
    releaseIncrement();
    await continuation;

    expect(harness.options.sendMessage).not.toHaveBeenCalled();
  });

  it("requires incrementTurn to return an active goal before sending", async () => {
    const harness = createHarness();
    const store = {
      incrementTurn: vi.fn(async () => makeState("paused", 2)),
    } as unknown as SessionGoalStore;
    stubContinuationState(harness.coordinator, makeState("active", 1), store);

    await harness.coordinator.runContinuation("manager");

    expect(harness.options.sendMessage).not.toHaveBeenCalled();
  });

  it("does not send when snapshot publication cancels the continuation re-entrantly", async () => {
    const harness = createHarness();
    const store = {
      incrementTurn: vi.fn(async () => makeState("active", 2)),
    } as unknown as SessionGoalStore;
    stubContinuationState(harness.coordinator, makeState("active", 1), store);
    harness.options.emitSnapshot = vi.fn(() => {
      harness.coordinator.cancelScheduledContinuation("manager");
    });

    await harness.coordinator.runContinuation("manager");

    expect(harness.options.emitSnapshot).toHaveBeenCalledOnce();
    expect(harness.options.sendMessage).not.toHaveBeenCalled();
  });

  it("invalidates continuations before pause and clear perform awaited work", async () => {
    const pauseHarness = createHarness();
    const pauseCalls: string[] = [];
    recordCancellationOrder(pauseHarness.coordinator, pauseCalls);
    const pauseStore = {
      control: vi.fn(async () => {
        pauseCalls.push("store.control");
        return makeState("paused", 2);
      }),
    } as unknown as SessionGoalStore;
    stubMeasuredState(pauseHarness.coordinator, makeState("active", 1), pauseStore, pauseCalls);

    await pauseHarness.coordinator.control("manager", { action: "pause" });
    expect(pauseCalls[0]).toBe("cancel");
    expect(pauseCalls).toContain("store.control");

    const clearHarness = createHarness();
    const clearCalls: string[] = [];
    recordCancellationOrder(clearHarness.coordinator, clearCalls);
    const clearStore = {
      clear: vi.fn(async () => {
        clearCalls.push("store.clear");
        return { schemaVersion: 1, revision: 2, updatedAt: NOW, goal: null };
      }),
    } as unknown as SessionGoalStore;
    stubMeasuredState(clearHarness.coordinator, makeState("active", 1), clearStore, clearCalls);

    await clearHarness.coordinator.clear(clearHarness.owner);
    expect(clearCalls[0]).toBe("cancel");
    expect(clearCalls).toContain("store.clear");
  });

  it("reschedules an active idle goal when an invalidating update is rejected", async () => {
    const harness = createHarness();
    harness.options.hasIncompletePlanSteps = async () => true;
    const cancel = vi.spyOn(harness.coordinator, "cancelScheduledContinuation");
    const schedule = vi.spyOn(harness.coordinator, "scheduleContinuation").mockImplementation(() => {});

    await expect(harness.coordinator.update("manager", "goal-update", { status: "complete" }))
      .rejects.toThrow("Complete the current working-plan steps");

    expect(cancel).toHaveBeenCalledWith("manager");
    expect(schedule).toHaveBeenCalledWith(harness.owner);
  });
});

interface CoordinatorInternals {
  getState(owner: SessionGoalOwner): Promise<SessionGoalState>;
  buildSnapshot(owner: SessionGoalOwner, state: SessionGoalState): Promise<SessionGoalSnapshot>;
  store(owner: SessionGoalOwner): SessionGoalStore;
}

function createHarness(): {
  coordinator: SessionGoalCoordinator;
  options: SessionGoalCoordinatorOptions;
  owner: SessionGoalOwner;
} {
  const owner: SessionGoalOwner = {
    agentId: "manager",
    displayName: "Manager",
    role: "manager",
    managerId: "manager",
    profileId: "profile",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd: "/workspace",
    model: { provider: "openai", modelId: "gpt-5" },
    sessionFile: "/data/manager.jsonl",
  };
  const descriptors = new Map<string, AgentDescriptor>([[owner.agentId, owner]]);
  const options: SessionGoalCoordinatorOptions = {
    dataDir: "/data",
    descriptors,
    now: () => NOW,
    isSessionAgent: (descriptor): descriptor is SessionGoalOwner =>
      descriptor?.role === "manager" && typeof descriptor.profileId === "string",
    assertNotArchived: vi.fn(),
    isArchived: () => false,
    getWorkers: () => [],
    hasPendingChoices: () => false,
    hasIncompletePlanSteps: async () => false,
    isRuntimeRecoveryActive: () => false,
    isRestartRecoveryDecisionPending: () => false,
    getActiveExternalTurn: () => undefined,
    sendMessage: vi.fn(async () => ({ delivery: "sent" as const })),
    emitSnapshot: vi.fn(),
    recordToolSideEffect: vi.fn(),
    logDebug: vi.fn(),
  };
  return { coordinator: new SessionGoalCoordinator(options), options, owner };
}

function stubContinuationState(
  coordinator: SessionGoalCoordinator,
  state: SessionGoalState,
  store: SessionGoalStore,
): void {
  const internals = coordinator as unknown as CoordinatorInternals;
  vi.spyOn(internals, "getState").mockResolvedValue(state);
  vi.spyOn(internals, "buildSnapshot").mockResolvedValue(makeSnapshot(state));
  vi.spyOn(internals, "store").mockReturnValue(store);
}

function stubMeasuredState(
  coordinator: SessionGoalCoordinator,
  state: SessionGoalState,
  store: SessionGoalStore,
  calls: string[],
): void {
  const internals = coordinator as unknown as CoordinatorInternals;
  vi.spyOn(internals, "getState").mockImplementation(async () => {
    calls.push("state");
    return state;
  });
  vi.spyOn(internals, "buildSnapshot").mockImplementation(async (_owner, current) => {
    calls.push("snapshot");
    return makeSnapshot(current);
  });
  vi.spyOn(internals, "store").mockReturnValue(store);
}

function recordCancellationOrder(
  coordinator: SessionGoalCoordinator,
  calls: string[],
): void {
  const cancel = coordinator.cancelScheduledContinuation.bind(coordinator);
  vi.spyOn(coordinator, "cancelScheduledContinuation").mockImplementation((agentId) => {
    calls.push("cancel");
    cancel(agentId);
  });
}

function makeState(status: "active" | "paused", revision: number): SessionGoalState {
  return {
    schemaVersion: 1,
    revision,
    updatedAt: NOW,
    goal: {
      id: "goal-1",
      objective: "Ship safely",
      status,
      createdAt: NOW,
      updatedAt: NOW,
      activeElapsedMs: 0,
      ...(status === "active" ? { activeSince: NOW } : { pauseReason: "user" as const }),
      turnCount: revision,
    },
  };
}

function makeSnapshot(state: SessionGoalState): SessionGoalSnapshot {
  return {
    revision: state.revision,
    measuredAt: NOW,
    goal: state.goal
      ? {
          id: state.goal.id,
          objective: state.goal.objective,
          status: state.goal.status,
          createdAt: state.goal.createdAt,
          updatedAt: state.goal.updatedAt,
          activeElapsedMs: state.goal.activeElapsedMs,
          turnCount: state.goal.turnCount,
          usage: ZERO_USAGE,
          usageCoverage: "complete",
        }
      : null,
  };
}
