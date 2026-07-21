import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpRoute } from "../../shared/http-route.js";
import type { LocalRemoteUpdateAwarenessService } from "../../services/remote-update-awareness-service.js";
import { createRemoteUpdateAwarenessRoutes } from "../remote-update-awareness-routes.js";

const activeServers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => Promise.all(activeServers.splice(0).map((server) => server.close())));

const snapshot = {
  projectId: "project", override: "inherit", globalEnabled: false, effectiveEnabled: false,
  state: "disabled", lastObservedAt: null, failureCode: null, attentionRequired: false,
  dismissalTarget: null,
} as const;

function fakeService(): LocalRemoteUpdateAwarenessService {
  return {
    getSettingsSnapshot: vi.fn(() => ({
      settings: { globalEnabled: false, updatedAt: null },
      projects: [{ projectId: "project", override: "inherit", effectiveEnabled: false }],
    })),
    setGlobalEnabled: vi.fn(() => ({
      settings: { globalEnabled: true, updatedAt: "2026-07-20T00:00:00.000Z" },
      projects: [{ projectId: "project", override: "inherit", effectiveEnabled: true }],
    })),
    getProjectSnapshot: vi.fn(() => snapshot),
    setProjectOverride: vi.fn(() => ({ ...snapshot, override: "on" as const })),
    activateProject: vi.fn(() => snapshot),
    refreshProject: vi.fn(async () => snapshot),
    dismissProject: vi.fn(() => ({ ...snapshot, attentionRequired: false })),
    getIncoming: vi.fn(async () => ({
      projectId: "project", remoteDisplayName: "upstream", defaultBranchDisplay: "trunk",
      observedTipOid: "a".repeat(40), generation: 3,
      observedAt: "2026-07-20T00:00:00.000Z", freshnessCheckedAt: "2026-07-20T00:00:00.000Z",
      staleAfter: "2026-07-20T00:15:00.000Z", state: "update_available" as const,
      failureCode: null, attentionRequired: true,
      commits: { commitCount: 1, commitLimit: 20, hasMore: false, commits: [{ subject: "Safe subject", committedAt: null }] },
      fileChanges: { changedFileCount: 2, changedFileCountLimit: 500, hasMore: false, addedCount: 1, modifiedCount: 1, deletedCount: 0, renamedCount: 0 },
    })),
  } as unknown as LocalRemoteUpdateAwarenessService;
}

describe("remote update awareness local routes", () => {
  it("serves settings/state and validates global and tri-state mutations", async () => {
    const service = fakeService();
    const server = await createRouteServer(createRemoteUpdateAwarenessRoutes({ service }));

    expect(await (await fetch(`${server.baseUrl}/api/git/remote-update-awareness/settings`)).json()).toMatchObject({
      settings: { globalEnabled: false },
    });
    const global = await fetch(`${server.baseUrl}/api/git/remote-update-awareness/settings`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ globalEnabled: true }),
    });
    expect(global.status).toBe(200);
    expect(service.setGlobalEnabled).toHaveBeenCalledWith(true);

    const override = await fetch(`${server.baseUrl}/api/git/remote-update-awareness/project`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project", override: "on" }),
    });
    expect(override.status).toBe(200);
    expect(service.setProjectOverride).toHaveBeenCalledWith("project", "on");

    const invalid = await fetch(`${server.baseUrl}/api/git/remote-update-awareness/project`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project", override: "always" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("supports activate, refresh, exact-generation dismissal, and bounded Incoming inspection", async () => {
    const service = fakeService();
    const server = await createRouteServer(createRemoteUpdateAwarenessRoutes({ service }));
    for (const action of ["activate", "refresh"]) {
      const response = await fetch(`${server.baseUrl}/api/git/remote-update-awareness/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "project" }),
      });
      expect(response.status, action).toBe(200);
    }
    const dismiss = await fetch(`${server.baseUrl}/api/git/remote-update-awareness/dismiss`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project", dismissalTarget: { generation: 3 } }),
    });
    expect(dismiss.status).toBe(200);
    expect(service.dismissProject).toHaveBeenCalledWith("project", 3);

    const incoming = await fetch(`${server.baseUrl}/api/git/remote-update-awareness/incoming?projectId=project`);
    expect(incoming.status).toBe(200);
    expect(await incoming.json()).toMatchObject({
      incoming: {
        projectId: "project", remoteDisplayName: "upstream", defaultBranchDisplay: "trunk",
        attentionRequired: true, commits: { commitCount: 1, commitLimit: 20 },
        fileChanges: { changedFileCount: 2, changedFileCountLimit: 500 },
      },
    });
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
