import { describe, expect, it, vi } from "vitest";
import { getAvailablePort } from "../../test-support/index.js";
import {
  WsServerTestSwarmManager,
  bootWsServerTestManager,
  makeWsServerTempConfig,
} from "../../test-support/ws-integration-harness.js";
import type { LocalRemoteUpdateAwarenessService } from "../http/services/remote-update-awareness-service.js";
import { SwarmWebSocketServer } from "../server.js";

function fakeAwarenessService() {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const service = {
    start,
    stop,
    reconcileProjects: vi.fn(),
    getProjectSnapshot: vi.fn(() => ({
      projectId: "manager", override: "inherit", globalEnabled: false, effectiveEnabled: false,
      state: "disabled", lastObservedAt: null, failureCode: null, attentionRequired: false,
      dismissalTarget: null,
    })),
  } as unknown as LocalRemoteUpdateAwarenessService;
  return { service, start, stop };
}

describe("remote update awareness server lifecycle", () => {
  it("registers local routes and starts/stops observations with the Builder server", async () => {
    const port = await getAvailablePort();
    const config = await makeWsServerTempConfig(port);
    const manager = new WsServerTestSwarmManager(config);
    await bootWsServerTestManager(manager, config);
    const awareness = fakeAwarenessService();
    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      remoteUpdateAwarenessService: awareness.service,
    });

    expect(server.listRegisteredHttpRoutes().some((route) =>
      route.matches("/api/git/remote-update-awareness/settings")
    )).toBe(true);
    await server.start();
    expect(awareness.start).toHaveBeenCalledTimes(1);
    await server.stop();
    expect(awareness.stop).toHaveBeenCalledTimes(1);
  });
});
