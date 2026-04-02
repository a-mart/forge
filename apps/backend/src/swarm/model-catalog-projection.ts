import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getModels } from "@mariozechner/pi-ai";
import {
  FORGE_MODEL_CATALOG,
  getCatalogModel,
  type ForgeProviderDefinition,
} from "@forge/protocol";
import { getSharedCacheGeneratedDir } from "./data-paths.js";
import { modelCatalogService } from "./model-catalog-service.js";

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
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface PiModelOverride {
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
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
      projection.providers[provider.providerId] = buildCustomProviderProjection(provider);
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
  await modelCatalogService.loadOverrides(dataDir);

  const outputPath = getPiModelsProjectionPath(dataDir);
  const generatedDir = getSharedCacheGeneratedDir(dataDir);
  const tempPath = join(generatedDir, `${PI_MODELS_FILENAME}.tmp`);
  const projection = buildPiModelsProjection();

  await mkdir(generatedDir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
  await rename(tempPath, outputPath);

  return outputPath;
}

function buildBuiltInOverrides(provider: ForgeProviderDefinition): PiProviderConfig | undefined {
  // Keep curated models in the projection even when user-disabled so existing sessions,
  // specialists, and manual configs still resolve to Forge-owned runtime metadata.
  // `enabled` only affects selector visibility/new configuration flows.
  const providerModels = Object.values(FORGE_MODEL_CATALOG.models).filter(
    (model) => model.provider === provider.providerId,
  );

  const modelOverrides: Record<string, PiModelOverride> = {};
  for (const model of providerModels) {
    if (!model.piUpstreamId) {
      continue;
    }

    modelOverrides[model.modelId] = {
      contextWindow: modelCatalogService.getEffectiveContextWindow(model.modelId) ?? model.contextWindow,
      maxTokens: model.maxOutputTokens,
    };
  }

  return Object.keys(modelOverrides).length > 0 ? { modelOverrides } : undefined;
}

function buildCustomProviderProjection(provider: ForgeProviderDefinition): PiProviderConfig {
  const models =
    provider.projectionScope === "full-upstream-provider"
      ? generateFullProviderProjection(provider)
      : generateCuratedProviderProjection(provider);

  return {
    baseUrl: provider.piBaseUrl,
    apiKey: provider.piApiKeyEnvVar,
    api: provider.piApiProtocol,
    models,
  };
}

/**
 * Used for xAI: copy every Pi upstream model into the projection so mergeCustomModels()
 * covers the provider's full inventory, not just Forge-curated IDs.
 *
 * Curated Forge entries override authored metadata. Uncurated entries keep Pi upstream metadata
 * verbatim except for the provider-level API protocol swap to openai-responses.
 */
function generateFullProviderProjection(provider: ForgeProviderDefinition): PiModelDefinition[] {
  const upstreamModels = getModels(provider.providerId as any);

  return upstreamModels.flatMap((upstream) => {
    const catalogModel = getCatalogModel(upstream.id);
    const curated = catalogModel?.provider === provider.providerId ? catalogModel : undefined;

    return [{
      id: upstream.id,
      name: curated?.displayName ?? upstream.name,
      api: provider.piApiProtocol ?? upstream.api,
      reasoning: curated?.supportsReasoning ?? upstream.reasoning,
      input: curated ? [...curated.inputModes] : [...upstream.input],
      contextWindow: curated
        ? (modelCatalogService.getEffectiveContextWindow(curated.modelId) ?? curated.contextWindow)
        : upstream.contextWindow,
      maxTokens: curated?.maxOutputTokens ?? upstream.maxTokens,
      ...(upstream.cost
        ? {
            cost: {
              input: upstream.cost.input,
              output: upstream.cost.output,
              cacheRead: upstream.cost.cacheRead,
              cacheWrite: upstream.cost.cacheWrite,
            },
          }
        : {}),
      ...(upstream.headers ? { headers: { ...upstream.headers } } : {}),
      ...(upstream.compat ? { compat: structuredClone(upstream.compat) } : {}),
    }];
  });
}

function generateCuratedProviderProjection(provider: ForgeProviderDefinition): PiModelDefinition[] {
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
    }));
}
