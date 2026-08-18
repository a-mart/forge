import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDescriptor, AgentStatus, ManagerProfile, SessionAttentionReason } from "@forge/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  SessionAttentionCoordinator,
  type SessionAttentionSessionSnapshot,
} from "../session/session-attention-coordinator.js";
import { isSessionAttentionEligible } from "../session/session-attention-eligibility.js";
import {
  cloneSessionAttentionState,
  emptySessionAttentionState,
  SessionAttentionStore,
  type PersistedSessionAttentionState,
} from "../session/session-attention-store.js";

const NOW = "2026-08-04T12:00:00.000Z";

function profile(overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId: "profile-1",
    displayName: "Profile",
    defaultSessionAgentId: "manager-1",
    defaultModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function manager(
  status: AgentStatus = "idle",
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId: "manager-1",
    managerId: "manager-1",
    displayName: "Original room name",
    role: "manager",
    status,
    createdAt: NOW,
    updatedAt: NOW,
    cwd: "/repo",
    model: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" },
    sessionFile: "/repo/.forge/sessions/manager-1.jsonl",
    profileId: "profile-1",
    ...overrides,
  };
}

function session(
  status: AgentStatus = "idle",
  overrides: Partial<SessionAttentionSessionSnapshot> = {},
): SessionAttentionSessionSnapshot {
  return {
    manager: manager(status),
    profile: profile(),
    activeWorkerCount: 0,
    hasTerminallyErroredWorker: false,
    pendingChoiceCount: 0,
    pendingTurnContextCount: 0,
    ...overrides,
  };
}

function statusObservation(
  previousStatus: AgentStatus,
  nextStatus: AgentStatus,
  snapshot = session(nextStatus),
  source: "manager" | "owned_worker" = "manager",
) {
  return {
    ...snapshot,
    agentId: source === "manager" ? snapshot.manager.agentId : "worker-1",
    source,
    previousStatus,
    nextStatus,
    transitionedAt: snapshot.manager.updatedAt,
  } as const;
}

class MemoryAttentionStore {
  state: PersistedSessionAttentionState = emptySessionAttentionState();
  /** Set to fail the next write, simulating a durable-save failure. */
  failNextWrite = false;
  readonly store = new SessionAttentionStore({
    filePath: "/memory/session-attention.json",
    readFile: async () => JSON.stringify(this.state),
    write: async (_path, next) => {
      if (this.failNextWrite) {
        this.failNextWrite = false;
        throw new Error("simulated write failure");
      }
      this.state = cloneSessionAttentionState(next);
    },
  });
}

function createHarness(options: {
  eligibility?: boolean;
  reason?: (input: { sessionAgentId: string; profileId: string; workStartedAt: string; hadError: boolean }) => SessionAttentionReason | undefined;
} = {}) {
  const memory = new MemoryAttentionStore();
  const changes: Array<{ revision: number; changes: unknown[] }> = [];
  let id = 0;
  const reason = vi.fn(options.reason ?? (() => undefined));
  const coordinator = new SessionAttentionCoordinator({
    store: memory.store,
    isEligible: () => options.eligibility ?? true,
    getReason: reason,
    now: () => NOW,
    randomId: () => `attention-${++id}`,
    onChange: (update) => changes.push(update),
  });
  return { coordinator, memory, changes, reason };
}

async function armManager(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.coordinator.observeStatus(statusObservation("idle", "streaming"));
}

async function settleManager(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.coordinator.observeStatus(statusObservation("streaming", "idle"));
}

describe("SessionAttentionCoordinator state machine", () => {
  it("never creates attention from every unarmed false-positive input", async () => {
    const h = createHarness({ reason: () => "plan_completed" });
    await h.coordinator.initialize();

    // Cold boot inventory, repeated idle, choice churn, queued-turn release,
    // reads/snapshots, dismissal, and plan reason availability are all unarmed.
    await h.coordinator.reconcileAfterBoot([session("idle")]);
    await h.coordinator.observeStatus(statusObservation("idle", "idle"));
    await h.coordinator.observeAggregateChange(session("idle", { pendingChoiceCount: 1 }));
    await h.coordinator.observeAggregateChange(session("idle", { pendingChoiceCount: 0, pendingTurnContextCount: 1 }));
    await h.coordinator.observeAggregateChange(session("idle"));
    expect(h.coordinator.getSnapshot()).toEqual({ revision: 0, attentions: [] });
    await h.coordinator.dismissAttentionIds(["unknown-attention"]);

    expect(h.coordinator.getSnapshot()).toEqual({ revision: 0, attentions: [] });
    expect(h.changes).toEqual([]);
    expect(h.reason).not.toHaveBeenCalled();
  });

  it("raises exactly once when an armed manager crosses into full quiescence", async () => {
    const h = createHarness();
    await h.coordinator.initialize();

    await armManager(h);
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    await settleManager(h);
    expect(h.coordinator.getSnapshot()).toEqual({
      revision: 2,
      attentions: [{
        attentionId: "attention-1",
        sessionAgentId: "manager-1",
        profileId: "profile-1",
        reason: "work_settled",
        raisedAt: NOW,
      }],
    });

    await h.coordinator.observeStatus(statusObservation("idle", "idle"));
    await h.coordinator.observeAggregateChange(session("idle"));
    expect(h.coordinator.getSnapshot().revision).toBe(2);
    expect(h.changes).toHaveLength(1);
  });

  it("requires every quiescence term and releases only after the blocker is gone", async () => {
    const h = createHarness();
    await h.coordinator.initialize();
    await armManager(h);

    // Manager idle alone is insufficient while a worker remains streaming.
    await h.coordinator.observeStatus(statusObservation(
      "streaming",
      "idle",
      session("idle", { activeWorkerCount: 1 }),
    ));
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    // Last worker finishing makes the already armed session settle.
    await h.coordinator.observeStatus(statusObservation(
      "streaming",
      "idle",
      session("idle", { activeWorkerCount: 0 }),
      "owned_worker",
    ));
    expect(h.coordinator.getSnapshot().attentions).toHaveLength(1);

    const blocked = createHarness();
    await blocked.coordinator.initialize();
    await armManager(blocked);
    await blocked.coordinator.observeStatus(statusObservation(
      "streaming",
      "idle",
      session("idle", { pendingChoiceCount: 1 }),
    ));
    expect(blocked.coordinator.getSnapshot().attentions).toEqual([{
      attentionId: "attention-1",
      sessionAgentId: "manager-1",
      profileId: "profile-1",
      reason: "decision_waiting",
      raisedAt: NOW,
    }]);
    await blocked.coordinator.observeAggregateChange(session("idle", { pendingChoiceCount: 0 }));
    expect(blocked.coordinator.getSnapshot().attentions).toHaveLength(1);
    expect(blocked.coordinator.getSnapshot().attentions[0]?.reason).toBe("work_settled");
  });

  it("raises decision_waiting while a still-streaming manager is waiting on present_choices", async () => {
    const h = createHarness();
    await h.coordinator.initialize();
    await armManager(h);

    await h.coordinator.observeAggregateChange(session("streaming", { pendingChoiceCount: 1 }));
    expect(h.coordinator.getSnapshot().attentions).toEqual([{
      attentionId: "attention-1",
      sessionAgentId: "manager-1",
      profileId: "profile-1",
      reason: "decision_waiting",
      raisedAt: NOW,
    }]);

    // Answering the choice while work continues retracts Needs You so Active
    // can own the still-running session again.
    await h.coordinator.observeAggregateChange(session("streaming", { pendingChoiceCount: 0 }));
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    await h.coordinator.observeStatus(statusObservation("streaming", "idle"));
    expect(h.coordinator.getSnapshot().attentions[0]?.reason).toBe("work_settled");
  });

  it("does not settle when an accepted turn is dequeued before the manager streams", async () => {
    // Regression: TurnContextCoordinator dequeues on the provider's user
    // message_start, which can precede the manager's streaming projection.
    // Treating that count-to-zero as permission broadcasts a completion that
    // never happened — the highest-cost false raise in the design.
    const h = createHarness();
    await h.coordinator.initialize();
    await armManager(h);

    await h.coordinator.observeStatus(statusObservation(
      "streaming",
      "idle",
      session("idle", { pendingTurnContextCount: 1 }),
    ));
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    // Dequeued, but the manager still reads idle: must NOT raise.
    await h.coordinator.observeAggregateChange(session("idle", { pendingTurnContextCount: 0 }));
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    // The continuation actually starts, then finishes: exactly one raise.
    await h.coordinator.observeStatus(statusObservation("idle", "streaming", session("streaming")));
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    await h.coordinator.observeStatus(statusObservation("streaming", "idle", session("idle")));
    expect(h.coordinator.getSnapshot().attentions).toHaveLength(1);
  });

  it("releases the accepted-turn barrier when no continuation follows", async () => {
    // Rollback/discard: the turn ended without a continuation, so the epoch
    // must still be able to settle rather than staying armed forever.
    const h = createHarness();
    await h.coordinator.initialize();
    await armManager(h);

    await h.coordinator.observeStatus(statusObservation(
      "streaming",
      "idle",
      session("idle", { pendingTurnContextCount: 1 }),
    ));
    // Rolling back one accepted turn cannot clear the fence while another is
    // still queued.
    await h.coordinator.releaseContinuationBarrier(session("idle", { pendingTurnContextCount: 1 }));
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    await h.coordinator.observeAggregateChange(session("idle", { pendingTurnContextCount: 0 }));
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    await h.coordinator.releaseContinuationBarrier(session("idle", { pendingTurnContextCount: 0 }));
    expect(h.coordinator.getSnapshot().attentions).toHaveLength(1);
  });

  it("never applies a dismissal that already reported failure", async () => {
    // A rejected dismissal must not be retried behind the user's back: the
    // other device would see an unexplained removal it can never correlate.
    const h = createHarness();
    await h.coordinator.initialize();
    await armManager(h);
    await h.coordinator.observeStatus(statusObservation("streaming", "idle"));

    const raised = h.coordinator.getSnapshot().attentions;
    expect(raised).toHaveLength(1);
    const attentionId = raised[0]!.attentionId;

    h.memory.failNextWrite = true;
    await expect(h.coordinator.dismissAttentionIds([attentionId])).rejects.toThrow();
    expect(h.coordinator.getSnapshot().attentions).toHaveLength(1);

    // A later natural observation must succeed WITHOUT resurrecting the
    // dismissal, and must emit no removal for it.
    const before = h.changes.length;
    await h.coordinator.observeAggregateChange(session("idle"));
    expect(h.coordinator.getSnapshot().attentions).toHaveLength(1);
    const removals = h.changes
      .slice(before)
      .flatMap((update) => update.changes as Array<{ attention: unknown }>)
      .filter((change) => change.attention === null);
    expect(removals).toEqual([]);
  });

  it("retries a failed natural observation because its runtime fact still holds", async () => {
    const h = createHarness();
    await h.coordinator.initialize();

    // Natural observations deliberately do not throw at producers — attention
    // must never stall a runtime — but the write is deferred, not discarded.
    h.memory.failNextWrite = true;
    await armManager(h);
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    // The next operation flushes the deferred arm, so the epoch is not lost.
    await h.coordinator.observeStatus(statusObservation("streaming", "idle"));
    expect(h.coordinator.getSnapshot().attentions).toHaveLength(1);
  });

  it("coalesces a failed settle with an accepted continuation before publication", async () => {
    const h = createHarness();
    await h.coordinator.initialize();
    await armManager(h);

    h.memory.failNextWrite = true;
    await settleManager(h);
    await h.coordinator.observeAggregateChange(session("idle", { pendingTurnContextCount: 1 }));

    expect(h.coordinator.getSnapshot().attentions).toEqual([]);
    expect(h.changes.flatMap((update) => update.changes)).toEqual([]);
    await h.coordinator.observeAggregateChange(session("idle"));
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    await h.coordinator.releaseContinuationBarrier(session("idle"));
    expect(h.coordinator.getSnapshot().attentions).toEqual([
      expect.objectContaining({ attentionId: "attention-2" }),
    ]);
  });

  it("coalesces a failed settle with a newer streaming epoch before publication", async () => {
    const h = createHarness();
    await h.coordinator.initialize();
    await armManager(h);

    h.memory.failNextWrite = true;
    await settleManager(h);
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    // The failed target contains settled attention, but the newer committed
    // runtime fact supersedes it. Retrying must persist the working epoch
    // directly, without an intermediate upsert for the stale occurrence.
    await h.coordinator.observeStatus(statusObservation("idle", "streaming"));
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);
    expect(h.changes.flatMap((update) => update.changes)).toEqual([]);

    await settleManager(h);
    expect(h.coordinator.getSnapshot().attentions).toEqual([
      expect.objectContaining({ attentionId: "attention-2" }),
    ]);
  });

  it("only arms from an eligible manager or owned-worker streaming transition", async () => {
    const h = createHarness();
    await h.coordinator.initialize();

    await h.coordinator.observeAggregateChange(session("idle"));
    await h.coordinator.observeStatus({
      ...statusObservation("idle", "streaming"),
      source: "manager",
      agentId: "not-the-manager",
    });
    await h.coordinator.observeStatus(statusObservation("streaming", "idle"));
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    await h.coordinator.observeStatus(statusObservation("idle", "streaming", session("idle"), "owned_worker"));
    await h.coordinator.observeStatus(statusObservation("streaming", "idle", session("idle"), "owned_worker"));
    expect(h.coordinator.getSnapshot().attentions).toHaveLength(1);

    const ineligible = createHarness({ eligibility: false });
    await ineligible.coordinator.initialize();
    await armManager(ineligible);
    await settleManager(ineligible);
    expect(ineligible.coordinator.getSnapshot().attentions).toEqual([]);
  });

  it("uses plan/graph/error as enrichment only after qualification", async () => {
    const reason = vi.fn((): SessionAttentionReason => "plan_completed");
    const h = createHarness({ reason });
    await h.coordinator.initialize();

    await h.coordinator.observeAggregateChange(session("idle"));
    expect(reason).not.toHaveBeenCalled();
    await armManager(h);
    await h.coordinator.observeStatus(statusObservation(
      "streaming",
      "idle",
      session("idle", { pendingChoiceCount: 1 }),
    ));
    expect(reason).not.toHaveBeenCalled();
    expect(h.coordinator.getSnapshot().attentions[0]?.reason).toBe("decision_waiting");
    await h.coordinator.observeAggregateChange(session("idle"));
    expect(h.coordinator.getSnapshot().attentions[0]?.reason).toBe("plan_completed");
    expect(reason).toHaveBeenCalledTimes(1);

    const failed = createHarness({ reason: () => "decision_waiting" });
    await failed.coordinator.initialize();
    await armManager(failed);
    await failed.coordinator.observeStatus(statusObservation("streaming", "error", session("error")));
    await failed.coordinator.observeStatus(statusObservation("error", "idle"));
    expect(failed.coordinator.getSnapshot().attentions[0]?.reason).toBe("work_failed");

    // Restart-safe current evidence wins even if the earlier error transition
    // was persisted on the worker descriptor but missed by the coordinator.
    const recovered = createHarness({ reason: () => "decision_waiting" });
    await recovered.coordinator.initialize();
    await armManager(recovered);
    await recovered.coordinator.observeStatus(statusObservation(
      "streaming",
      "idle",
      session("idle", { hasTerminallyErroredWorker: true }),
    ));
    expect(recovered.coordinator.getSnapshot().attentions[0]?.reason).toBe("work_failed");
  });

  it("uses the producer's committed transition timestamp as the epoch boundary", async () => {
    const committedAt = "2026-08-04T11:59:58.000Z";
    const h = createHarness({ reason: () => "plan_completed" });
    await h.coordinator.initialize();
    await h.coordinator.observeStatus({
      ...statusObservation("idle", "streaming"),
      transitionedAt: committedAt,
    });
    await settleManager(h);

    expect(h.reason).toHaveBeenCalledWith(expect.objectContaining({
      workStartedAt: committedAt,
    }));
  });

  it("manual suppression discards only working epochs and preserves settled attention", async () => {
    const h = createHarness();
    await h.coordinator.initialize();
    await armManager(h);
    await settleManager(h);
    const settled = h.coordinator.getSnapshot().attentions;

    await h.coordinator.suppressWorkingEpoch("manager-1");
    expect(h.coordinator.getSnapshot().attentions).toEqual(settled);

    await armManager(h);
    await h.coordinator.suppressWorkingEpoch("manager-1");
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);
    await settleManager(h);
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);

    const failedSettle = createHarness();
    await failedSettle.coordinator.initialize();
    await armManager(failedSettle);
    failedSettle.memory.failNextWrite = true;
    await settleManager(failedSettle);
    await failedSettle.coordinator.suppressWorkingEpoch("manager-1");
    expect(failedSettle.coordinator.getSnapshot().attentions).toEqual([]);
    expect(failedSettle.changes.flatMap((update) => update.changes)).toEqual([]);
  });

  it("replaces a settled occurrence only after a new streaming epoch and protects stale dismissals", async () => {
    const h = createHarness();
    await h.coordinator.initialize();
    await armManager(h);
    await settleManager(h);
    const firstId = h.coordinator.getSnapshot().attentions[0]!.attentionId;

    await h.coordinator.observeStatus(statusObservation("idle", "streaming"));
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);
    await settleManager(h);
    const secondId = h.coordinator.getSnapshot().attentions[0]!.attentionId;
    expect(secondId).not.toBe(firstId);

    const stale = await h.coordinator.dismissAttentionIds([firstId]);
    expect(stale.changes).toEqual([]);
    expect(h.coordinator.getSnapshot().attentions[0]?.attentionId).toBe(secondId);
  });

  it("dismisses exact ids idempotently across concurrent clients", async () => {
    const h = createHarness();
    await h.coordinator.initialize();
    await armManager(h);
    await settleManager(h);
    const attentionId = h.coordinator.getSnapshot().attentions[0]!.attentionId;

    const [first, second] = await Promise.all([
      h.coordinator.dismissAttentionIds([attentionId]),
      h.coordinator.dismissAttentionIds([attentionId]),
    ]);
    expect([first.changes.length, second.changes.length].sort()).toEqual([0, 1]);
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);
    expect(h.coordinator.getSnapshot().revision).toBe(3);
  });

  it("keeps attention stable through rename and retires it for archive/delete without rearming restore", async () => {
    const h = createHarness();
    await h.coordinator.initialize();
    await armManager(h);
    await settleManager(h);
    const attentionId = h.coordinator.getSnapshot().attentions[0]!.attentionId;

    await h.coordinator.observeAggregateChange(session("idle", {
      manager: manager("idle", { displayName: "Renamed room" }),
    }));
    expect(h.coordinator.getSnapshot().attentions[0]?.attentionId).toBe(attentionId);

    await h.coordinator.retireSession("manager-1");
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);
    await h.coordinator.observeAggregateChange(session("idle")); // restore baseline
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);
    await h.coordinator.retireSession("manager-1"); // delete is idempotent
    expect(h.coordinator.getSnapshot().attentions).toEqual([]);
  });

  it("uses the WP1 eligibility predicate as an injected seam", async () => {
    const eligible = vi.fn(isSessionAttentionEligible);
    const memory = new MemoryAttentionStore();
    const coordinator = new SessionAttentionCoordinator({
      store: memory.store,
      isEligible: eligible,
      now: () => NOW,
      randomId: () => "attention-1",
    });
    await coordinator.initialize();
    await coordinator.observeStatus(statusObservation("idle", "streaming"));
    await coordinator.observeStatus(statusObservation("streaming", "idle"));

    expect(eligible).toHaveBeenCalled();
    expect(coordinator.getSnapshot().attentions).toHaveLength(1);
  });
});

describe("SessionAttentionCoordinator persistence and boot reconciliation", () => {
  it("preserves an armed working epoch across restart and settles it once, unlike idle inventory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "session-attention-restart-"));
    const firstStore = new SessionAttentionStore({ dataDir, now: () => NOW, randomId: () => "corrupt" });
    const first = new SessionAttentionCoordinator({
      store: firstStore,
      isEligible: () => true,
      now: () => NOW,
      randomId: () => "attention-after-restart",
    });
    await first.initialize();
    await first.observeStatus(statusObservation("idle", "streaming"));
    expect(first.getSnapshot().attentions).toEqual([]);

    const restarted = new SessionAttentionCoordinator({
      store: new SessionAttentionStore({ dataDir, now: () => NOW, randomId: () => "corrupt" }),
      isEligible: () => true,
      now: () => NOW,
      randomId: () => "attention-after-restart",
    });
    await restarted.initialize();
    await restarted.reconcileAfterBoot([session("idle")]);
    expect(restarted.getSnapshot().attentions.map((attention) => attention.attentionId)).toEqual(["attention-after-restart"]);
    await restarted.reconcileAfterBoot([session("idle")]);
    expect(restarted.getSnapshot().attentions).toHaveLength(1);

    const idleOnly = new SessionAttentionCoordinator({
      store: new SessionAttentionStore({ dataDir: await mkdtemp(join(tmpdir(), "session-attention-idle-")) }),
      isEligible: () => true,
      now: () => NOW,
      randomId: () => "must-not-exist",
    });
    await idleOnly.initialize();
    await idleOnly.reconcileAfterBoot([session("idle")]);
    expect(idleOnly.getSnapshot().attentions).toEqual([]);
  });

  it("recovers a durable settle after the crash window before any broadcast", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "session-attention-crash-window-"));
    const crashingProcess = new SessionAttentionCoordinator({
      store: new SessionAttentionStore({ dataDir }),
      isEligible: () => true,
      now: () => NOW,
      randomId: () => "durable-attention",
      // Deliberately no listener: process dies after replace and before WP4 fanout.
    });
    await crashingProcess.initialize();
    await crashingProcess.observeStatus(statusObservation("idle", "streaming"));
    await crashingProcess.observeStatus(statusObservation("streaming", "idle"));

    const restarted = new SessionAttentionCoordinator({
      store: new SessionAttentionStore({ dataDir }),
      isEligible: () => true,
      now: () => NOW,
      randomId: () => "unused",
    });
    await restarted.initialize();
    expect(restarted.getSnapshot().attentions.map((attention) => attention.attentionId)).toEqual(["durable-attention"]);
  });

  it("fails closed and quarantines a malformed store without manufacturing idle attention", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "session-attention-corrupt-"));
    const store = new SessionAttentionStore({ dataDir, now: () => NOW, randomId: () => "corrupt-test" });
    await writeFile(store.filePath, "{ this is not valid json", "utf8");
    const h = new SessionAttentionCoordinator({
      store,
      isEligible: () => true,
      now: () => NOW,
      randomId: () => "must-not-exist",
    });

    await h.initialize();
    await h.reconcileAfterBoot([session("idle")]);
    expect(h.getSnapshot()).toEqual({ revision: 0, attentions: [] });
    expect((await readdir(dataDir)).some((entry) => entry.startsWith("session-attention.json.corrupt-"))).toBe(true);
  });
});
