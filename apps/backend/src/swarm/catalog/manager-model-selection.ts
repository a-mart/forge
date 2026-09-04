import {
  MANAGER_REASONING_LEVELS,
  getCatalogFamily,
  getCatalogModel,
  getEffectiveManagerEnabled,
  getEffectiveOpenRouterManagerEnabled,
  getOpenRouterManagerDefaultReasoningLevel,
  isCatalogModelManagerSupported,
  isOpenRouterModelManagerSupported,
  type ForgeModelDefinition,
  type ManagerExactModelSelection,
  type ManagerModelSurface,
  type ManagerReasoningLevel,
  type OpenRouterModelEntry,
} from "@forge/protocol";
import type { AgentModelDescriptor, SwarmReasoningLevel } from "../types.js";
import {
  assertSwarmModelIdNotRetired,
  clampThinkingLevelToSupportedMetadata,
  normalizeThinkingLevelForModelDescriptor,
} from "./model-presets.js";
import { modelCatalogService } from "./model-catalog-service.js";

export type ManagerModelEligibilityFailureCode =
  | "invalid_selection"
  | "retired"
  | "unknown"
  | "globally_disabled"
  | "unsupported_surface"
  | "manager_disabled"
  | "provider_not_configured";

export interface ManagerModelEligibilityMetadata {
  source: "catalog" | "openrouter";
  provider: string;
  providerLabel: string;
  modelId: string;
  label: string;
  familyId?: string;
  familyLabel?: string;
  supportedReasoningLevels: readonly ManagerReasoningLevel[];
  defaultReasoningLevel: ManagerReasoningLevel;
}

export interface ManagerModelEligibilityChecks {
  globallyEnabled: boolean;
  surfaceSupported: boolean;
  managerEnabled: boolean;
  providerAvailable: boolean;
}

export type ManagerModelEligibilityResult =
  | {
      eligible: true;
      metadata: ManagerModelEligibilityMetadata;
      checks: ManagerModelEligibilityChecks;
      descriptor: AgentModelDescriptor;
    }
  | {
      eligible: false;
      code: ManagerModelEligibilityFailureCode;
      message: string;
      metadata?: ManagerModelEligibilityMetadata;
      checks?: ManagerModelEligibilityChecks;
    };

interface ManagerModelEligibilityOptions {
  surface: ManagerModelSurface;
  providerAvailability: ReadonlyMap<string, boolean>;
  reasoningLevel?: SwarmReasoningLevel;
}

/**
 * Authoritative structured policy evaluation for exact manager selections.
 * Command resolution and the manager-selection catalog are adapters over this
 * result so eligibility predicates cannot drift between read and write paths.
 */
export function evaluateExactManagerModelSelection(
  selection: ManagerExactModelSelection,
  options: ManagerModelEligibilityOptions,
): ManagerModelEligibilityResult {
  const provider = selection.provider.trim().toLowerCase();
  const modelId = selection.modelId.trim();

  if (!provider) {
    return reject("invalid_selection", "modelSelection.provider must be a non-empty string");
  }

  if (!modelId) {
    return reject("invalid_selection", "modelSelection.modelId must be a non-empty string");
  }

  try {
    assertSwarmModelIdNotRetired(provider, modelId, "modelSelection.modelId");
  } catch (error) {
    return reject("retired", error instanceof Error ? error.message : String(error));
  }

  if (provider === "openrouter") {
    return evaluateExactOpenRouterManagerModelSelection(modelId, options);
  }

  // Eligibility intentionally comes from the checked-in policy row. Effective
  // metadata may be overlaid for that same exact ID (for example xAI OAuth),
  // but discovered-only IDs remain worker/specialist-only and fail closed.
  const policyModel = getCatalogModel(modelId, provider);
  if (!policyModel || policyModel.provider !== provider) {
    const discoveredModel = modelCatalogService.getModel(modelId, provider);
    if (discoveredModel?.discovered) {
      const metadata = catalogMetadata(discoveredModel);
      return reject(
        "unknown",
        `Unknown manager model selection: ${provider}/${modelId}`,
        metadata,
        {
          globallyEnabled: modelCatalogService.isModelEnabled(modelId, provider),
          surfaceSupported: false,
          managerEnabled: false,
          providerAvailable: options.providerAvailability.get(provider) !== false,
        },
      );
    }
    return reject("unknown", `Unknown manager model selection: ${provider}/${modelId}`);
  }

  const effectiveModel = modelCatalogService.getModel(modelId, provider) ?? policyModel;
  const metadata = catalogMetadata(effectiveModel, policyModel);
  const globallyEnabled = modelCatalogService.isModelEnabled(policyModel.modelId, policyModel.provider);
  const surfaceSupported = isCatalogModelManagerSupported(policyModel, options.surface);
  const override = modelCatalogService.getOverride(policyModel.modelId, policyModel.provider);
  const managerEnabled = getEffectiveManagerEnabled(policyModel, override, options.surface);
  // Preserve the existing exact-command rule: an absent availability entry is
  // accepted for catalog providers; an explicit false is rejected.
  const providerAvailable = options.providerAvailability.get(policyModel.provider) !== false;
  const checks = { globallyEnabled, surfaceSupported, managerEnabled, providerAvailable };

  if (!globallyEnabled) {
    return reject("globally_disabled", `Model ${policyModel.displayName} is globally disabled`, metadata, checks);
  }
  if (!surfaceSupported) {
    return reject(
      "unsupported_surface",
      `Model ${policyModel.displayName} is not available for manager ${options.surface}`,
      metadata,
      checks,
    );
  }
  if (!managerEnabled) {
    return reject("manager_disabled", `Model ${policyModel.displayName} is disabled for manager agents`, metadata, checks);
  }
  if (!providerAvailable) {
    return reject(
      "provider_not_configured",
      `Provider ${policyModel.provider} is not configured for manager model selection`,
      metadata,
      checks,
    );
  }

  const reasoningLevel = normalizeThinkingLevelForModelDescriptor(
    {
      provider: effectiveModel.provider,
      modelId: effectiveModel.modelId,
      thinkingLevel: effectiveModel.defaultReasoningLevel,
    },
    options.reasoningLevel,
  );

  return {
    eligible: true,
    metadata,
    checks,
    descriptor: {
      provider: effectiveModel.provider,
      modelId: effectiveModel.modelId,
      thinkingLevel: reasoningLevel,
    },
  };
}

export function resolveExactManagerModelSelection(
  selection: ManagerExactModelSelection,
  options: ManagerModelEligibilityOptions,
): AgentModelDescriptor {
  const result = evaluateExactManagerModelSelection(selection, options);
  if (!result.eligible) {
    throw new Error(result.message);
  }
  return result.descriptor;
}

function evaluateExactOpenRouterManagerModelSelection(
  modelId: string,
  options: ManagerModelEligibilityOptions,
): ManagerModelEligibilityResult {
  const openRouterModel = modelCatalogService.getOpenRouterModel(modelId);
  if (!openRouterModel) {
    return reject("unknown", `Unknown manager model selection: openrouter/${modelId}`);
  }

  const metadata = openRouterMetadata(openRouterModel);
  const globallyEnabled = true;
  const surfaceSupported = isOpenRouterModelManagerSupported(openRouterModel);
  const override = modelCatalogService.getOverride(openRouterModel.modelId, "openrouter");
  const managerEnabled = getEffectiveOpenRouterManagerEnabled(openRouterModel, override, options.surface);
  // OpenRouter has always required affirmative credential availability.
  const providerAvailable = options.providerAvailability.get("openrouter") === true;
  const checks = { globallyEnabled, surfaceSupported, managerEnabled, providerAvailable };

  if (!surfaceSupported) {
    return reject(
      "unsupported_surface",
      `Model ${openRouterModel.displayName} is not available for manager ${options.surface}`,
      metadata,
      checks,
    );
  }
  if (!managerEnabled) {
    return reject("manager_disabled", `Model ${openRouterModel.displayName} is disabled for manager agents`, metadata, checks);
  }
  if (!providerAvailable) {
    return reject(
      "provider_not_configured",
      "Provider openrouter is not configured for manager model selection",
      metadata,
      checks,
    );
  }

  const defaultReasoningLevel = getOpenRouterManagerDefaultReasoningLevel(openRouterModel);
  const reasoningLevel = clampThinkingLevelToSupportedMetadata(
    options.reasoningLevel ?? defaultReasoningLevel,
    {
      supportsReasoning: openRouterModel.supportsReasoning,
      supportedReasoningLevels: openRouterModel.supportedReasoningLevels,
      defaultReasoningLevel,
    },
  );

  return {
    eligible: true,
    metadata,
    checks,
    descriptor: {
      provider: "openrouter",
      modelId: openRouterModel.modelId,
      thinkingLevel: reasoningLevel,
    },
  };
}

function catalogMetadata(
  effectiveModel: ForgeModelDefinition,
  policyModel: ForgeModelDefinition = effectiveModel,
): ManagerModelEligibilityMetadata {
  const family = getCatalogFamily(policyModel.familyId);
  const provider = modelCatalogService.getProvider(policyModel.provider);
  return {
    source: "catalog",
    provider: policyModel.provider,
    providerLabel: provider?.displayName ?? policyModel.provider,
    modelId: policyModel.modelId,
    label: effectiveModel.displayName,
    familyId: policyModel.familyId,
    ...(family ? { familyLabel: family.displayName } : {}),
    supportedReasoningLevels: normalizeReasoningLevels(effectiveModel.supportedReasoningLevels),
    defaultReasoningLevel: normalizeReasoningLevel(effectiveModel.defaultReasoningLevel),
  };
}

function openRouterMetadata(model: OpenRouterModelEntry): ManagerModelEligibilityMetadata {
  return {
    source: "openrouter",
    provider: "openrouter",
    providerLabel: modelCatalogService.getProvider("openrouter")?.displayName ?? "OpenRouter",
    modelId: model.modelId,
    label: model.displayName,
    supportedReasoningLevels: normalizeReasoningLevels(model.supportedReasoningLevels),
    defaultReasoningLevel: normalizeReasoningLevel(getOpenRouterManagerDefaultReasoningLevel(model)),
  };
}

function normalizeReasoningLevels(levels: readonly string[]): ManagerReasoningLevel[] {
  return levels.filter((level): level is ManagerReasoningLevel =>
    MANAGER_REASONING_LEVELS.includes(level as ManagerReasoningLevel),
  );
}

function normalizeReasoningLevel(level: string): ManagerReasoningLevel {
  return MANAGER_REASONING_LEVELS.includes(level as ManagerReasoningLevel)
    ? level as ManagerReasoningLevel
    : "none";
}

function reject(
  code: ManagerModelEligibilityFailureCode,
  message: string,
  metadata?: ManagerModelEligibilityMetadata,
  checks?: ManagerModelEligibilityChecks,
): ManagerModelEligibilityResult {
  return {
    eligible: false,
    code,
    message,
    ...(metadata ? { metadata } : {}),
    ...(checks ? { checks } : {}),
  };
}
