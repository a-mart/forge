import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";
import { describe, expect, it, vi } from "vitest";
import type { SwarmManager } from "../../swarm-manager.js";
import type { RemoteUpdateAwarenessScheduler } from "../remote-update-awareness-scheduler.js";
import { RemoteUpdateAwarenessService as CoreRemoteUpdateAwarenessService } from "../remote-update-awareness-service.js";
import { createTestStore, OID_A, OID_B, target } from "./test-helpers.js";
import { LocalRemoteUpdateAwarenessService } from "../../../ws/http/services/remote-update-awareness-service.js";

function profile(projectId: string, archivedAt?: string): ManagerProfile {
  return {
    profileId: projectId,
    displayName: projectId,
    defaultSessionAgentId: `${projectId}-session`,
    defaultModel: { provider: "test", modelId: "test", thinkingLevel: "off" },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...(archivedAt ? { archivedAt } : {}),
  };
}

function descriptor(projectId: string, cwd: string): AgentDescriptor {
  return {
    agentId: `${projectId}-session`,
    managerId: `${projectId}-session`,
    displayName: projectId,
    role: "manager",
    status: "idle",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    cwd,
    model: { provider: "test", modelId: "test", thinkingLevel: "off" },
    sessionFile: `/${projectId}.jsonl`,
    profileId: projectId,
  };
}

function managerFor(
  getProfiles: () => ManagerProfile[],
  getDescriptors: () => AgentDescriptor[]
): SwarmManager {
  return {
    getConfig: () => ({ runtimeTarget: "builder", paths: {} }),
    listProfiles: getProfiles,
    getAgent: (agentId: string) => getDescriptors().find((entry) => entry.agentId === agentId),
  } as unknown as SwarmManager;
}

function schedulerSpy() {
  const registerProject = vi.fn();
  const unregisterProject = vi.fn();
  const scheduler = {
    registerProject,
    unregisterProject,
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    reconcileEligibility: vi.fn(),
    get activeProject() { return null; },
  } as unknown as RemoteUpdateAwarenessScheduler;
  return { scheduler, registerProject, unregisterProject };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("LocalRemoteUpdateAwarenessService lifecycle", () => {
  it("does not start after stop wins a database-open startup race and closes only after startup settles", async () => {
    const { database } = await createTestStore();
    const opened = deferred<typeof database>();
    const order: string[] = [];
    const service = new LocalRemoteUpdateAwarenessService({
      swarmManager: managerFor(() => [], () => []),
      openDatabase: async () => {
        const result = await opened.promise;
        order.push("opened");
        return result;
      },
      closeDatabase: async () => {
        order.push("closed");
        if (database.open) database.close();
      },
    });

    const startup = service.start();
    const stopped = service.stop();
    opened.resolve(database);
    await Promise.all([startup, stopped]);

    expect(order).toEqual(["opened", "closed"]);
    await expect(service.start()).rejects.toThrow(/stopping/);
  });

  it("does not start the scheduler when stop occurs during project reconciliation", async () => {
    const { database, store } = await createTestStore();
    const eligibility = deferred<boolean>();
    const scheduler = schedulerSpy();
    const service = new LocalRemoteUpdateAwarenessService({
      swarmManager: managerFor(() => [profile("project")], () => [descriptor("project", "/repo")]),
      coreService: new CoreRemoteUpdateAwarenessService(store),
      scheduler: scheduler.scheduler,
      isGitProject: () => eligibility.promise,
    });

    const startup = service.start();
    await Promise.resolve();
    const stopped = service.stop();
    eligibility.resolve(true);
    await Promise.all([startup, stopped]);

    expect(scheduler.scheduler.start).not.toHaveBeenCalled();
    expect(scheduler.scheduler.stop).toHaveBeenCalledTimes(1);
    expect(scheduler.registerProject).not.toHaveBeenCalled();
    database.close();
  });
});

describe("LocalRemoteUpdateAwarenessService Git registry eligibility", () => {
  it("omits non-Git profiles from settings and never registers them for observation", async () => {
    const { database, store } = await createTestStore();
    const project = profile("plain");
    const agent = descriptor("plain", "/plain");
    const scheduler = schedulerSpy();
    const run = vi.fn(async () => ({
      stdout: "",
      stderr: "not a git repository",
      exitCode: 128,
    }));
    const core = new CoreRemoteUpdateAwarenessService(store);
    const service = new LocalRemoteUpdateAwarenessService({
      swarmManager: managerFor(() => [project], () => [agent]),
      coreService: core,
      scheduler: scheduler.scheduler,
      gitFactory: () => ({ run } as never),
    });

    await service.start();
    expect(run).toHaveBeenCalledWith(["rev-parse", "--git-common-dir"], {
      allowFailure: true,
      timeoutMs: 5_000,
      maxBufferBytes: 8 * 1024,
      nonInteractive: true,
    });
    expect(service.getSettingsSnapshot().projects).toEqual([]);
    expect(scheduler.registerProject).not.toHaveBeenCalled();
    expect(core.getProjectRecord("plain")).toBeNull();
    expect(() => service.getProjectSnapshot("plain")).toThrow(/non-Git/);

    await service.stop();
    database.close();
  });

  it("immediately unregisters a Git project whose CWD changes to a non-Git directory", async () => {
    const { database, store } = await createTestStore();
    const project = profile("project");
    let agent = descriptor("project", "/git");
    const scheduler = schedulerSpy();
    const service = new LocalRemoteUpdateAwarenessService({
      swarmManager: managerFor(() => [project], () => [agent]),
      coreService: new CoreRemoteUpdateAwarenessService(store),
      scheduler: scheduler.scheduler,
      isGitProject: async (cwd) => cwd === "/git",
    });

    await service.start();
    expect(service.getSettingsSnapshot().projects).toHaveLength(1);
    agent = descriptor("project", "/plain");
    const reconciliation = service.reconcileProjects();
    expect(service.getSettingsSnapshot().projects).toEqual([]);
    expect(scheduler.unregisterProject).toHaveBeenCalledWith("project");
    await reconciliation;
    expect(scheduler.registerProject).toHaveBeenCalledTimes(1);

    await service.stop();
    database.close();
  });

  it.each(["archive", "remove"] as const)(
    "does not let late Git eligibility re-add a project after %s",
    async (mode) => {
      const { database, store } = await createTestStore();
      let profiles = [profile("project")];
      const agent = descriptor("project", "/git");
      const eligibility = deferred<boolean>();
      const scheduler = schedulerSpy();
      const service = new LocalRemoteUpdateAwarenessService({
        swarmManager: managerFor(() => profiles, () => [agent]),
        coreService: new CoreRemoteUpdateAwarenessService(store),
        scheduler: scheduler.scheduler,
        isGitProject: () => eligibility.promise,
      });

      const pending = service.reconcileProjects();
      profiles = mode === "archive"
        ? [profile("project", "2026-07-20T00:00:00.000Z")]
        : [];
      await service.reconcileProjects();
      eligibility.resolve(true);
      await pending;

      expect(service.getSettingsSnapshot().projects).toEqual([]);
      expect(scheduler.registerProject).not.toHaveBeenCalled();
      database.close();
    }
  );
});

describe("LocalRemoteUpdateAwarenessService shared-monitor cancellation", () => {
  it.each(["disable", "archive"] as const)(
    "keeps a coalesced observation alive for an eligible peer when one project is %sd",
    async (mode) => {
      const { database, store } = await createTestStore();
      let profiles = [profile("a"), profile("b")];
      const agents = [descriptor("a", "/shared-a"), descriptor("b", "/shared-b")];
      const observation = deferred<{ state: "equal"; tipOid: string; observedAt: string }>();
      let observationSignal: AbortSignal | undefined;
      const resolvedTarget = target({ monitorKey: "shared-monitor" });
      const observer = {
        resolveTarget: vi.fn(async () => resolvedTarget),
        observe: vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
          observationSignal = signal;
          return observation.promise;
        }),
      };
      const core = new CoreRemoteUpdateAwarenessService(store, observer as never);
      const gitFactory = () => ({
        run: vi.fn(async (args: string[]) => args[0] === "remote"
          ? { stdout: "origin\n", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 1 }),
      }) as never;
      const service = new LocalRemoteUpdateAwarenessService({
        swarmManager: managerFor(() => profiles, () => agents),
        coreService: core,
        gitFactory,
        isGitProject: async () => true,
      });

      await service.start();
      service.setGlobalEnabled(true);
      const first = service.refreshProject("a").catch(() => null);
      const second = service.refreshProject("b");
      await vi.waitFor(() => expect(observer.observe).toHaveBeenCalledTimes(1));
      expect(core.getProjectRecord("a")?.monitorKey).toBe("shared-monitor");
      expect(core.getProjectRecord("b")?.monitorKey).toBe("shared-monitor");

      if (mode === "disable") {
        service.setProjectOverride("a", "off");
      } else {
        profiles = [profile("a", "2026-07-20T00:00:00.000Z"), profile("b")];
        await service.reconcileProjects();
      }
      expect(observationSignal?.aborted).toBe(false);

      observation.resolve({
        state: "equal",
        tipOid: "a".repeat(40),
        observedAt: "2026-07-20T00:00:00.000Z",
      });
      await expect(second).resolves.toMatchObject({ projectId: "b", state: "up_to_date" });
      await first;
      expect(core.getProjectRecord("b")?.lastCompletedObservedAt).toBe("2026-07-20T00:00:00.000Z");
      expect(core.getProjectRecord("a")?.lastCompletedObservedAt).toBeNull();
      expect(core.getProjectRecord("a")?.failureCount).toBe(0);
      expect(store.getDismissal("a")).toBeNull();

      await service.stop();
      database.close();
    }
  );

  it("fans a shared result out to an active peer while leaving an excluded peer untouched", async () => {
    const { database, store } = await createTestStore();
    const profiles = [profile("a"), profile("b"), profile("c")];
    const agents = [descriptor("a", "/a"), descriptor("b", "/b"), descriptor("c", "/c")];
    const resolvedTarget = target({ monitorKey: "shared-monitor" });
    store.setGlobalEnabled(true);
    for (const projectId of ["a", "b", "c"]) store.associateProject(projectId, resolvedTarget);
    store.recordObservation("a", resolvedTarget, {
      state: "equal", tipOid: OID_A, observedAt: new Date().toISOString(),
    });
    store.setProjectOverride("c", "off");
    const excludedBefore = store.getProject("c");
    const events = vi.fn();
    const observer = {
      resolveTarget: vi.fn(async () => resolvedTarget),
      observe: vi.fn(async () => ({
        state: "remote_ahead" as const,
        tipOid: OID_B,
        observedAt: new Date().toISOString(),
      })),
    };
    const service = new LocalRemoteUpdateAwarenessService({
      swarmManager: managerFor(() => profiles, () => agents),
      coreService: new CoreRemoteUpdateAwarenessService(store, observer as never),
      broadcastProjectEvent: events,
      isGitProject: async () => true,
    });

    await service.start();
    service.activateProject("b");
    events.mockClear();
    const startedAt = Date.now();
    await service.refreshProject("a");

    expect(events).toHaveBeenCalledWith("b", expect.objectContaining({
      type: "remote_update_awareness_project_changed",
      snapshot: expect.objectContaining({ state: "update_available" }),
    }));
    expect(store.getProject("c")).toMatchObject({
      generation: excludedBefore!.generation,
      lastCompletedObservedAt: excludedBefore!.lastCompletedObservedAt,
      failureCount: excludedBefore!.failureCount,
      backoffUntil: excludedBefore!.backoffUntil,
      lastTipOid: excludedBefore!.lastTipOid,
      lastState: excludedBefore!.lastState,
    });
    expect(store.getDismissal("c")).toBeNull();
    const inactiveDue = Date.parse(store.getProject("a")!.nextDueAt!);
    const activeDue = Date.parse(store.getProject("b")!.nextDueAt!);
    expect(activeDue - startedAt).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(activeDue - startedAt).toBeLessThanOrEqual(17 * 60 * 1000 + 1_000);
    expect(inactiveDue - startedAt).toBeGreaterThanOrEqual(50 * 60 * 1000);
    expect(inactiveDue - startedAt).toBeLessThanOrEqual(70 * 60 * 1000 + 1_000);

    await service.stop();
    database.close();
  });
});
