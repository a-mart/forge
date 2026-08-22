import {
  getEffectiveManagerEnabled,
  getEffectiveOpenRouterManagerEnabled,
  getCatalogModel,
  getOpenRouterManagerDefaultReasoningLevel,
  isCatalogModelManagerSupported,
  isOpenRouterModelManagerSupported,
  type ManagerExactModelSelection,
  type ManagerModelSurface,
} from "@forge/protocol";
import type { AgentModelDescriptor, SwarmReasoningLevel } from "../types.js";
import {
  assertSwarmModelIdNotRetired,
  clampThinkingLevelToSupportedMetadata,
  normalizeThinkingLevelForModelDescriptor,
} from "./model-presets.js";
import { modelCatalogService } from "./model-catalog-service.js";

export function resolveExactManagerModelSelection(
  selection: ManagerExactModelSelection,
  options: {
    surface: ManagerModelSurface;
    providerAvailability: ReadonlyMap<string, boolean>;
    reasoningLevel?: SwarmReasoningLevel;
  }
): AgentModelDescriptor {
  const provider = selection.provider.trim().toLowerCase();
  const modelId = selection.modelId.trim();

  if (!provider) {
    throw new Error("modelSelection.provider must be a non-empty string");
  }

  if (!modelId) {
    throw new Error("modelSelection.modelId must be a non-empty string");
  }

  assertSwarmModelIdNotRetired(provider, modelId, "modelSelection.modelId");

  if (provider === "openrouter") {
    return resolveExactOpenRouterManagerModelSelection(modelId, options);
  }

  const catalogModel = getCatalogModel(modelId, provider);
  if (!catalogModel || catalogModel.provider !== provider) {
    throw new Error(`Unknown manager model selection: ${provider}/${modelId}`);
  }

  if (!modelCatalogService.isModelEnabled(catalogModel.modelId, catalogModel.provider)) {
    throw new Error(`Model ${catalogModel.displayName} is globally disabled`);
  }

  if (!isCatalogModelManagerSupported(catalogModel, options.surface)) {
    throw new Error(`Model ${catalogModel.displayName} is not available for manager ${options.surface}`);
  }

  const override = modelCatalogService.getOverride(catalogModel.modelId, catalogModel.provider);
  if (!getEffectiveManagerEnabled(catalogModel, override, options.surface)) {
    throw new Error(`Model ${catalogModel.displayName} is disabled for manager agents`);
  }

  const providerAvailable = options.providerAvailability.get(catalogModel.provider);
  if (providerAvailable === false) {
    throw new Error(`Provider ${catalogModel.provider} is not configured for manager model selection`);
  }

  const reasoningLevel = normalizeThinkingLevelForModelDescriptor(
    {
      provider: catalogModel.provider,
      modelId: catalogModel.modelId,
      thinkingLevel: catalogModel.defaultReasoningLevel,
    },
    options.reasoningLevel,
  );

  return {
    provider: catalogModel.provider,
    modelId: catalogModel.modelId,
    thinkingLevel: reasoningLevel,
  };
}

function resolveExactOpenRouterManagerModelSelection(
  modelId: string,
  options: {
    surface: ManagerModelSurface;
    providerAvailability: ReadonlyMap<string, boolean>;
    reasoningLevel?: SwarmReasoningLevel;
  },
): AgentModelDescriptor {
  const openRouterModel = modelCatalogService.getOpenRouterModel(modelId);
  if (!openRouterModel) {
    throw new Error(`Unknown manager model selection: openrouter/${modelId}`);
  }

  if (!isOpenRouterModelManagerSupported(openRouterModel)) {
    throw new Error(`Model ${openRouterModel.displayName} is not available for manager ${options.surface}`);
  }

  const override = modelCatalogService.getOverride(openRouterModel.modelId, "openrouter");
  if (!getEffectiveOpenRouterManagerEnabled(openRouterModel, override, options.surface)) {
    throw new Error(`Model ${openRouterModel.displayName} is disabled for manager agents`);
  }

  if (options.providerAvailability.get("openrouter") !== true) {
    throw new Error("Provider openrouter is not configured for manager model selection");
  }

  const defaultReasoningLevel = getOpenRouterManagerDefaultReasoningLevel(openRouterModel);
  const reasoningLevel = clampThinkingLevelToSupportedMetadata(options.reasoningLevel ?? defaultReasoningLevel, {
    supportsReasoning: openRouterModel.supportsReasoning,
    supportedReasoningLevels: openRouterModel.supportedReasoningLevels,
    defaultReasoningLevel,
  });

  return {
    provider: "openrouter",
    modelId: openRouterModel.modelId,
    thinkingLevel: reasoningLevel,
  };
}
