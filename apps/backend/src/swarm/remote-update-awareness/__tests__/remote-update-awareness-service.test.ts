import { describe, expect, it, vi } from "vitest";
import { RemoteUpdateGitError } from "../../../versioning/remote-update-awareness-git.js";
import { RemoteUpdateAwarenessCoordinator } from "../remote-update-awareness-coordinator.js";
import { RemoteUpdateAwarenessService } from "../remote-update-awareness-service.js";
import { createTestStore, OID_A, OID_B, target } from "./test-helpers.js";

describe("RemoteUpdateAwarenessService", () => {
  it("coalesces linked-project observation and persists a silent baseline for both", async () => {
    const { database, store } = await createTestStore();
    const resolved = target();
    const observer = {
      resolveTarget: vi.fn(async () => resolved),
      observe: vi.fn(async () => ({ state: "remote_ahead" as const, tipOid: OID_A, observedAt: "2026-01-01T00:00:00.000Z" }))
    };
    const service = new RemoteUpdateAwarenessService(store, observer as never, new RemoteUpdateAwarenessCoordinator());
    const [first, second] = await Promise.all([
      service.observeProject({
        projectId: "project-a", cwd: "/worktree/a", remoteName: "upstream",
        getEligibleProjectIds: (monitorKey) => store.listProjectsForMonitor(monitorKey).map(({ projectId }) => projectId)
      }),
      service.observeProject({
        projectId: "project-b", cwd: "/worktree/b", remoteName: "upstream",
        getEligibleProjectIds: (monitorKey) => store.listProjectsForMonitor(monitorKey).map(({ projectId }) => projectId)
      })
    ]);
    expect(observer.observe).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ ok: true, baseline: true, generation: 1 });
    expect(second).toMatchObject({ ok: true, baseline: true, generation: 1 });
    expect(store.getProject("project-b")?.lastTipOid).toBe(OID_A);

    observer.observe.mockResolvedValueOnce({ state: "remote_ahead", tipOid: OID_B, observedAt: "2026-01-01T01:00:00.000Z" });
    const changed = await service.observeProject({
      projectId: "project-a", cwd: "/worktree/a", remoteName: "upstream",
      getEligibleProjectIds: (monitorKey) => store.listProjectsForMonitor(monitorKey).map(({ projectId }) => projectId)
    });
    expect(changed).toMatchObject({ ok: true, changed: true, generation: 2 });
    expect(store.getProject("project-b")?.generation).toBe(2);
    database.close();
  });

  it("persists one monitor failure for coalesced callers", async () => {
    const { database, store } = await createTestStore();
    const observer = {
      resolveTarget: vi.fn(async () => target()),
      observe: vi.fn(async () => { throw new RemoteUpdateGitError("timeout"); })
    };
    const service = new RemoteUpdateAwarenessService(store, observer as never);
    const [first, second] = await Promise.all([
      service.observeProject({
        projectId: "project-a", cwd: "/a", remoteName: "upstream",
        getEligibleProjectIds: (monitorKey) => store.listProjectsForMonitor(monitorKey).map(({ projectId }) => projectId)
      }),
      service.observeProject({
        projectId: "project-b", cwd: "/b", remoteName: "upstream",
        getEligibleProjectIds: (monitorKey) => store.listProjectsForMonitor(monitorKey).map(({ projectId }) => projectId)
      })
    ]);
    expect(observer.observe).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ ok: false, error: "timeout" });
    expect(second).toMatchObject({ ok: false, error: "timeout" });
    expect(store.getMonitor("monitor-a")).toMatchObject({ latestState: "timeout", generation: 1 });
    expect(store.getProject("project-a")?.failureCount).toBe(1);
    expect(store.getProject("project-b")?.failureCount).toBe(1);
    database.close();
  });

  it("does not commit a coalesced failure after all monitor associations become ineligible", async () => {
    const { database, store } = await createTestStore();
    const observer = {
      resolveTarget: vi.fn(async () => target()),
      observe: vi.fn(async () => { throw new RemoteUpdateGitError("aborted"); })
    };
    const service = new RemoteUpdateAwarenessService(store, observer as never);
    const result = await service.observeProject({
      projectId: "project-a",
      cwd: "/a",
      remoteName: "upstream",
      shouldCommit: () => true,
      getEligibleProjectIds: () => []
    });

    expect(result).toMatchObject({ ok: false, error: "aborted" });
    expect(store.getMonitor("monitor-a")).toMatchObject({ latestState: null, generation: 0 });
    expect(store.getProject("project-a")?.failureCount).toBe(0);
    database.close();
  });

  it("reuses and revalidates the persisted remote and ref without resolving the current branch", async () => {
    const { database, store } = await createTestStore();
    store.associateProject("project-a", target());
    const resolveRemoteName = vi.fn(async () => "wrong-remote");
    const observer = {
      resolveTarget: vi.fn(async () => target()),
      observe: vi.fn(async () => ({
        state: "equal" as const, tipOid: OID_A, observedAt: "2026-01-01T00:00:00.000Z"
      }))
    };
    const service = new RemoteUpdateAwarenessService(store, observer as never);
    await service.observeProject({ projectId: "project-a", cwd: "/a", resolveRemoteName });

    expect(resolveRemoteName).not.toHaveBeenCalled();
    expect(observer.resolveTarget).toHaveBeenCalledWith(expect.objectContaining({
      remoteName: "upstream",
      targetRef: "refs/heads/trunk",
    }));
    database.close();
  });

  it("aborts and drains target resolution when a project becomes excluded", async () => {
    const { database, store } = await createTestStore();
    let eligible = true;
    let resolutionSignal: AbortSignal | undefined;
    const observer = { resolveTarget: vi.fn(), observe: vi.fn() };
    const service = new RemoteUpdateAwarenessService(store, observer as never);
    const pending = service.observeProject({
      projectId: "project-a",
      cwd: "/a",
      shouldCommit: () => eligible,
      resolveRemoteName: (signal) => {
        resolutionSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new RemoteUpdateGitError("aborted")), { once: true });
        });
      },
    });
    await vi.waitFor(() => expect(resolutionSignal).toBeDefined());
    eligible = false;
    service.cancelProjectResolution("project-a");

    await expect(pending).resolves.toMatchObject({ ok: false, error: "aborted", affectedProjectIds: [] });
    expect(resolutionSignal?.aborted).toBe(true);
    expect(store.getProject("project-a")).toMatchObject({
      monitorKey: null,
      generation: 0,
      lastCompletedObservedAt: null,
      failureCount: 0,
      lastTipOid: null,
      lastState: null,
    });
    await service.stop();
    database.close();
  });

  it("returns and persists only sanitized typed failures", async () => {
    const { database, store } = await createTestStore();
    const secret = "https://user:token@example.test/private.git";
    const observer = {
      resolveTarget: vi.fn(async () => { throw new RemoteUpdateGitError("auth_error"); }),
      observe: vi.fn()
    };
    const service = new RemoteUpdateAwarenessService(store, observer as never);
    const result = await service.observeProject({ projectId: "project-a", cwd: secret, remoteName: "upstream" });
    expect(result).toMatchObject({ ok: false, error: "auth_error", snapshot: { state: "auth_error" } });
    expect(JSON.stringify(result)).not.toContain(secret);
    database.close();
  });
});
