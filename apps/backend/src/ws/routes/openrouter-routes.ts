import type { IncomingMessage, ServerResponse } from "node:http";
import { getModels } from "@mariozechner/pi-ai";
import type {
  AvailableOpenRouterModel,
  ForgeInputMode,
  ForgeReasoningLevel,
  OpenRouterModelEntry,
  OpenRouterModelsFile,
  ServerEvent,
} from "@forge/protocol";
import {
  getOpenRouterModels,
  addOpenRouterModel,
  readOpenRouterModels,
  removeOpenRouterModel,
  writeOpenRouterModels,
} from "../../swarm/openrouter-models.js";
import { getManagedModelProviderCredentialAvailability } from "../../swarm/secrets-env-service.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, decodePathSegment, parseJsonBody, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const AVAILABLE_MODELS_ENDPOINT_PATH = "/api/settings/openrouter/available-models";
const MODELS_ENDPOINT_PATH = "/api/settings/openrouter/models";
const AVAILABLE_MODELS_METHODS = "GET, OPTIONS";
const MODELS_METHODS = "GET, PUT, DELETE, OPTIONS";
const DEFAULT_REASONING_LEVELS: readonly ForgeReasoningLevel[] = ["none", "low", "medium", "high"];
const OPENROUTER_LIVE_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_LIVE_MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
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
  "z-ai",
]);
const VALID_INPUT_MODES = new Set<ForgeInputMode>(["text", "image"]);
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
const AVAILABLE_OPENROUTER_CATALOG_MODELS = sortAvailableOpenRouterModels(
  OPENROUTER_CATALOG_MODELS.map((model) => mapCatalogModelToAvailableModel(model)),
);

type OpenRouterCatalogModel = (typeof OPENROUTER_CATALOG_MODELS)[number];

let cachedLiveOpenRouterModels: AvailableOpenRouterModel[] | null = null;
let cachedLiveOpenRouterModelsAt = 0;
let liveOpenRouterModelsRequest: Promise<AvailableOpenRouterModel[]> | null = null;

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
    const liveModels = await fetchLiveOpenRouterModels();
    sendJson(response, 200, { models: mergeAvailableOpenRouterModels(AVAILABLE_OPENROUTER_CATALOG_MODELS, liveModels) });
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

    let requestedModel: AvailableOpenRouterModel | null = null;
    try {
      const payload = await parseJsonBody(request, 32 * 1024);
      requestedModel = normalizeAvailableOpenRouterModelPayload(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: message });
      return;
    }

    if (requestedModel && requestedModel.modelId !== modelId) {
      sendJson(response, 400, {
        error: `Request body modelId ${requestedModel.modelId} does not match path modelId ${modelId}`,
      });
      return;
    }

    try {
      const existingModels = await readOpenRouterModels(dataDir);
      const existingEntry = existingModels.models[modelId];
      if (existingEntry) {
        sendJson(response, 200, { ...existingEntry });
        return;
      }

      const entry = await buildOpenRouterModelEntryForAddition(modelId, requestedModel);
      if (!entry) {
        sendJson(response, 404, { error: `Unknown OpenRouter modelId: ${modelId}` });
        return;
      }

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

async function buildOpenRouterModelEntryForAddition(
  modelId: string,
  requestedModel: AvailableOpenRouterModel | null,
): Promise<OpenRouterModelEntry | null> {
  const catalogModel = OPENROUTER_CATALOG_MODEL_BY_ID.get(modelId);
  if (catalogModel) {
    return buildOpenRouterModelEntryFromCatalogModel(catalogModel);
  }

  const liveModel = requestedModel ?? (await getLiveOpenRouterModelById(modelId));
  if (!liveModel) {
    return null;
  }

  return buildOpenRouterModelEntryFromAvailableModel(liveModel);
}

function buildOpenRouterModelEntryFromCatalogModel(model: OpenRouterCatalogModel): OpenRouterModelEntry {
  return buildOpenRouterModelEntryFromAvailableModel(mapCatalogModelToAvailableModel(model));
}

function buildOpenRouterModelEntryFromAvailableModel(model: AvailableOpenRouterModel): OpenRouterModelEntry {
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    supportsReasoning: model.supportsReasoning,
    supportedReasoningLevels: model.supportsReasoning ? [...DEFAULT_REASONING_LEVELS] : ["none"],
    inputModes: normalizeInputModes(model.inputModes),
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

function mapCatalogModelToAvailableModel(model: OpenRouterCatalogModel): AvailableOpenRouterModel {
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
}

function sortAvailableOpenRouterModels(models: AvailableOpenRouterModel[]): AvailableOpenRouterModel[] {
  return [...models].sort((left, right) => {
    const providerComparison = left.upstreamProvider.localeCompare(right.upstreamProvider);
    if (providerComparison !== 0) {
      return providerComparison;
    }

    return left.displayName.localeCompare(right.displayName);
  });
}

function mergeAvailableOpenRouterModels(
  catalogModels: AvailableOpenRouterModel[],
  liveModels: AvailableOpenRouterModel[],
): AvailableOpenRouterModel[] {
  const merged = new Map(catalogModels.map((model) => [model.modelId, model]));

  for (const model of liveModels) {
    if (!merged.has(model.modelId)) {
      merged.set(model.modelId, model);
    }
  }

  return sortAvailableOpenRouterModels(Array.from(merged.values()));
}

async function fetchLiveOpenRouterModels(): Promise<AvailableOpenRouterModel[]> {
  if (
    cachedLiveOpenRouterModels &&
    Date.now() - cachedLiveOpenRouterModelsAt < OPENROUTER_LIVE_MODELS_CACHE_TTL_MS
  ) {
    return cachedLiveOpenRouterModels;
  }

  if (liveOpenRouterModelsRequest) {
    return liveOpenRouterModelsRequest;
  }

  liveOpenRouterModelsRequest = (async () => {
    try {
      const response = await fetch(OPENROUTER_LIVE_MODELS_URL);
      if (!response.ok) {
        throw new Error(`OpenRouter model fetch failed with status ${response.status}`);
      }

      const payload = (await response.json()) as { data?: unknown };
      const models = parseLiveOpenRouterModels(payload.data);
      cachedLiveOpenRouterModels = models;
      cachedLiveOpenRouterModelsAt = Date.now();
      return models;
    } catch {
      return cachedLiveOpenRouterModels ?? [];
    } finally {
      liveOpenRouterModelsRequest = null;
    }
  })();

  return liveOpenRouterModelsRequest;
}

async function getLiveOpenRouterModelById(modelId: string): Promise<AvailableOpenRouterModel | null> {
  const liveModels = await fetchLiveOpenRouterModels();
  return liveModels.find((model) => model.modelId === modelId) ?? null;
}

function parseLiveOpenRouterModels(data: unknown): AvailableOpenRouterModel[] {
  if (!Array.isArray(data)) {
    return [];
  }

  const models: AvailableOpenRouterModel[] = [];
  for (const candidate of data) {
    const mapped = mapOpenRouterApiModel(candidate);
    if (mapped) {
      models.push(mapped);
    }
  }

  return sortAvailableOpenRouterModels(models);
}

function mapOpenRouterApiModel(candidate: unknown): AvailableOpenRouterModel | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const model = candidate as Record<string, unknown>;
  const modelId = nonEmptyString(model.id);
  const displayName = nonEmptyString(model.name);
  const contextWindow = positiveInteger(model.context_length);
  const maxOutputTokens =
    positiveInteger(recordValue(model.top_provider, "max_completion_tokens")) ??
    positiveInteger(model.max_completion_tokens) ??
    contextWindow;
  const supportedParameters = stringArray(model.supported_parameters);
  const inputModes = inferInputModesFromOpenRouterModel(model);
  const pricing = parsePricing(recordValue(model, "pricing"));

  if (!modelId || !displayName || !contextWindow || !maxOutputTokens || inputModes.length === 0) {
    return null;
  }

  const upstreamProvider = extractUpstreamProvider(modelId);
  const supportsReasoning = supportedParameters.includes("reasoning");
  const supportsTools = supportedParameters.includes("tools");

  return {
    modelId,
    displayName,
    upstreamProvider,
    contextWindow,
    maxOutputTokens,
    supportsReasoning,
    supportsTools,
    inputModes,
    pricing,
  } satisfies AvailableOpenRouterModel;
}

function normalizeAvailableOpenRouterModelPayload(payload: unknown): AvailableOpenRouterModel | null {
  const candidate = recordValue(payload, "model") ?? payload;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const model = candidate as Record<string, unknown>;
  const modelId = nonEmptyString(model.modelId);
  const displayName = nonEmptyString(model.displayName);
  const contextWindow = positiveInteger(model.contextWindow);
  const maxOutputTokens = positiveInteger(model.maxOutputTokens);
  const supportsReasoning = typeof model.supportsReasoning === "boolean" ? model.supportsReasoning : null;
  const supportsTools = typeof model.supportsTools === "boolean" ? model.supportsTools : false;
  const inputModes = normalizeInputModes(model.inputModes);
  const pricing = parsePricing(model.pricing);

  if (!modelId || !displayName || !contextWindow || !maxOutputTokens || supportsReasoning === null || inputModes.length === 0) {
    return null;
  }

  return {
    modelId,
    displayName,
    upstreamProvider: nonEmptyString(model.upstreamProvider) ?? extractUpstreamProvider(modelId),
    contextWindow,
    maxOutputTokens,
    supportsReasoning,
    supportsTools,
    inputModes,
    pricing,
  } satisfies AvailableOpenRouterModel;
}

function inferInputModesFromOpenRouterModel(model: Record<string, unknown>): ForgeInputMode[] {
  const inputModalities = stringArray(model.input_modalities).map((value) => value.toLowerCase());
  const modality = nonEmptyString(recordValue(model.architecture, "modality"))?.toLowerCase() ?? "";

  if (inputModalities.includes("image") || modality.includes("image")) {
    return ["text", "image"];
  }

  return ["text"];
}

function normalizeInputModes(value: unknown): ForgeInputMode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: ForgeInputMode[] = [];
  const seen = new Set<ForgeInputMode>();

  for (const entry of value) {
    if (typeof entry !== "string") {
      return [];
    }

    const mode = entry.trim() as ForgeInputMode;
    if (!VALID_INPUT_MODES.has(mode) || seen.has(mode)) {
      if (!VALID_INPUT_MODES.has(mode)) {
        return [];
      }
      continue;
    }

    seen.add(mode);
    normalized.push(mode);
  }

  return normalized;
}

function parsePricing(value: unknown): AvailableOpenRouterModel["pricing"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const prompt = parseNumber(recordValue(value, "prompt"));
  const completion = parseNumber(recordValue(value, "completion"));

  if (prompt === null && completion === null) {
    return null;
  }

  return {
    inputPerMillion: normalizePerMillionCost((prompt ?? 0) * 1_000_000),
    outputPerMillion: normalizePerMillionCost((completion ?? 0) * 1_000_000),
  };
}

function recordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return (value as Record<string, unknown>)[key];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

export function resetLiveOpenRouterModelsCacheForTests(): void {
  cachedLiveOpenRouterModels = null;
  cachedLiveOpenRouterModelsAt = 0;
  liveOpenRouterModelsRequest = null;
}
