import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpRoute } from "../../shared/http-route.js";
import { createHistoryIndexRoutes } from "../history-index-routes.js";

const activeServers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => Promise.all(activeServers.splice(0).map((server) => server.close())));
function manager(runtimeTarget = "builder") {
  return { getConfig: () => ({ runtimeTarget }), getHistoryIndexStatus: vi.fn(async () => ({ paused: false })),
    setHistoryIndexPaused: vi.fn(async (paused: boolean) => ({ paused })) };
}
function routes(service: ReturnType<typeof manager>) {
  return createHistoryIndexRoutes({ swarmManager: service as unknown as Parameters<typeof createHistoryIndexRoutes>[0]["swarmManager"] });
}

describe("History index routes", () => {
  it("serves status without caching and applies exact boolean updates", async () => {
    const service = manager();
    const server = await createRouteServer(routes(service));
    const response = await fetch(`${server.baseUrl}/api/history/index`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ paused: false });
    for (const paused of [true, false]) {
      const response = await fetch(`${server.baseUrl}/api/history/index`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused }) });
      expect(await response.json()).toEqual({ paused });
      expect(service.setHistoryIndexPaused).toHaveBeenLastCalledWith(paused);
    }
  });
  it("rejects malformed, extra, and nonboolean controls without mutation", async () => {
    const service = manager();
    const server = await createRouteServer(routes(service));
    for (const body of ['null', '{}', '[]', '{', '{"paused":"false"}', '{"paused":true,"rebuild":true}']) {
      expect((await fetch(`${server.baseUrl}/api/history/index`, { method: "PATCH", body })).status).toBe(400);
    }
    expect((await fetch(`${server.baseUrl}/api/history/index`, { method: "POST", body: '{}' })).status).toBe(405);
    expect(service.setHistoryIndexPaused).not.toHaveBeenCalled();
  });
  it("does not expose local history on Collaboration/Remote runtimes", async () => {
    expect(routes(manager("collaboration-server"))).toEqual([]);
  });
  it("sanitizes persistence failures", async () => {
    const service = manager();
    service.setHistoryIndexPaused.mockRejectedValue(new Error("sensitive path or value"));
    const server = await createRouteServer(routes(service));
    const response = await fetch(`${server.baseUrl}/api/history/index`, { method: "PATCH", body: '{"paused":true}' });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sensitive");
  });
});

async function createRouteServer(routes: HttpRoute[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
    if (!route) { response.statusCode = 404; response.end(); return; }
    void route.handle(request, response, requestUrl);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const result = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
  };
  activeServers.push(result);
  return result;
}
