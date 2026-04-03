import type { IncomingMessage, ServerResponse } from "node:http";
import { getModels } from "@mariozechner/pi-ai";
import type { AvailableOpenRouterModel, ForgeReasoningLevel, OpenRouterModelEntry, OpenRouterModelsFile, ServerEvent } from "@forge/protocol";
import {
  getOpenRouterModels,
  addOpenRouterModel,
  readOpenRouterModels,
  removeOpenRouterModel,
  writeOpenRouterModels,
} from "../../swarm/openrouter-models.js";
import { getManagedModelProviderCredentialAvailability } from "../../swarm/secrets-env-service.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, decodePathSegment, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const AVAILABLE_MODELS_ENDPOINT_PATH = "/api/settings/openrouter/available-models";
const MODELS_ENDPOINT_PATH = "/api/settings/openrouter/models";
const AVAILABLE_MODELS_METHODS = "GET, OPTIONS";
const MODELS_METHODS = "GET, PUT, DELETE, OPTIONS";
const DEFAULT_REASONING_LEVELS: readonly ForgeReasoningLevel[] = ["none", "low", "medium", "high"];
const TOOL_CAPABLE_UPSTREAM_PROVIDERS = new Set([
  "anthropic",
  "deepseek",
  "google",
  "meta-llama",
  "mistralai",
  "moonshotai",
  "openai",
  "qwen",
  "x-ai",
  "xai",
]);
const NON_TOOL_MODEL_PATTERNS = [
  "audio",
  "embed",
  "embedding",
  "guard",
  "image",
  "moderation",
  "rerank",
  "speech",
  "transcribe",
  "tts",
  "vision",
  "whisper",
];

const OPENROUTER_CATALOG_MODELS = getModels("openrouter");
const OPENROUTER_CATALOG_MODEL_BY_ID = new Map(OPENROUTER_CATALOG_MODELS.map((model) => [model.id, model]));
const AVAILABLE_OPENROUTER_MODELS = OPENROUTER_CATALOG_MODELS.map((model) => {
  const upstreamProvider = extractUpstreamProvider(model.id);
  return {
    modelId: model.id,
    displayName: model.name,
    upstreamProvider,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsReasoning: model.reasoning,
    supportsTools: inferSupportsTools(model.id, model.name, upstreamProvider),
    inputModes: [...model.input],
    pricing: model.cost
      ? {
          inputPerMillion: normalizePerMillionCost(model.cost.input),
          outputPerMillion: normalizePerMillionCost(model.cost.output),
        }
      : null,
  } satisfies AvailableOpenRouterModel;
}).sort((left, right) => {
  const providerComparison = left.upstreamProvider.localeCompare(right.upstreamProvider);
  if (providerComparison !== 0) {
    return providerComparison;
  }

  return left.displayName.localeCompare(right.displayName);
});

export function createOpenRouterRoutes(options: {
  swarmManager: SwarmManager;
  broadcastEvent: (event: ServerEvent) => void;
}): HttpRoute[] {
  const { swarmManager, broadcastEvent } = options;

  return [
    {
      methods: AVAILABLE_MODELS_METHODS,
      matches: (pathname) => pathname === AVAILABLE_MODELS_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        await handleAvailableModelsRequest(request, response, requestUrl);
      },
    },
    {
      methods: MODELS_METHODS,
      matches: (pathname) => pathname === MODELS_ENDPOINT_PATH || pathname.startsWith(`${MODELS_ENDPOINT_PATH}/`),
      handle: async (request, response, requestUrl) => {
        await handleOpenRouterModelsRequest(swarmManager, broadcastEvent, request, response, requestUrl);
      },
    },
  ];
}

async function handleAvailableModelsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, AVAILABLE_MODELS_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, AVAILABLE_MODELS_METHODS);

  if (request.method === "GET" && requestUrl.pathname === AVAILABLE_MODELS_ENDPOINT_PATH) {
    sendJson(response, 200, { models: AVAILABLE_OPENROUTER_MODELS });
    return;
  }

  response.setHeader("Allow", AVAILABLE_MODELS_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function handleOpenRouterModelsRequest(
  swarmManager: SwarmManager,
  broadcastEvent: (event: ServerEvent) => void,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, MODELS_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, MODELS_METHODS);

  const dataDir = swarmManager.getConfig().paths.dataDir;
  const relativePath = requestUrl.pathname.slice(MODELS_ENDPOINT_PATH.length);
  const rawModelId = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  const modelId = decodePathSegment(rawModelId);

  if (request.method === "GET" && requestUrl.pathname === MODELS_ENDPOINT_PATH) {
    try {
      const [models, providerAvailability] = await Promise.all([
        getOpenRouterModels(dataDir),
        getManagedModelProviderCredentialAvailability(swarmManager.getConfig()),
      ]);

      sendJson(response, 200, {
        models,
        isConfigured: providerAvailability.get("openrouter") ?? false,
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

    const catalogModel = OPENROUTER_CATALOG_MODEL_BY_ID.get(modelId);
    if (!catalogModel) {
      sendJson(response, 404, { error: `Unknown OpenRouter modelId: ${modelId}` });
      return;
    }

    try {
      const existingModels = await readOpenRouterModels(dataDir);
      const existingEntry = existingModels.models[modelId];
      if (existingEntry) {
        sendJson(response, 200, { ...existingEntry });
        return;
      }

      const entry = buildOpenRouterModelEntry(catalogModel);
      await mutateOpenRouterModelsWithProjectionReload({
        swarmManager,
        dataDir,
        previousFile: existingModels,
        mutate: async () => {
          await addOpenRouterModel(dataDir, entry);
        },
      });
      broadcastModelConfigChanged(broadcastEvent);
      sendJson(response, 200, { ...entry });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  if (request.method === "DELETE") {
    if (!modelId) {
      sendJson(response, 400, { error: "modelId is required" });
      return;
    }

    try {
      const existingModels = await readOpenRouterModels(dataDir);
      if (!existingModels.models[modelId]) {
        sendJson(response, 404, { error: `Unknown OpenRouter modelId: ${modelId}` });
        return;
      }

      await mutateOpenRouterModelsWithProjectionReload({
        swarmManager,
        dataDir,
        previousFile: existingModels,
        mutate: async () => {
          await removeOpenRouterModel(dataDir, modelId);
        },
      });
      broadcastModelConfigChanged(broadcastEvent);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
    return;
  }

  response.setHeader("Allow", MODELS_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function mutateOpenRouterModelsWithProjectionReload(options: {
  swarmManager: SwarmManager;
  dataDir: string;
  previousFile: OpenRouterModelsFile;
  mutate: () => Promise<void>;
}): Promise<void> {
  const { swarmManager, dataDir, previousFile, mutate } = options;

  await mutate();

  try {
    await swarmManager.reloadOpenRouterModelsAndProjection();
  } catch (error) {
    await writeOpenRouterModels(dataDir, previousFile);

    try {
      await swarmManager.reloadOpenRouterModelsAndProjection();
    } catch {
      // Best-effort restoration. Preserve the original projection error below.
    }

    throw error;
  }
}

function buildOpenRouterModelEntry(model: (typeof OPENROUTER_CATALOG_MODELS)[number]): OpenRouterModelEntry {
  return {
    modelId: model.id,
    displayName: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsReasoning: model.reasoning,
    supportedReasoningLevels: model.reasoning ? [...DEFAULT_REASONING_LEVELS] : ["none"],
    inputModes: [...model.input],
    addedAt: new Date().toISOString(),
  };
}

function broadcastModelConfigChanged(broadcastEvent: (event: ServerEvent) => void): void {
  broadcastEvent({
    type: "model_config_changed",
    updatedAt: new Date().toISOString(),
  });
}

function extractUpstreamProvider(modelId: string): string {
  const slashIndex = modelId.indexOf("/");
  return slashIndex === -1 ? modelId : modelId.slice(0, slashIndex);
}

function inferSupportsTools(modelId: string, displayName: string, upstreamProvider: string): boolean {
  if (!TOOL_CAPABLE_UPSTREAM_PROVIDERS.has(upstreamProvider)) {
    return false;
  }

  const haystack = `${modelId} ${displayName}`.toLowerCase();
  return !NON_TOOL_MODEL_PATTERNS.some((pattern) => haystack.includes(pattern));
}

function normalizePerMillionCost(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return value > 0 && value < 0.001 ? value * 1_000_000 : value;
}
