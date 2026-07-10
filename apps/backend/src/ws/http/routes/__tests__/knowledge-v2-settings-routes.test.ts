import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeV2SettingsService } from "../../../../swarm/knowledge-v2-settings-service.js";
import { sendJson } from "../../../http-utils.js";
import type { HttpRoute } from "../../shared/http-route.js";
import { createKnowledgeV2SettingsRoutes } from "../knowledge-v2-settings-routes.js";

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe("knowledge v2 settings routes", () => {
  it("reports migration capability and returns a structured conflict for unsafe activation", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "knowledge-v2-route-"));
    const service = new KnowledgeV2SettingsService({ dataDir });
    await service.load();
    const server = await createRouteServer(createKnowledgeV2SettingsRoutes({
      settingsService: service,
      dataDir,
      runtimeTarget: "builder",
    }));

    const getResponse = await fetch(`${server.baseUrl}/api/settings/knowledge-v2`);
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toMatchObject({
      settings: { enabled: false },
      activation: { canEnable: false, reason: "migration_required" },
    });

    const putResponse = await fetch(`${server.baseUrl}/api/settings/knowledge-v2`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(putResponse.status).toBe(409);
    expect(await putResponse.json()).toEqual({
      error: "Knowledge v2 cannot be enabled until the guarded migration has completed successfully.",
      code: "KNOWLEDGE_V2_MIGRATION_REQUIRED",
    });
  });
});

async function createRouteServer(routes: HttpRoute[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const httpServer = createServer((request, response) => void handleRoute(routes, request, response));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Could not resolve test server address");
  const server = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
  };
  servers.push(server);
  return server;
}

async function handleRoute(routes: HttpRoute[], request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = routes.find((candidate) => candidate.matches(url.pathname));
  if (!route) return void sendJson(response, 404, { error: "Not Found" });
  try {
    await route.handle(request, response, url);
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}
