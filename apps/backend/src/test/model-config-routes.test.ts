import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCatalogModelKey } from "@forge/protocol";
import { modelCatalogService } from "../swarm/model-catalog-service.js";
import { readModelOverrides } from "../swarm/model-overrides.js";
import { createModelConfigRoutes } from "../ws/http/routes/model-config-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

interface ModelConfigRouteHarness {
  readonly server: TestServer;
  readonly dataDir: string;
  readonly broadcastEvent: ReturnType<typeof vi.fn>;
  readonly swarmManager: {
    getConfig: () => { paths: { dataDir: string } };
    reloadModelCatalogOverridesAndProjection: ReturnType<typeof vi.fn>;
    notifyModelSpecificInstructionsChanged: ReturnType<typeof vi.fn>;
  };
}

const activeServers: TestServer[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("model config routes", () => {
  it("recycles affected managers when modelSpecificInstructions change", async () => {
    const harness = await createModelConfigRouteHarness();
    const catalogModel = modelCatalogService.getModel("gpt-5.4");
    expect(catalogModel).toBeDefined();

    if (!catalogModel) {
      throw new Error("Expected gpt-5.4 to exist in the model catalog");
    }

    const response = await fetch(`${harness.server.baseUrl}/api/settings/model-overrides/gpt-5.4`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelSpecificInstructions: "Always output compact JSON." }),
    });

    expect(response.status).toBe(200);
    expect(harness.swarmManager.reloadModelCatalogOverridesAndProjection).toHaveBeenCalledTimes(1);
    expect(harness.swarmManager.notifyModelSpecificInstructionsChanged).toHaveBeenCalledWith([
      getCatalogModelKey(catalogModel),
    ]);
    expect(harness.broadcastEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "model_config_changed" }),
    );

    await expect(readModelOverrides(harness.dataDir)).resolves.toMatchObject({
      overrides: {
        [getCatalogModelKey(catalogModel)]: {
          modelSpecificInstructions: "Always output compact JSON.",
        },
      },
    });
  });

  it("accepts managerEnabled patches without triggering prompt-specific recycling", async () => {
    const harness = await createModelConfigRouteHarness();

    const response = await fetch(`${harness.server.baseUrl}/api/settings/model-overrides/claude-opus-4-7`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ managerEnabled: false }),
    });

    expect(response.status).toBe(200);
    expect(harness.swarmManager.reloadModelCatalogOverridesAndProjection).toHaveBeenCalledTimes(1);
    expect(harness.swarmManager.notifyModelSpecificInstructionsChanged).not.toHaveBeenCalled();
    expect(harness.broadcastEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "model_config_changed" }),
    );

    await expect(readModelOverrides(harness.dataDir)).resolves.toMatchObject({
      overrides: {
        "claude-opus-4-7": {
          managerEnabled: false,
        },
      },
    });
  });

  it("does not recycle managers when only non-prompt model override fields change", async () => {
    const harness = await createModelConfigRouteHarness();

    const response = await fetch(`${harness.server.baseUrl}/api/settings/model-overrides/gpt-5.4`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    expect(harness.swarmManager.reloadModelCatalogOverridesAndProjection).toHaveBeenCalledTimes(1);
    expect(harness.swarmManager.notifyModelSpecificInstructionsChanged).not.toHaveBeenCalled();
    expect(harness.broadcastEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "model_config_changed" }),
    );
  });
});

async function createModelConfigRouteHarness(): Promise<ModelConfigRouteHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-model-config-routes-"));
  tempRoots.push(dataDir);
  await modelCatalogService.loadOverrides(dataDir);

  const swarmManager = {
    getConfig: () => ({ paths: { dataDir } }),
    reloadModelCatalogOverridesAndProjection: vi.fn(async () => {
      await modelCatalogService.loadOverrides(dataDir);
    }),
    notifyModelSpecificInstructionsChanged: vi.fn(async () => undefined),
  };
  const broadcastEvent = vi.fn();
  const routes = createModelConfigRoutes({
    swarmManager: swarmManager as never,
    broadcastEvent,
  });
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };

  activeServers.push(testServer);
  return {
    server: testServer,
    dataDir,
    broadcastEvent,
    swarmManager,
  };
}

async function handleRouteRequest(
  routes: ReturnType<typeof createModelConfigRoutes>,
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
