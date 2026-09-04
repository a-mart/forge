import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ManagerSelectionCatalogResponse } from "@forge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SwarmManager } from "../../../../swarm/swarm-manager.js";
import {
  createManagerSelectionCatalogRoutes,
  MANAGER_SELECTION_CATALOG_ENDPOINT_PATH,
} from "../manager-selection-catalog-routes.js";
import type { HttpRoute } from "../../shared/http-route.js";

const CATALOG: ManagerSelectionCatalogResponse = {
  version: 1,
  revision: "msc-v1-route-test",
  models: [{
    provider: "anthropic",
    providerLabel: "Anthropic",
    modelId: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    familyId: "pi-fable",
    familyLabel: "Claude Fable 5.1",
    reasoningOptions: [{ id: "high", label: "High" }],
    defaultReasoningId: "high",
    surfaces: {
      create: { selectable: false, unavailableReason: "provider_not_configured" },
      change: { selectable: false, unavailableReason: "provider_not_configured" },
    },
  }],
  workModes: [{
    id: "adaptive",
    label: "Adaptive",
    description: "Chooses ownership outcome by outcome.",
    selectable: true,
  }],
  defaults: { workModeId: "delegation_first" },
};

describe("manager selection catalog HTTP route", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it("returns the versioned member-safe projection with CORS and ETag headers", async () => {
    const getManagerSelectionCatalog = vi.fn(async () => CATALOG);
    const server = await startRouteServer(getManagerSelectionCatalog);
    closeCallbacks.push(server.close);

    const response = await fetch(`${server.baseUrl}${MANAGER_SELECTION_CATALOG_ENDPOINT_PATH}`, {
      headers: { Origin: "https://mobile.example.test" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"msc-v1-route-test"');
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://mobile.example.test");
    expect(response.headers.get("access-control-expose-headers")).toBe("ETag");
    expect(await response.json()).toEqual(CATALOG);
    expect(getManagerSelectionCatalog).toHaveBeenCalledTimes(1);
  });

  it("returns 304 for strong, weak, or list-matched If-None-Match without a response body", async () => {
    const getManagerSelectionCatalog = vi.fn(async () => CATALOG);
    const server = await startRouteServer(getManagerSelectionCatalog);
    closeCallbacks.push(server.close);

    for (const ifNoneMatch of [
      '"msc-v1-route-test"',
      'W/"msc-v1-route-test"',
      '"older", "msc-v1-route-test"',
    ]) {
      const response = await fetch(`${server.baseUrl}${MANAGER_SELECTION_CATALOG_ENDPOINT_PATH}`, {
        headers: { "If-None-Match": ifNoneMatch },
      });
      expect(response.status).toBe(304);
      expect(response.headers.get("etag")).toBe('"msc-v1-route-test"');
      expect(await response.text()).toBe("");
    }
  });

  it("supports bounded CORS preflight and rejects non-GET methods", async () => {
    const getManagerSelectionCatalog = vi.fn(async () => CATALOG);
    const server = await startRouteServer(getManagerSelectionCatalog);
    closeCallbacks.push(server.close);

    const preflight = await fetch(`${server.baseUrl}${MANAGER_SELECTION_CATALOG_ENDPOINT_PATH}`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://mobile.example.test",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "if-none-match",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("if-none-match");

    const methodNotAllowed = await fetch(`${server.baseUrl}${MANAGER_SELECTION_CATALOG_ENDPOINT_PATH}`, {
      method: "POST",
    });
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("allow")).toBe("GET, OPTIONS");
    expect(getManagerSelectionCatalog).not.toHaveBeenCalled();
  });

  it("does not reflect sensitive backend errors from the member-readable route", async () => {
    const getManagerSelectionCatalog = vi.fn(async () => {
      throw new Error("OPENROUTER_API_KEY=secret at /Users/private/pi-models.json");
    });
    const server = await startRouteServer(getManagerSelectionCatalog);
    closeCallbacks.push(server.close);

    const response = await fetch(`${server.baseUrl}${MANAGER_SELECTION_CATALOG_ENDPOINT_PATH}`);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe('{"error":"Unable to load manager selection catalog"}');
    expect(body).not.toContain("secret");
    expect(body).not.toContain("pi-models");
  });
});

async function startRouteServer(
  getManagerSelectionCatalog: () => Promise<ManagerSelectionCatalogResponse>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const swarmManager = { getManagerSelectionCatalog } as unknown as SwarmManager;
  const routes = createManagerSelectionCatalogRoutes({ swarmManager });
  const server = createServer((request, response) => {
    void handleRoute(routes, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function handleRoute(
  routes: HttpRoute[],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
  if (!route) {
    response.statusCode = 404;
    response.end();
    return;
  }
  await route.handle(request, response, requestUrl);
}
