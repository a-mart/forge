import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, type StartedServer } from "../server.js";
import { DockerSecureExecutionBackend } from "../swarm/secure-sessions/execution/docker-secure-execution-backend.js";
import { SecureSessionsService } from "../swarm/secure-sessions/secure-sessions-service.js";
import { createTempConfig, type TempConfigHandle } from "../test-support/temp-config.js";

const tempConfigs: TempConfigHandle[] = [];
let activeServer: StartedServer | null = null;

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
});
