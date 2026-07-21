import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_UPDATE_ACTIVE_INTERVAL_MS,
  REMOTE_UPDATE_ACTIVE_JITTER_MS,
  REMOTE_UPDATE_FAILURE_BACKOFF_MS,
  REMOTE_UPDATE_INACTIVE_INTERVAL_MS,
  REMOTE_UPDATE_INACTIVE_JITTER_MS,
  RemoteUpdateAwarenessScheduler,
} from "../remote-update-awareness-scheduler.js";
import type { ObserveRemoteUpdateProjectResult } from "../remote-update-awareness-service.js";
import type { RemoteUpdateProjectRecord, RemoteUpdateProjectSnapshot } from "../types.js";

const snapshot: RemoteUpdateProjectSnapshot = {
  projectId: "project",
  globalEnabled: true,
  override: "inherit",
  effectiveEnabled: true,
  monitorKey: "monitor",
  ref: "refs/heads/main",
  tipOid: "a".repeat(40),
  state: "equal",
  generation: 0,
  dismissed: false,
  hasUndismissedUpdate: false,
  lastCompletedObservedAt: null,
};
const success: ObserveRemoteUpdateProjectResult = {
  ok: true, baseline: true, changed: false, generation: 0, snapshot,
  affectedProjectIds: ["project"],
};
const successFor = (projectId: string): ObserveRemoteUpdateProjectResult => ({
  ...success,
  affectedProjectIds: [projectId],
});

function record(overrides: Partial<RemoteUpdateProjectRecord> = {}): RemoteUpdateProjectRecord {
  return {
    projectId: "project", override: "inherit", monitorKey: null, remoteFingerprint: null,
    lastCompletedObservedAt: null, nextDueAt: null, failureCount: 0, backoffUntil: null,
    generation: 0, attentionGeneration: null, lastTipOid: null, lastState: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RemoteUpdateAwarenessScheduler", () => {
  it("uses bounded inactive and active cadence and queues a stale activation immediately", async () => {
    const now = 1_000_000;
    const schedules: Array<{ nextDueAt: string | null; backoffUntil: string | null }> = [];
    const observe = vi.fn(async () => success);
    const scheduler = new RemoteUpdateAwarenessScheduler({
      observeProject: observe,
      getProjectRecord: () => record(),
      isProjectEligible: () => true,
      persistSchedule: (_id, schedule) => schedules.push(schedule),
      now: () => now,
      random: () => 1,
    });
    scheduler.registerProject({ projectId: "project", cwd: "/repo" });
    const inactiveDue = Date.parse(schedules.at(-1)!.nextDueAt!);
    expect(inactiveDue - now).toBe(REMOTE_UPDATE_INACTIVE_INTERVAL_MS + REMOTE_UPDATE_INACTIVE_JITTER_MS);

    scheduler.start();
    expect(scheduler.activateProject("project")).toBe(true);
    await flush();
    expect(observe).toHaveBeenCalledTimes(1);
    const activeDue = Date.parse(schedules.at(-1)!.nextDueAt!);
    expect(activeDue - now).toBe(REMOTE_UPDATE_ACTIVE_INTERVAL_MS + REMOTE_UPDATE_ACTIVE_JITTER_MS);
    await scheduler.stop();
  });

  it("coalesces equivalent refreshes and enforces global concurrency two", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<ObserveRemoteUpdateProjectResult>>>();
    const observe = vi.fn((project: { projectId: string }) => {
      const wait = deferred<ObserveRemoteUpdateProjectResult>();
      pending.set(project.projectId, wait);
      return wait.promise;
    });
    const scheduler = new RemoteUpdateAwarenessScheduler({
      observeProject: observe,
      getProjectRecord: (projectId) => record({ projectId }),
      isProjectEligible: () => true,
      concurrency: 2,
    });
    for (const projectId of ["a", "b", "c"]) scheduler.registerProject({ projectId, cwd: `/${projectId}` });
    scheduler.start();
    const first = scheduler.refreshProject("a");
    const joined = scheduler.refreshProject("a");
    const second = scheduler.refreshProject("b");
    const third = scheduler.refreshProject("c");
    expect(observe.mock.calls.map(([project]) => project.projectId)).toEqual(["a", "b"]);

    pending.get("a")!.resolve(successFor("a"));
    await flush();
    expect(observe.mock.calls.map(([project]) => project.projectId)).toEqual(["a", "b", "c"]);
    pending.get("b")!.resolve(successFor("b"));
    pending.get("c")!.resolve(successFor("c"));
    await Promise.all([first, joined, second, third]);
    expect(observe).toHaveBeenCalledTimes(3);
    await scheduler.stop();
  });

  it("prioritizes active work ahead of inactive due work", async () => {
    let now = 0;
    let timerCallback: (() => void) | undefined;
    const pending = new Map<string, ReturnType<typeof deferred<ObserveRemoteUpdateProjectResult>>>();
    const observe = vi.fn((project: { projectId: string }) => {
      const wait = deferred<ObserveRemoteUpdateProjectResult>();
      pending.set(project.projectId, wait);
      return wait.promise;
    });
    const scheduler = new RemoteUpdateAwarenessScheduler({
      observeProject: observe,
      getProjectRecord: (projectId) => record({ projectId }),
      isProjectEligible: () => true,
      concurrency: 1,
      now: () => now,
      random: () => 0,
      setTimer: (callback) => { timerCallback = callback; return { unref: vi.fn() } as never; },
      clearTimer: vi.fn(),
    });
    for (const projectId of ["a", "b", "c"]) scheduler.registerProject({ projectId, cwd: `/${projectId}` });
    scheduler.start();
    void scheduler.refreshProject("a");
    scheduler.activateProject("b");
    now = REMOTE_UPDATE_INACTIVE_INTERVAL_MS - REMOTE_UPDATE_INACTIVE_JITTER_MS;
    timerCallback?.();
    pending.get("a")!.resolve(successFor("a"));
    await flush();
    expect(observe.mock.calls.map(([project]) => project.projectId).slice(0, 2)).toEqual(["a", "b"]);
    pending.get("b")!.resolve(successFor("b"));
    await flush();
    pending.get("c")?.resolve(successFor("c"));
    await flush();
    await scheduler.stop();
  });

  it("applies failure backoff while allowing an explicit manual retry", async () => {
    const now = 2_000_000;
    let current = record({ failureCount: 1 });
    const failed: ObserveRemoteUpdateProjectResult = {
      ok: false, error: "timeout", snapshot: { ...snapshot, state: "timeout" },
      affectedProjectIds: ["project"],
    };
    const observe = vi.fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(success);
    const persist = vi.fn((_id, schedule) => {
      current = { ...current, nextDueAt: schedule.nextDueAt, backoffUntil: schedule.backoffUntil };
    });
    const scheduler = new RemoteUpdateAwarenessScheduler({
      observeProject: observe,
      getProjectRecord: () => current,
      isProjectEligible: () => true,
      persistSchedule: persist,
      now: () => now,
      random: () => 0.5,
    });
    scheduler.registerProject({ projectId: "project", cwd: "/repo" });
    scheduler.start();
    await scheduler.refreshProject("project");
    expect(Date.parse(current.backoffUntil!) - now).toBe(REMOTE_UPDATE_FAILURE_BACKOFF_MS[0]);
    expect(scheduler.activateProject("project")).toBe(false);
    await scheduler.refreshProject("project");
    expect(observe).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("hydrates durable due time and active failure backoff without generating replacement jitter", async () => {
    const now = 5_000_000;
    const dueAt = now + 30_000;
    const backoffAt = now + 60_000;
    const persist = vi.fn();
    const random = vi.fn(() => 0.75);
    const timerDelays: number[] = [];
    const scheduler = new RemoteUpdateAwarenessScheduler({
      observeProject: async () => success,
      getProjectRecord: () => record({
        nextDueAt: new Date(dueAt).toISOString(),
        backoffUntil: new Date(backoffAt).toISOString(),
        failureCount: 2,
      }),
      isProjectEligible: () => true,
      persistSchedule: persist,
      now: () => now,
      random,
      setTimer: (_callback, delayMs) => {
        timerDelays.push(delayMs);
        return { unref: vi.fn() } as never;
      },
      clearTimer: vi.fn(),
    });

    scheduler.registerProject({ projectId: "project", cwd: "/repo" });
    scheduler.start();
    expect(persist).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(timerDelays.at(-1)).toBe(backoffAt - now);
    expect(scheduler.activateProject("project")).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("remembers activation while disabled and immediately checks stale active work when enabled", async () => {
    let eligible = false;
    const observe = vi.fn(async () => success);
    const scheduler = new RemoteUpdateAwarenessScheduler({
      observeProject: observe,
      getProjectRecord: () => record(),
      isProjectEligible: () => eligible,
      now: () => 9_000_000,
      random: () => 0,
    });
    scheduler.registerProject({ projectId: "project", cwd: "/repo" });
    scheduler.start();
    expect(scheduler.activateProject("project")).toBe(false);
    expect(scheduler.activeProject).toBe("project");
    expect(observe).not.toHaveBeenCalled();

    eligible = true;
    scheduler.reconcileEligibility();
    await flush();
    expect(observe).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("unregisters archives immediately and shutdown drains cancelled observations", async () => {
    const wait = deferred<ObserveRemoteUpdateProjectResult>();
    const cancelProject = vi.fn(() => wait.resolve(success));
    const stopObservations = vi.fn(() => {
      wait.resolve(success);
      return Promise.resolve();
    });
    const scheduler = new RemoteUpdateAwarenessScheduler({
      observeProject: () => wait.promise,
      getProjectRecord: () => record(),
      isProjectEligible: () => true,
      cancelProject,
      stopObservations,
    });
    scheduler.registerProject({ projectId: "project", cwd: "/repo" });
    scheduler.start();
    void scheduler.refreshProject("project").catch(() => undefined);
    expect(scheduler.runningCount).toBe(1);
    scheduler.unregisterProject("project");
    expect(cancelProject).toHaveBeenCalledWith("project");
    await scheduler.stop();
    expect(stopObservations).toHaveBeenCalledTimes(1);
    expect(scheduler.runningCount).toBe(0);
    await expect(scheduler.refreshProject("project")).rejects.toThrow("not eligible");
  });
});
