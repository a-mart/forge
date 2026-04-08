import type { IncomingMessage, ServerResponse } from "node:http";
import { getCatalogModelKey, type ModelOverrideEntry, type ServerEvent } from "@forge/protocol";
import { modelCatalogService } from "../../../swarm/model-catalog-service.js";
import {
  readModelOverrides,
  resetAllModelOverrides,
  resetModelOverride,
  setModelOverride,
} from "../../../swarm/model-overrides.js";
import { getManagedModelProviderCredentialAvailability } from "../../../swarm/secrets-env-service.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  decodePathSegment,
  readJsonBody,
  sendJson,
} from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const MODEL_OVERRIDES_ENDPOINT_PATH = "/api/settings/model-overrides";
const METHODS = "GET, PUT, DELETE, OPTIONS";

export function createModelConfigRoutes(options: {
  swarmManager: SwarmManager;
  broadcastEvent: (event: ServerEvent) => void;
}): HttpRoute[] {
  const { swarmManager, broadcastEvent } = options;

  return [
    {
      methods: METHODS,
      matches: (pathname) =>
        pathname === MODEL_OVERRIDES_ENDPOINT_PATH ||
        pathname.startsWith(`${MODEL_OVERRIDES_ENDPOINT_PATH}/`),
      handle: async (request, response, requestUrl) => {
        await handleModelOverridesRequest(swarmManager, broadcastEvent, request, response, requestUrl);
      },
    },
  ];
}

async function handleModelOverridesRequest(
  swarmManager: SwarmManager,
  broadcastEvent: (event: ServerEvent) => void,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, METHODS);

  const dataDir = swarmManager.getConfig().paths.dataDir;
  const relativePath = requestUrl.pathname.slice(MODEL_OVERRIDES_ENDPOINT_PATH.length);
  const rawModelId = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  const modelId = decodePathSegment(rawModelId);

  if (request.method === "GET" && requestUrl.pathname === MODEL_OVERRIDES_ENDPOINT_PATH) {
    try {
      const [overridesFile, providerAvailability] = await Promise.all([
        readModelOverrides(dataDir),
        getManagedModelProviderCredentialAvailability(swarmManager.getConfig()),
      ]);

      sendJson(response, 200, {
        version: overridesFile.version,
        overrides: overridesFile.overrides,
        providerAvailability: Object.fromEntries(providerAvailability),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  if (request.method === "PUT") {
    if (!modelId) {
      sendJson(response, 400, { error: "modelId is required" });
      return;
    }

    const catalogModel = modelCatalogService.getModel(modelId);
    if (!catalogModel) {
      sendJson(response, 404, { error: `Unknown modelId: ${modelId}` });
      return;
    }

    try {
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendJson(response, 400, { error: "Request body must be a JSON object" });
        return;
      }

      const catalogModelKey = getCatalogModelKey(catalogModel);
      const nextOverride = await mergeModelOverridePatch(dataDir, catalogModelKey, body as Record<string, unknown>);
      if (nextOverride) {
        await setModelOverride(dataDir, catalogModelKey, nextOverride);
      } else {
        await resetModelOverride(dataDir, catalogModelKey);
      }

      await swarmManager.reloadModelCatalogOverridesAndProjection();
      broadcastModelConfigChanged(broadcastEvent);

      sendJson(response, 200, {
        ok: true,
        modelId: getCatalogModelKey(catalogModel),
        override: modelCatalogService.getOverride(getCatalogModelKey(catalogModel)) ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: message });
    }
    return;
  }

  if (request.method === "DELETE") {
    try {
      if (requestUrl.pathname === MODEL_OVERRIDES_ENDPOINT_PATH) {
        await resetAllModelOverrides(dataDir);
      } else {
        if (!modelId) {
          sendJson(response, 400, { error: "modelId is required" });
          return;
        }

        const catalogModel = modelCatalogService.getModel(modelId);
        if (!catalogModel) {
          sendJson(response, 404, { error: `Unknown modelId: ${modelId}` });
          return;
        }

        await resetModelOverride(dataDir, getCatalogModelKey(catalogModel));
      }

      await swarmManager.reloadModelCatalogOverridesAndProjection();
      broadcastModelConfigChanged(broadcastEvent);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  response.setHeader("Allow", METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function mergeModelOverridePatch(
  dataDir: string,
  modelId: string,
  patch: Record<string, unknown>,
): Promise<ModelOverrideEntry | null> {
  const hasEnabled = Object.prototype.hasOwnProperty.call(patch, "enabled");
  const hasContextWindowCap = Object.prototype.hasOwnProperty.call(patch, "contextWindowCap");
  const hasModelSpecificInstructions = Object.prototype.hasOwnProperty.call(patch, "modelSpecificInstructions");

  if (!hasEnabled && !hasContextWindowCap && !hasModelSpecificInstructions) {
    throw new Error("At least one override field is required");
  }

  const file = await readModelOverrides(dataDir);
  const current = file.overrides[modelId] ?? {};
  const next: ModelOverrideEntry = { ...current };

  if (hasEnabled) {
    const enabled = patch.enabled;
    if (enabled === null) {
      delete next.enabled;
    } else if (typeof enabled === "boolean") {
      next.enabled = enabled;
    } else {
      throw new Error("enabled must be a boolean or null");
    }
  }

  if (hasContextWindowCap) {
    const contextWindowCap = patch.contextWindowCap;
    if (contextWindowCap === null) {
      delete next.contextWindowCap;
    } else if (
      typeof contextWindowCap === "number" &&
      Number.isFinite(contextWindowCap) &&
      Number.isInteger(contextWindowCap) &&
      contextWindowCap > 0
    ) {
      next.contextWindowCap = contextWindowCap;
    } else {
      throw new Error("contextWindowCap must be a positive integer or null");
    }
  }

  if (hasModelSpecificInstructions) {
    const modelSpecificInstructions = patch.modelSpecificInstructions;
    if (modelSpecificInstructions === null) {
      delete next.modelSpecificInstructions;
    } else if (typeof modelSpecificInstructions === "string") {
      next.modelSpecificInstructions = modelSpecificInstructions;
    } else {
      throw new Error("modelSpecificInstructions must be a string or null");
    }
  }

  return Object.keys(next).length > 0 ? next : null;
}

function broadcastModelConfigChanged(broadcastEvent: (event: ServerEvent) => void): void {
  broadcastEvent({
    type: "model_config_changed",
    updatedAt: new Date().toISOString(),
  });
}
