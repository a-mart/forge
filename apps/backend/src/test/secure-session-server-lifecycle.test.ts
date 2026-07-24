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
  it("recovers orphaned execution before readiness and closes secure sessions on stop", async () => {
    const order: string[] = [];
    const tempConfig = await createTempConfig({ runtimeTarget: "builder" });
    tempConfigs.push(tempConfig);

    vi.spyOn(DockerSecureExecutionBackend.prototype, "recoverOrphans")
      .mockImplementation(async (liveTasks) => {
        order.push("recover");
        expect(liveTasks).toEqual([]);
        return { destroyedSandboxIds: ["opaque-orphan-id"] };
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

    await activeServer.stop();
    activeServer = null;
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(order.at(-1)).toBe("close");
  });
});
