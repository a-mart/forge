import type { ManagerExactModelSelection, ManagerReasoningLevel } from "@forge/protocol";
import { getCatalogModel, getEffectiveManagerEnabled, isCatalogModelManagerSupported } from "@forge/protocol";
import { modelCatalogService } from "./catalog/model-catalog-service.js";
import { resolveExactManagerModelSelection } from "./catalog/manager-model-selection.js";
import { CompactionSettingsValidationError } from "./compaction-settings-validation.js";

/**
 * Compaction-specific model validation seam. Delegates to manager catalog rules for now so
 * runtime/UI phases are not hard-coupled to manager-selector policy at call sites.
 */
export function validateCompactionModelSelection(
  model: ManagerExactModelSelection,
  options: {
    providerAvailability: Map<string, boolean>;
    reasoningLevel?: ManagerReasoningLevel;
  },
): void {
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

  if (!isCatalogModelManagerSupported(catalogModel, "change")) {
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
