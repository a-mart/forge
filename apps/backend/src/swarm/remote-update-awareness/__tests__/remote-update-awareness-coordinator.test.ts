import { describe, expect, it, vi } from "vitest";
import { RemoteUpdateAwarenessCoordinator } from "../remote-update-awareness-coordinator.js";

describe("RemoteUpdateAwarenessCoordinator", () => {
  it("coalesces equivalent work by monitor key but not across monitors", async () => {
    const coordinator = new RemoteUpdateAwarenessCoordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(async () => { await gate; return "observed"; });

    const first = coordinator.run("monitor-a", task);
    const joined = coordinator.run("monitor-a", task);
    const other = coordinator.run("monitor-b", async () => "other");
    expect(task).toHaveBeenCalledTimes(1);
    expect(coordinator.activeMonitorCount).toBe(2);
    release();
    await expect(Promise.all([first, joined, other])).resolves.toEqual(["observed", "observed", "other"]);
    expect(coordinator.activeMonitorCount).toBe(0);
  });

  it("aborts and drains active observations before permanently stopping", async () => {
    const coordinator = new RemoteUpdateAwarenessCoordinator();
    const task = coordinator.run("monitor-a", (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    await coordinator.stop();
    await expect(task).rejects.toThrow("aborted");
    expect(coordinator.activeMonitorCount).toBe(0);
    await expect(coordinator.run("monitor-b", async () => "nope")).rejects.toThrow(/stopping/);
  });
});
