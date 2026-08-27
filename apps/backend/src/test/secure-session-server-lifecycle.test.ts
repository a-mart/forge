import { once } from "node:events";
import { access } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, type StartedServer } from "../server.js";
import { DockerSecureExecutionBackend } from "../swarm/secure-sessions/execution/docker-secure-execution-backend.js";
import { SecureSessionsService } from "../swarm/secure-sessions/secure-sessions-service.js";
import { SwarmManager } from "../swarm/swarm-manager.js";
import { createTempConfig, type TempConfigHandle } from "../test-support/temp-config.js";
import { EmbeddedGitVersioningService } from "../versioning/embedded-git-versioning-service.js";
import { SwarmWebSocketServer } from "../ws/server.js";

const tempConfigs: TempConfigHandle[] = [];
let activeServer: StartedServer | null = null;

function lifecycleListenerCounts(): Record<"exit" | "SIGINT" | "SIGTERM", number> {
  return {
    exit: process.listenerCount("exit"),
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };
}

afterEach(async () => {
  if (activeServer) {
    await activeServer.stop();
    activeServer = null;
  }
  while (tempConfigs.length > 0) {
    await tempConfigs.pop()?.cleanup();
  }
  vi.restoreAllMocks();
});

describe("Secure Sessions server lifecycle", () => {
  it("recovers orphaned execution without delaying readiness and closes secure sessions on stop", async () => {
    const order: string[] = [];
    const tempConfig = await createTempConfig({ runtimeTarget: "builder" });
    tempConfigs.push(tempConfig);
    let finishRecovery: ((value: { destroyedSandboxIds: string[] }) => void) | undefined;
    const recoveryGate = new Promise<{ destroyedSandboxIds: string[] }>((resolve) => {
      finishRecovery = resolve;
    });

    vi.spyOn(DockerSecureExecutionBackend.prototype, "recoverOrphans")
      .mockImplementation(async (liveTasks) => {
        order.push("recover");
        expect(liveTasks).toEqual([]);
        const result = await recoveryGate;
        order.push("recover-finished");
        return result;
      });
    const originalClose = SecureSessionsService.prototype.closeSecureSessions;
    const closeSpy = vi.spyOn(SecureSessionsService.prototype, "closeSecureSessions")
      .mockImplementation(async function closeSecureSessionsForTest() {
        order.push("close");
        return await originalClose.call(this);
      });

    activeServer = await startServer({
      config: tempConfig.config,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      onReady: () => {
        order.push("ready");
      },
    });

    expect(order.indexOf("recover")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("recover")).toBeLessThan(order.indexOf("ready"));
    expect(order).not.toContain("recover-finished");

    finishRecovery?.({ destroyedSandboxIds: ["opaque-orphan-id"] });
    await vi.waitFor(() => {
      expect(order).toContain("recover-finished");
    });

    await activeServer.stop();
    activeServer = null;
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(order.at(-1)).toBe("close");
  });

  it("holds the runtime lock through graceful shutdown and restores process listeners", async () => {
    const baselineListeners = lifecycleListenerCounts();
    const tempConfig = await createTempConfig({ runtimeTarget: "builder" });
    tempConfigs.push(tempConfig);
    const lockFile = join(tempConfig.config.paths.dataDir, "runtime.lock");

    let closeStarted!: () => void;
    const closeStartedPromise = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    let allowClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      allowClose = resolve;
    });
    const originalClose = SecureSessionsService.prototype.closeSecureSessions;
    vi.spyOn(SecureSessionsService.prototype, "closeSecureSessions")
      .mockImplementation(async function closeSecureSessionsForLockTest() {
        closeStarted();
        await closeGate;
        return await originalClose.call(this);
      });

    activeServer = await startServer({
      config: tempConfig.config,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await expect(access(lockFile)).resolves.toBeUndefined();
    expect(lifecycleListenerCounts()).toEqual({
      ...baselineListeners,
      exit: baselineListeners.exit + 1,
    });

    const stopping = activeServer.stop();
    await closeStartedPromise;
    await expect(access(lockFile)).resolves.toBeUndefined();
    expect(lifecycleListenerCounts()).toEqual({
      ...baselineListeners,
      exit: baselineListeners.exit + 1,
    });

    allowClose();
    await stopping;
    activeServer = null;

    await expect(access(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(lifecycleListenerCounts()).toEqual(baselineListeners);
  });

  it("stops WebSocket ingress before draining persistence and releases the runtime lock", async () => {
    const tempConfig = await createTempConfig({ runtimeTarget: "builder" });
    tempConfigs.push(tempConfig);
    const lockFile = join(tempConfig.config.paths.dataDir, "runtime.lock");

    activeServer = await startServer({
      config: tempConfig.config,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const client = new WebSocket(`ws://${activeServer.host}:${activeServer.port}`);
    const shutdownOrder: string[] = [];
    const originalTerminate = WebSocket.prototype.terminate;
    vi.spyOn(WebSocket.prototype, "terminate").mockImplementation(function terminateForOrderTest(this: WebSocket) {
      shutdownOrder.push("terminate-client");
      return originalTerminate.call(this);
    });
    let allowPersistenceDrain!: () => void;
    const persistenceDrainGate = new Promise<void>((resolve) => {
      allowPersistenceDrain = resolve;
    });
    let persistenceDrainStarted!: () => void;
    const persistenceDrainStartedPromise = new Promise<void>((resolve) => {
      persistenceDrainStarted = resolve;
    });
    const originalFlushPendingPersistence = SwarmManager.prototype.flushPendingPersistence;
    vi.spyOn(SwarmManager.prototype, "flushPendingPersistence")
      .mockImplementation(async function flushPendingPersistenceForOrderTest(this: SwarmManager) {
        shutdownOrder.push("drain-persistence");
        persistenceDrainStarted();
        await persistenceDrainGate;
        return originalFlushPendingPersistence.call(this);
      });
    let stopping: Promise<void> | null = null;
    try {
      await once(client, "open");
      const clientClosed = once(client, "close");
      stopping = activeServer.stop();
      await persistenceDrainStartedPromise;
      expect(shutdownOrder.slice(0, 2)).toEqual(["terminate-client", "drain-persistence"]);
      allowPersistenceDrain();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), 2_000);
          timeout.unref();
        }),
      ]);
      clearTimeout(timeout);

      expect(outcome).toBe("stopped");
      await stopping;
      activeServer = null;
      await clientClosed;

      await expect(access(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      allowPersistenceDrain();
      if (client.readyState !== WebSocket.CLOSED) {
        client.terminate();
      }
      await stopping?.catch(() => undefined);
    }
  }, 10_000);

  it("releases the runtime lock and exit hook after startup fails", async () => {
    const baselineListeners = lifecycleListenerCounts();
    const tempConfig = await createTempConfig({ runtimeTarget: "builder" });
    tempConfigs.push(tempConfig);
    const lockFile = join(tempConfig.config.paths.dataDir, "runtime.lock");
    vi.spyOn(EmbeddedGitVersioningService.prototype, "start")
      .mockRejectedValueOnce(new Error("versioning startup failed"));

    await expect(startServer({
      config: tempConfig.config,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    })).rejects.toThrow("versioning startup failed");

    await expect(access(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(lifecycleListenerCounts()).toEqual(baselineListeners);
  });

  it("finishes mandatory cleanup when the WebSocket stop reports a failure", async () => {
    const baselineListeners = lifecycleListenerCounts();
    const tempConfig = await createTempConfig({ runtimeTarget: "builder" });
    tempConfigs.push(tempConfig);
    const lockFile = join(tempConfig.config.paths.dataDir, "runtime.lock");
    const originalStop = SwarmWebSocketServer.prototype.stop;
    vi.spyOn(SwarmWebSocketServer.prototype, "stop")
      .mockImplementationOnce(async function stopThenFailForTest() {
        await originalStop.call(this);
        throw new Error("WebSocket stop failed");
      });

    activeServer = await startServer({
      config: tempConfig.config,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await expect(activeServer.stop()).rejects.toThrow("WebSocket stop failed");
    activeServer = null;

    await expect(access(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(lifecycleListenerCounts()).toEqual(baselineListeners);

    activeServer = await startServer({
      config: tempConfig.config,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    await expect(access(lockFile)).resolves.toBeUndefined();

    await activeServer.stop();
    activeServer = null;
    expect(lifecycleListenerCounts()).toEqual(baselineListeners);
  });
});
