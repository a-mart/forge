import {
  FORGE_MODEL_CATALOG,
  getCatalogFamily,
  getCatalogModel,
  getCatalogModelsByFamily,
  getCatalogProvider,
  getSpecialistFamilies,
  inferCatalogFamily,
  inferCatalogProvider,
  isRetiredForgeModel,
  type ForgeModelCatalog,
  type ForgeModelDefinition,
  type ForgeProviderDefinition,
  type OpenRouterModelEntry,
} from "@forge/protocol";
import type {
  ManagerReasoningLevel,
  ModelOverrideEntry,
  ModelPresetInfo,
  ModelVariantInfo,
} from "@forge/protocol";
import { readModelOverrides } from "./model-overrides.js";
import { readOpenRouterModels } from "./openrouter-models.js";
import type { AgentModelDescriptor } from "../types.js";
import { mapLegacyClaudeSdkModel } from "./legacy-claude-sdk-model.js";

const REASONING_LEVELS: ManagerReasoningLevel[] = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];

export class ModelCatalogService {
  private readonly catalog: ForgeModelCatalog;
  private overrides: Record<string, ModelOverrideEntry> = {};
  private openRouterModels: Record<string, OpenRouterModelEntry> = {};
  private xaiOAuthActive = false;
  private xaiOAuthModels = new Map<string, ForgeModelDefinition>();
  private loadedDataDir: string | null = null;

  constructor(catalog: ForgeModelCatalog = FORGE_MODEL_CATALOG) {
    this.catalog = catalog;
  }

  async loadOverrides(dataDir: string): Promise<void> {
    const [overrideFile, openRouterFile] = await Promise.all([
      readModelOverrides(dataDir),
      readOpenRouterModels(dataDir),
    ]);

    this.loadedDataDir = dataDir;
    this.overrides = normalizeLoadedOverrides(overrideFile.overrides);
    this.openRouterModels = { ...openRouterFile.models };
  }

  async reloadOpenRouterModels(): Promise<void> {
    if (!this.loadedDataDir) {
      this.openRouterModels = {};
      return;
    }

    const file = await readOpenRouterModels(this.loadedDataDir);
    this.openRouterModels = { ...file.models };
  }

  getOverrides(): Record<string, ModelOverrideEntry> {
    return { ...this.overrides };
  }

  getOpenRouterModels(): OpenRouterModelEntry[] {
    return Object.values(this.openRouterModels)
      .filter((model) => !isRetiredForgeModel("openrouter", model.modelId))
      .sort((left, right) => left.modelId.localeCompare(right.modelId));
  }

  setXaiOAuthDiscoveredModels(models: readonly ForgeModelDefinition[] | null): void {
    this.xaiOAuthActive = models !== null;
    this.xaiOAuthModels = new Map((models ?? []).map((model) => [model.modelId, { ...model }]));
  }

  isXaiOAuthActive(): boolean {
    return this.xaiOAuthActive;
  }

  getModelsForProvider(provider: string): ForgeModelDefinition[] {
    const normalizedProvider = provider.trim().toLowerCase();
    const checkedIn = Object.values(this.catalog.models)
      .filter((model) => model.provider === normalizedProvider)
      .map((model) => this.getModel(model.modelId, normalizedProvider) ?? model);
    if (normalizedProvider !== "xai") {
      return checkedIn;
    }

    const byId = new Map(checkedIn.map((model) => [model.modelId, model]));
    for (const model of this.xaiOAuthModels.values()) {
      byId.set(model.modelId, model);
    }
    return [...byId.values()];
  }

  isKnownModelId(modelId: string, provider?: string): boolean {
    const normalizedModelId = modelId.trim();
    if (provider && isRetiredForgeModel(provider, normalizedModelId)) {
      return false;
    }
    if (isRetiredForgeModel("openrouter", normalizedModelId)) {
      return false;
    }
    return this.getModel(normalizedModelId, provider) !== undefined || normalizedModelId in this.openRouterModels;
  }

  inferProvider(modelId: string): string | null {
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId) {
      return null;
    }

    const catalogProvider = this.xaiOAuthModels.has(normalizedModelId)
      ? "xai"
      : inferCatalogProvider(normalizedModelId);
    if (catalogProvider) {
      return catalogProvider;
    }

    return normalizedModelId in this.openRouterModels && !isRetiredForgeModel("openrouter", normalizedModelId)
      ? "openrouter"
      : null;
  }

  inferFamily(descriptor: Pick<AgentModelDescriptor, "provider" | "modelId">): string | undefined {
    if (!descriptor?.provider || !descriptor?.modelId) {
      return undefined;
    }

    return this.getModel(descriptor.modelId, descriptor.provider)?.familyId
      ?? inferCatalogFamily(descriptor.provider, descriptor.modelId);
  }

  getModelPresetInfoList(): ModelPresetInfo[] {
    return Object.values(this.catalog.families).flatMap((family) => {
      if (!family.visibleInSpawnPreset) {
        return [];
      }

      const enabledModels = this.getEnabledModelsByFamily(family.familyId);
      const effectiveDefaultModel = this.getEffectiveDefaultModelForFamily(family.familyId);

      if (!effectiveDefaultModel) {
        return [];
      }

      const variants: ModelVariantInfo[] = enabledModels
        .filter((model) => model.modelId !== effectiveDefaultModel.modelId)
        .map((model) => ({
          modelId: model.modelId,
          label: model.displayName,
          supportedReasoningLevels: [
            ...((model.supportedReasoningLevels ?? REASONING_LEVELS) as ManagerReasoningLevel[]),
          ],
          defaultReasoningLevel: model.defaultReasoningLevel as ManagerReasoningLevel,
        }));
      const supportsWebSearch = enabledModels.some((model) => model.webSearchCapability === "native");

      return [{
        presetId: family.familyId,
        displayName: effectiveDefaultModel.displayName,
        provider: family.provider,
        modelId: effectiveDefaultModel.modelId,
        defaultReasoningLevel: effectiveDefaultModel.defaultReasoningLevel as ManagerReasoningLevel,
        supportedReasoningLevels: [
          ...((effectiveDefaultModel.supportedReasoningLevels ?? REASONING_LEVELS) as ManagerReasoningLevel[]),
        ],
        ...(supportsWebSearch ? { webSearch: true } : {}),
        ...(variants.length > 0 ? { variants } : {}),
      }];
    });
  }

  getSpecialistModelPresetInfoList(): ModelPresetInfo[] {
    const visibleFamilyIds = new Set(getSpecialistFamilies().map((family) => family.familyId));
    return this.getModelPresetInfoList().filter((model) => visibleFamilyIds.has(model.presetId));
  }

  resolveModelDescriptorFromFamily(familyId: string): AgentModelDescriptor | undefined {
    const family = getCatalogFamily(familyId);
    if (!family) {
      return undefined;
    }

    const effectiveDefaultModel = this.getEffectiveDefaultModelForFamily(familyId);
    if (!effectiveDefaultModel) {
      return undefined;
    }

    return {
      provider: family.provider,
      modelId: effectiveDefaultModel.modelId,
      thinkingLevel: effectiveDefaultModel.defaultReasoningLevel,
    };
  }

  resolveModelDescriptor(familyId: string): AgentModelDescriptor {
    return (
      this.resolveModelDescriptorFromFamily(familyId) ?? {
        provider: "openai-codex",
        modelId: "gpt-5.5",
        thinkingLevel: "xhigh",
      }
    );
  }

  getContextWindow(modelId: string, provider?: string): number | undefined {
    return this.getEffectiveContextWindow(modelId, provider);
  }

  getEffectiveContextWindow(modelId: string, provider?: string): number | undefined {
    const normalizedModelId = modelId.trim();
    const model = this.getModel(normalizedModelId, provider);
    if (model) {
      const cap = this.overrides[getOverrideKey(model)]?.contextWindowCap;
      return cap !== undefined ? Math.min(model.contextWindow, cap) : model.contextWindow;
    }

    return this.openRouterModels[normalizedModelId]?.contextWindow;
  }

  getModelDisplayName(modelId: string, provider?: string): string {
    const normalizedModelId = modelId.trim();
    return this.getModel(normalizedModelId, provider)?.displayName ?? this.openRouterModels[normalizedModelId]?.displayName ?? modelId;
  }

  getEffectiveModelSpecificInstructions(modelId: string, provider?: string): string | undefined {
    const model = this.getModel(modelId.trim(), provider);
    if (!model) {
      return undefined;
    }

    const overrideValue = this.overrides[getOverrideKey(model)]?.modelSpecificInstructions;
    if (overrideValue !== undefined) {
      return overrideValue.length > 0 ? overrideValue : undefined;
    }

    return undefined;
  }

  supportsNativeWebSearch(modelId: string, provider?: string): boolean {
    return this.isModelEnabled(modelId, provider) && this.getModel(modelId, provider)?.webSearchCapability === "native";
  }

  isModelEnabled(modelId: string, provider?: string): boolean {
    const normalizedModelId = modelId.trim();
    const model = this.getModel(normalizedModelId, provider);
    if (model) {
      return this.overrides[getOverrideKey(model)]?.enabled ?? model.enabledByDefault;
    }

    return normalizedModelId in this.openRouterModels && !isRetiredForgeModel("openrouter", normalizedModelId);
  }

  getOverride(modelId: string, provider?: string): ModelOverrideEntry | undefined {
    const model = this.getModel(modelId, provider);
    if (!model) {
      return undefined;
    }

    const override = this.overrides[getOverrideKey(model)];
    return override ? { ...override } : undefined;
  }

  getAllModelIds(): string[] {
    const openRouterModelIds = Object.keys(this.openRouterModels)
      .filter((modelId) => !isRetiredForgeModel("openrouter", modelId));
    return [...new Set([...Object.keys(this.catalog.models), ...this.xaiOAuthModels.keys(), ...openRouterModelIds])];
  }

  getAllProviders(): ForgeProviderDefinition[] {
    return Object.values(this.catalog.providers);
  }

  getAllFamilies() {
    return Object.values(this.catalog.families);
  }

  getModel(modelId: string, provider?: string): ForgeModelDefinition | undefined {
    const normalizedModelId = modelId.trim().toLowerCase();
    const normalizedProvider = provider?.trim().toLowerCase();
    const discovered = this.xaiOAuthModels.get(normalizedModelId);
    if (discovered && (!normalizedProvider || normalizedProvider === "xai")) {
      return discovered;
    }

    const checkedIn = getCatalogModel(normalizedModelId, normalizedProvider);
    if (!checkedIn) {
      return undefined;
    }
    if (this.xaiOAuthActive && checkedIn.provider === "xai" && checkedIn.modelId === "grok-4.5") {
      return buildXaiOAuthFallbackGrok45(checkedIn);
    }
    return checkedIn;
  }

  getProvider(providerId: string): ForgeProviderDefinition | undefined {
    return getCatalogProvider(providerId);
  }

  private getEnabledModelsByFamily(familyId: string): ForgeModelDefinition[] {
    const checkedIn = getCatalogModelsByFamily(familyId)
      .map((model) => this.getModel(model.modelId, model.provider) ?? model);
    const discovered = familyId === "pi-grok" ? [...this.xaiOAuthModels.values()] : [];
    const byId = new Map([...checkedIn, ...discovered].map((model) => [model.modelId, model]));
    return [...byId.values()].filter((model) => this.isModelEnabled(model.modelId, model.provider));
  }

  private getEffectiveDefaultModelForFamily(familyId: string): ForgeModelDefinition | undefined {
    const family = getCatalogFamily(familyId);
    if (!family) {
      return undefined;
    }

    const familyModels = this.getEnabledModelsByFamily(familyId);
    const enabledDefaultModel = familyModels.find(
      (model) => model.isFamilyDefault && this.isModelEnabled(model.modelId, model.provider),
    );

    if (enabledDefaultModel) {
      return enabledDefaultModel;
    }

    const fallbackDefaultModel = this.getModel(family.defaultModelId, family.provider);
    if (fallbackDefaultModel && this.isModelEnabled(fallbackDefaultModel.modelId, fallbackDefaultModel.provider)) {
      return fallbackDefaultModel;
    }

    const enabledFamilyModel = familyModels.find((model) => this.isModelEnabled(model.modelId, model.provider));
    if (enabledFamilyModel) {
      return enabledFamilyModel;
    }

    return fallbackDefaultModel;
  }
}

export const modelCatalogService = new ModelCatalogService();

function normalizeLoadedOverrides(
  overrides: Record<string, ModelOverrideEntry>,
): Record<string, ModelOverrideEntry> {
  const normalized = Object.fromEntries(
    Object.entries(overrides).filter(([key]) => !key.trim().toLowerCase().startsWith("claude-sdk/")),
  );

  for (const [key, legacyEntry] of Object.entries(overrides)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey.startsWith("claude-sdk/")) {
      continue;
    }

    const mapping = mapLegacyClaudeSdkModel({ provider: "claude-sdk", modelId: normalizedKey });
    if (mapping.kind !== "mapped") {
      continue;
    }

    normalized[mapping.modelId] = mergeMappedOverride(legacyEntry, normalized[mapping.modelId]);
  }

  return normalized;
}

function mergeMappedOverride(
  legacyEntry: ModelOverrideEntry,
  canonicalEntry: ModelOverrideEntry | undefined,
): ModelOverrideEntry {
  const merged: ModelOverrideEntry = {};
  const enabled = falseWins(legacyEntry.enabled, canonicalEntry?.enabled);
  const managerEnabled = falseWins(legacyEntry.managerEnabled, canonicalEntry?.managerEnabled);
  const caps = [legacyEntry.contextWindowCap, canonicalEntry?.contextWindowCap]
    .filter((value): value is number => value !== undefined);

  if (enabled !== undefined) merged.enabled = enabled;
  if (managerEnabled !== undefined) merged.managerEnabled = managerEnabled;
  if (caps.length > 0) merged.contextWindowCap = Math.min(...caps);
  if (canonicalEntry?.modelSpecificInstructions !== undefined) {
    merged.modelSpecificInstructions = canonicalEntry.modelSpecificInstructions;
  } else if (legacyEntry.modelSpecificInstructions !== undefined) {
    merged.modelSpecificInstructions = legacyEntry.modelSpecificInstructions;
  }

  return merged;
}

function falseWins(left: boolean | undefined, right: boolean | undefined): boolean | undefined {
  if (left === false || right === false) return false;
  return right ?? left;
}

function getOverrideKey(model: ForgeModelDefinition): string {
  return model.catalogId ?? model.modelId;
}

function buildXaiOAuthFallbackGrok45(model: ForgeModelDefinition): ForgeModelDefinition {
  return {
    ...model,
    supportedReasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "high",
    thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: null },
  };
}
