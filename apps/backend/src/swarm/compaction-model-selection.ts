import type { ManagerExactModelSelection, ManagerReasoningLevel } from "@forge/protocol";
import {
  getCatalogModel,
  getEffectiveManagerEnabled,
  isCatalogModelCompactionSupported,
  isCompactionProviderSupported,
} from "@forge/protocol";
import { modelCatalogService } from "./catalog/model-catalog-service.js";
import { resolveExactManagerModelSelection } from "./catalog/manager-model-selection.js";
import { CompactionSettingsValidationError } from "./compaction-settings-validation.js";

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
  if (!isCompactionProviderSupported(provider)) {
    throw new CompactionSettingsValidationError(COMPACTION_PROVIDER_ERROR);
  }

  try {
    resolveExactManagerModelSelection(model, {
      surface: "change",
      providerAvailability: options.providerAvailability,
      reasoningLevel: options.reasoningLevel,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CompactionSettingsValidationError(message);
  }

  const catalogModel = getCatalogModel(model.modelId.trim(), provider);
  if (!catalogModel || !isCatalogModelCompactionSupported(catalogModel)) {
    throw new CompactionSettingsValidationError(COMPACTION_PROVIDER_ERROR);
  }
}

export function isCompactionModelCatalogValid(model: ManagerExactModelSelection): boolean {
  const provider = model.provider.trim().toLowerCase();
  const modelId = model.modelId.trim();
  const catalogModel = getCatalogModel(modelId, provider);
  if (!catalogModel || catalogModel.provider !== provider) {
    return false;
  }

  if (!modelCatalogService.isModelEnabled(catalogModel.modelId, catalogModel.provider)) {
    return false;
  }

  if (!isCatalogModelCompactionSupported(catalogModel)) {
    return false;
  }

  const override = modelCatalogService.getOverride(catalogModel.modelId, catalogModel.provider);
  return getEffectiveManagerEnabled(catalogModel, override, "change");
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
