import type {
  BuilderSidebarOrderConflictResponse,
  BuilderSidebarOrderState,
  BuilderSidebarOrderUpdatedEvent,
} from "@forge/protocol";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuilderSidebarOrderService,
  MAX_BUILDER_SIDEBAR_ORDER_REQUEST_BYTES,
} from "../../../../swarm/builder-sidebar-order-service.js";
import { getBuilderSidebarOrderPath } from "../../../../swarm/storage/data-paths.js";
import { sendJson } from "../../../http-utils.js";
import type { HttpRoute } from "../../shared/http-route.js";
import { createBuilderSidebarOrderRoutes } from "../builder-sidebar-order-routes.js";

const activeServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("createBuilderSidebarOrderRoutes", () => {
  it("serves the missing-file default and persists PUTs with a live event", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-sidebar-order-routes-"));
    const service = new BuilderSidebarOrderService({
      dataDir,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });
    await service.load();
    const events: BuilderSidebarOrderUpdatedEvent[] = [];
    const server = await createRouteServer(createBuilderSidebarOrderRoutes({
      service,
      runtimeTarget: "builder",
      broadcastEvent: (event) => events.push(event),
    }));

    const getResponse = await fetch(`${server.baseUrl}/api/settings/builder-sidebar-order`);
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({ version: 1, revision: 0, order: [], updatedAt: null });

    const putResponse = await fetch(`${server.baseUrl}/api/settings/builder-sidebar-order`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 0,
        order: [
          { originId: "remote-1", profileId: "same" },
          { originId: "local", profileId: "same" },
        ],
      }),
    });
    const state = (await putResponse.json()) as BuilderSidebarOrderState;

    expect(putResponse.status).toBe(200);
    expect(state.revision).toBe(1);
    expect(events).toEqual([{ type: "builder_sidebar_order_updated", revision: state.revision }]);
    expect(JSON.stringify(events)).not.toContain('"state"');
    expect(JSON.stringify(events)).not.toContain('"order"');
  });

  it("returns 409 with the current revision and never broadcasts the rejected write", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-sidebar-order-conflict-"));
    const service = new BuilderSidebarOrderService({ dataDir });
    await service.load();
    await service.update({ baseRevision: 0, order: [{ originId: "local", profileId: "alpha" }] });
    const broadcastEvent = vi.fn();
    const server = await createRouteServer(createBuilderSidebarOrderRoutes({
      service,
      runtimeTarget: "builder",
      broadcastEvent,
    }));

    const response = await fetch(`${server.baseUrl}/api/settings/builder-sidebar-order`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 0,
        order: [{ originId: "remote", profileId: "beta" }],
      }),
    });
    const body = (await response.json()) as BuilderSidebarOrderConflictResponse;

    expect(response.status).toBe(409);
    expect(body.current.revision).toBe(1);
    expect(body.current.order).toEqual([{ originId: "local", profileId: "alpha" }]);
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid bodies", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-sidebar-order-invalid-"));
    const service = new BuilderSidebarOrderService({ dataDir });
    await service.load();
    const server = await createRouteServer(createBuilderSidebarOrderRoutes({ service, runtimeTarget: "builder" }));

    const duplicate = await fetch(`${server.baseUrl}/api/settings/builder-sidebar-order`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 0,
        order: [
          { originId: "local", profileId: "alpha" },
          { originId: "local", profileId: "alpha" },
        ],
      }),
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: expect.stringContaining("duplicate") });

    const malformed = await fetch(`${server.baseUrl}/api/settings/builder-sidebar-order`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{bad-json",
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${server.baseUrl}/api/settings/builder-sidebar-order`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(MAX_BUILDER_SIDEBAR_ORDER_REQUEST_BYTES) }),
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toEqual({ error: expect.stringContaining("too large") });
  });

  it("fails closed without exposing or persisting the setting in collaboration runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-sidebar-order-collab-"));
    const service = new BuilderSidebarOrderService({ dataDir });
    await service.load();
    const server = await createRouteServer(createBuilderSidebarOrderRoutes({
      service,
      runtimeTarget: "collaboration-server",
    }));

    for (const method of ["GET", "PUT", "OPTIONS"]) {
      const response = await fetch(`${server.baseUrl}/api/settings/builder-sidebar-order`, {
        method,
        ...(method === "PUT"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ baseRevision: 0, order: [] }),
            }
          : {}),
      });
      expect(response.status, method).toBe(404);
    }
    await expect(access(getBuilderSidebarOrderPath(dataDir))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createRouteServer(routes: HttpRoute[]): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const route = routes.find((candidate) => candidate.matches(pathname));
    if (!route) {
      sendJson(response, 404, { error: "Not Found" });
      return;
    }
    void route.handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  };
  const result = { baseUrl: `http://127.0.0.1:${address.port}`, close };
  activeServers.push(result);
  return result;
}
