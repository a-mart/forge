import {
  getEffectiveManagerEnabled,
  getCatalogModel,
  isCatalogModelManagerSupported,
  type ManagerExactModelSelection,
  type ManagerModelSurface,
} from "@forge/protocol";
import type { AgentModelDescriptor, SwarmReasoningLevel } from "../types.js";
import { assertSwarmModelIdNotRetired, normalizeThinkingLevelForModelDescriptor } from "./model-presets.js";
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
