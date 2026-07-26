import type { ManagerExactModelSelection, ManagerReasoningLevel } from "@forge/protocol";
import {
  getCatalogModel,
  getEffectiveCompactionEnabled,
  isCatalogModelCompactionSupported,
  isCompactionProviderSupported,
} from "@forge/protocol";
import { modelCatalogService } from "./catalog/model-catalog-service.js";
import { CompactionSettingsValidationError } from "./compaction-settings-validation.js";
import { CLAUDE_SDK_RETIRED_PROVIDER_MESSAGE } from "./catalog/legacy-claude-sdk-model.js";

const COMPACTION_PROVIDER_ERROR =
  "Compaction model must use a Pi-compatible provider with raw API-key auth. Native SDK providers are not supported for compaction.";

/**
 * Compaction-specific model validation seam.
 */
export function validateCompactionModelSelection(
  model: ManagerExactModelSelection,
  options: {
    providerAvailability: Map<string, boolean>;
    reasoningLevel?: ManagerReasoningLevel;
  },
): void {
  const provider = model.provider.trim().toLowerCase();
  const modelId = model.modelId.trim();

  if (!provider) {
    throw new CompactionSettingsValidationError("model.provider must be a non-empty string");
  }

  if (!modelId) {
    throw new CompactionSettingsValidationError("model.modelId must be a non-empty string");
  }

  if (provider === "claude-sdk") {
    throw new CompactionSettingsValidationError(CLAUDE_SDK_RETIRED_PROVIDER_MESSAGE);
  }

  if (!isCompactionProviderSupported(provider)) {
    throw new CompactionSettingsValidationError(COMPACTION_PROVIDER_ERROR);
  }

  const catalogModel = getCatalogModel(modelId, provider);
  if (!catalogModel || catalogModel.provider !== provider || !isCatalogModelCompactionSupported(catalogModel)) {
    throw new CompactionSettingsValidationError(`Unknown compaction model selection: ${provider}/${modelId}`);
  }

  const override = modelCatalogService.getOverride(catalogModel.modelId, catalogModel.provider);
  if (!getEffectiveCompactionEnabled(catalogModel, override)) {
    throw new CompactionSettingsValidationError(`Model ${catalogModel.displayName} is disabled for compaction`);
  }

  const providerAvailable = options.providerAvailability.get(catalogModel.provider);
  if (providerAvailable === false) {
    throw new CompactionSettingsValidationError(
      `Provider ${catalogModel.provider} is not configured for compaction model selection`,
    );
  }

  const reasoningLevel = options.reasoningLevel ?? catalogModel.defaultReasoningLevel;
  if (!catalogModel.supportedReasoningLevels.includes(reasoningLevel)) {
    throw new CompactionSettingsValidationError(
      `Reasoning level ${reasoningLevel} is not supported by ${catalogModel.displayName}; supported levels: ${catalogModel.supportedReasoningLevels.join(", ")}`,
    );
  }
}

export function isCompactionModelCatalogValid(model: ManagerExactModelSelection): boolean {
  const provider = model.provider.trim().toLowerCase();
  const modelId = model.modelId.trim();
  const catalogModel = getCatalogModel(modelId, provider);
  if (!catalogModel || catalogModel.provider !== provider) {
    return false;
  }

  const override = modelCatalogService.getOverride(catalogModel.modelId, catalogModel.provider);
  return getEffectiveCompactionEnabled(catalogModel, override);
}

export function isCompactionReasoningSupported(
  model: ManagerExactModelSelection,
  reasoningLevel: ManagerReasoningLevel,
): boolean {
  const catalogModel = getCatalogModel(model.modelId.trim(), model.provider.trim().toLowerCase());
  if (!catalogModel) {
    return false;
  }

  return catalogModel.supportedReasoningLevels.includes(reasoningLevel);
}
