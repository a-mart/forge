import { existsSync } from "node:fs";
import { join } from "node:path";
import { getModels } from "../pi/pi-ai-compat.js";
import {
  FORGE_MODEL_CATALOG,
  getCatalogModel,
  type ForgeProviderDefinition,
  type ForgeThinkingLevelMap,
} from "@forge/protocol";
import { getSharedCacheGeneratedDir } from "../data-paths.js";
import { modelCatalogService } from "./model-catalog-service.js";
import { writeJsonFileAtomic } from "../../utils/atomic-files.js";
import { refreshXaiOAuthModelDiscovery } from "./xai-oauth-model-discovery.js";

const PI_MODELS_FILENAME = "pi-models.json";

export interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>;
}

interface PiProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  models?: PiModelDefinition[];
  modelOverrides?: Record<string, PiModelOverride>;
}

interface PiModelDefinition {
  id: string;
  name?: string;
  api?: string;
  authScope?: "any" | "oauth";
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  thinkingLevelMap?: ForgeThinkingLevelMap;
  compat?: Record<string, unknown>;
}

interface PiModelOverride {
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: ForgeThinkingLevelMap;
}

export function getPiModelsProjectionPath(dataDir: string): string {
  return join(getSharedCacheGeneratedDir(dataDir), PI_MODELS_FILENAME);
}

export function assertPiModelsProjectionAvailable(projectionPath: string): void {
  if (!existsSync(projectionPath)) {
    throw new Error(
      `Pi model projection file is missing: ${projectionPath}. Regenerate it before creating a ModelRegistry.`,
    );
  }
}

export function buildPiModelsProjection(): PiModelsConfig {
  const projection: PiModelsConfig = { providers: {} };

  for (const provider of Object.values(FORGE_MODEL_CATALOG.providers)) {
    if (provider.piProjectionMode === "none") {
      continue;
    }

    if (provider.piProjectionMode === "built-in-overrides") {
      const providerConfig = buildBuiltInOverrides(provider);
      if (providerConfig) {
        projection.providers[provider.providerId] = providerConfig;
      }
      continue;
    }

    if (provider.piProjectionMode === "custom-provider-merge") {
      const providerConfig = buildCustomProviderProjection(provider);
      if (providerConfig) {
        projection.providers[provider.providerId] = providerConfig;
      }
    }
  }

  return projection;
}

/**
 * Generate a Pi-compatible models.json projection from the Forge catalog.
 *
 * This file is written to <dataDir>/shared/cache/generated/pi-models.json and the stable path is
 * passed as modelsJsonPath to every Pi ModelRegistry instance.
 */
export async function generatePiProjection(dataDir: string): Promise<string> {
  await refreshXaiOAuthModelDiscovery(dataDir);
  await modelCatalogService.loadOverrides(dataDir);

  const outputPath = getPiModelsProjectionPath(dataDir);
  const projection = buildPiModelsProjection();

  await writeJsonFileAtomic(outputPath, projection);

  return outputPath;
}


function projectThinkingLevelMap(model: object | undefined): { thinkingLevelMap?: ForgeThinkingLevelMap } {
  const thinkingLevelMap = (model as { thinkingLevelMap?: ForgeThinkingLevelMap } | undefined)?.thinkingLevelMap;
  return thinkingLevelMap ? { thinkingLevelMap: { ...thinkingLevelMap } } : {};
}

function buildBuiltInOverrides(provider: ForgeProviderDefinition): PiProviderConfig | undefined {
  // Keep curated models in the projection even when user-disabled so existing sessions,
  // specialists, and manual configs still resolve to Forge-owned runtime metadata.
  // `enabled` only affects selector visibility/new configuration flows.
  const providerModels = Object.values(FORGE_MODEL_CATALOG.models).filter(
    (model) => model.provider === provider.providerId,
  );

  const upstreamModelIds = new Set(
    getModels(provider.providerId as Parameters<typeof getModels>[0]).map((model) => model.id),
  );

  const modelOverrides: Record<string, PiModelOverride> = {};
  const models: PiModelDefinition[] = [];

  for (const model of providerModels) {
    const upstreamKey = model.piUpstreamId ?? model.modelId;
    const existsInUpstream = upstreamModelIds.has(upstreamKey);

    if (existsInUpstream && model.piUpstreamId) {
      modelOverrides[model.modelId] = {
        contextWindow: modelCatalogService.getEffectiveContextWindow(model.modelId) ?? model.contextWindow,
        maxTokens: model.maxOutputTokens,
        ...projectThinkingLevelMap(model),
      };
      continue;
    }

    if (!existsInUpstream) {
      models.push({
        id: model.modelId,
        name: model.displayName,
        reasoning: model.supportsReasoning,
        input: [...model.inputModes],
        contextWindow: modelCatalogService.getEffectiveContextWindow(model.modelId) ?? model.contextWindow,
        maxTokens: model.maxOutputTokens,
        ...projectThinkingLevelMap(model),
      });
    }
  }

  if (Object.keys(modelOverrides).length === 0 && models.length === 0) {
    return undefined;
  }

  return {
    ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
    ...(models.length > 0 ? { models } : {}),
  };
}

function buildCustomProviderProjection(provider: ForgeProviderDefinition): PiProviderConfig | undefined {
  const models =
    provider.projectionScope === "approved-provider-models"
      ? generateApprovedProviderProjection(provider)
      : generateCatalogOnlyProviderProjection(provider);

  if (models.length === 0) {
    return undefined;
  }

  return {
    baseUrl: provider.piBaseUrl,
    apiKey: provider.piApiKeyEnvVar ? `$${provider.piApiKeyEnvVar}` : undefined,
    api: provider.piApiProtocol,
    models,
  };
}

/**
 * Used for xAI: project the checked-in Forge rows plus authenticated entitlement discovery.
 * Pi upstream metadata is reused only for those approved exact IDs; uncurated upstream additions
 * must not silently bypass Forge's auth scope and model approval rules.
 */
function generateApprovedProviderProjection(provider: ForgeProviderDefinition): PiModelDefinition[] {
  const upstreamModels = getModels(provider.providerId as any);
  const upstreamById = new Map(upstreamModels.map((model) => [model.id, model]));
  const effectiveCatalogModels = modelCatalogService.getModelsForProvider(provider.providerId);
  const modelIds = new Set(effectiveCatalogModels.map((model) => model.modelId));

  return [...modelIds].map((modelId) => {
    const upstream = upstreamById.get(modelId);
    const catalogModel = modelCatalogService.getModel(modelId, provider.providerId)
      ?? getCatalogModel(modelId, provider.providerId);

    return {
      id: modelId,
      name: catalogModel?.displayName ?? upstream?.name ?? modelId,
      api: provider.piApiProtocol ?? upstream?.api,
      ...(catalogModel?.authScope ? { authScope: catalogModel.authScope } : {}),
      reasoning: catalogModel?.supportsReasoning ?? upstream?.reasoning ?? false,
      input: catalogModel ? [...catalogModel.inputModes] : [...(upstream?.input ?? ["text"])],
      contextWindow: catalogModel
        ? (modelCatalogService.getEffectiveContextWindow(catalogModel.modelId, catalogModel.provider) ?? catalogModel.contextWindow)
        : (upstream?.contextWindow ?? 1),
      maxTokens: catalogModel?.maxOutputTokens ?? upstream?.maxTokens ?? 1,
      ...(upstream?.cost
        ? {
            cost: {
              input: upstream.cost.input,
              output: upstream.cost.output,
              cacheRead: upstream.cost.cacheRead,
              cacheWrite: upstream.cost.cacheWrite,
            },
          }
        : {}),
      ...(upstream?.headers ? { headers: { ...upstream.headers } } : {}),
      ...projectThinkingLevelMap(catalogModel ?? upstream),
      ...(upstream?.compat ? { compat: structuredClone(upstream.compat) } : {}),
    };
  });
}

function generateCatalogOnlyProviderProjection(provider: ForgeProviderDefinition): PiModelDefinition[] {
  if (provider.providerId === "openrouter") {
    return modelCatalogService.getOpenRouterModels().map((model) => ({
      id: model.modelId,
      name: model.displayName,
      reasoning: model.supportsReasoning,
      input: [...model.inputModes],
      contextWindow: model.contextWindow,
      maxTokens: model.maxOutputTokens,
      ...projectThinkingLevelMap(model),
    }));
  }

  return Object.values(FORGE_MODEL_CATALOG.models)
    .filter(
      (model) =>
        model.provider === provider.providerId &&
        model.piUpstreamId !== null,
    )
    .map((model) => ({
      id: model.modelId,
      name: model.displayName,
      api: provider.piApiProtocol ?? undefined,
      reasoning: model.supportsReasoning,
      input: [...model.inputModes],
      contextWindow: modelCatalogService.getEffectiveContextWindow(model.modelId) ?? model.contextWindow,
      maxTokens: model.maxOutputTokens,
      ...projectThinkingLevelMap(model),
    }));
}
