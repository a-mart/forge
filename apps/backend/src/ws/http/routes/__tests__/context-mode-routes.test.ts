import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectContextModeSnapshot, SessionContextModeSnapshot } from "@forge/protocol";
import { sendJson } from "../../../http-utils.js";
import { createContextModeRoutes } from "../context-mode-routes.js";
import type { HttpRoute } from "../../shared/http-route.js";
import type { SwarmManager } from "../../../../swarm/swarm-manager.js";

const activeServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("createContextModeRoutes", () => {
  it("returns summary by default and round-trips project GET/PUT", async () => {
    const profile = { profileId: "forge", defaultContextMode: undefined as "summary" | "fresh" | undefined };
    const swarmManager = {
      getProjectContextMode: vi.fn((profileId: string) => ({
        profileId,
        mode: profile.defaultContextMode ?? "summary",
      })),
      updateProjectContextMode: vi.fn(async (_profileId: string, mode: "summary" | "fresh") => {
        profile.defaultContextMode = mode;
      }),
    } as unknown as SwarmManager;
    const server = await createRouteServer(
      createContextModeRoutes({ swarmManager, runtimeTarget: "builder" }),
    );

    const initial = await fetch(`${server.baseUrl}/api/profiles/forge/context-mode`);
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toEqual({ profileId: "forge", mode: "summary" } satisfies ProjectContextModeSnapshot);

    const updated = await fetch(`${server.baseUrl}/api/profiles/forge/context-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "fresh" }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toEqual({ profileId: "forge", mode: "fresh" });
    expect(swarmManager.updateProjectContextMode).toHaveBeenCalledWith("forge", "fresh");
  });

  it("round-trips session override, inherit restore, and rejects invalid writes", async () => {
    const snapshot: SessionContextModeSnapshot = {
      sessionAgentId: "manager",
      profileId: "forge",
      projectDefault: "fresh",
      effectiveMode: "fresh",
      freshSupported: true,
    };
    const swarmManager = {
      getSessionContextMode: vi.fn(() => ({ ...snapshot })),
      updateSessionContextMode: vi.fn(async (_agentId: string, mode: "summary" | "fresh" | null) => {
        if (mode === null) {
          delete snapshot.sessionOverride;
          snapshot.effectiveMode = snapshot.projectDefault;
        } else {
          snapshot.sessionOverride = mode;
          snapshot.effectiveMode = mode;
        }
      }),
    } as unknown as SwarmManager;
    const server = await createRouteServer(
      createContextModeRoutes({ swarmManager, runtimeTarget: "builder" }),
    );

    const summary = await fetch(`${server.baseUrl}/api/agents/manager/context-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "summary" }),
    });
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toMatchObject({
      sessionOverride: "summary",
      effectiveMode: "summary",
    });

    const inherit = await fetch(`${server.baseUrl}/api/agents/manager/context-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: null }),
    });
    expect(inherit.status).toBe(200);
    await expect(inherit.json()).resolves.toEqual({
      sessionAgentId: "manager",
      profileId: "forge",
      projectDefault: "fresh",
      effectiveMode: "fresh",
      freshSupported: true,
    });

    const invalid = await fetch(`${server.baseUrl}/api/agents/manager/context-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "window" }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: 'mode must be "summary" or "fresh"',
    });
  });

  it("reports unsupported-runtime fresh activation clearly", async () => {
    const swarmManager = {
      getSessionContextMode: vi.fn(),
      updateSessionContextMode: vi.fn(async () => {
        throw new Error("Fresh windows are not supported for Cursor SDK runtimes.");
      }),
    } as unknown as SwarmManager;
    const server = await createRouteServer(
      createContextModeRoutes({ swarmManager, runtimeTarget: "builder" }),
    );

    const response = await fetch(`${server.baseUrl}/api/agents/cursor/context-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "fresh" }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Fresh windows are not supported for Cursor SDK runtimes.",
    });
  });

  it("rejects session PUT targeting a worker", async () => {
    const swarmManager = {
      getSessionContextMode: vi.fn(),
      updateSessionContextMode: vi.fn(async () => {
        throw new Error("Context mode can only be updated on manager sessions.");
      }),
    } as unknown as SwarmManager;
    const server = await createRouteServer(
      createContextModeRoutes({ swarmManager, runtimeTarget: "builder" }),
    );

    const response = await fetch(`${server.baseUrl}/api/agents/worker-1/context-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "fresh" }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Context mode can only be updated on manager sessions.",
    });
    expect(swarmManager.updateSessionContextMode).toHaveBeenCalledWith("worker-1", "fresh");
  });

  it("returns 404 for collaboration runtime", async () => {
    const server = await createRouteServer(
      createContextModeRoutes({
        swarmManager: {} as SwarmManager,
        runtimeTarget: "collaboration-server",
      }),
    );

    const response = await fetch(`${server.baseUrl}/api/profiles/forge/context-mode`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "Context mode settings are only available in Builder runtime.",
    });
  });
});

async function createRouteServer(routes: HttpRoute[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const httpServer = createServer((request, response) => {
    void handleRoute(routes, request, response);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const server = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  activeServers.push(server);
  return server;
}

async function handleRoute(routes: HttpRoute[], request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
  if (!route) {
    response.statusCode = 404;
    response.end();
    return;
  }

  try {
    await route.handle(request, response, requestUrl);
  } catch (error) {
    if (response.writableEnded || response.headersSent) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { error: message });
  }
}
