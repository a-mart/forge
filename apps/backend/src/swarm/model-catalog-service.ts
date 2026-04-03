import {
  FORGE_MODEL_CATALOG,
  getCatalogFamily,
  getCatalogModel,
  getCatalogModelsByFamily,
  getCatalogProvider,
  getSpecialistFamilies,
  inferCatalogFamily,
  inferCatalogProvider,
  isCatalogModelId,
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
import type { AgentModelDescriptor } from "./types.js";

const REASONING_LEVELS: ManagerReasoningLevel[] = ["none", "low", "medium", "high", "xhigh"];

export class ModelCatalogService {
  private readonly catalog: ForgeModelCatalog;
  private overrides: Record<string, ModelOverrideEntry> = {};
  private openRouterModels: Record<string, OpenRouterModelEntry> = {};
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
    this.overrides = { ...overrideFile.overrides };
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
    return Object.values(this.openRouterModels).sort((left, right) => left.modelId.localeCompare(right.modelId));
  }

  isKnownModelId(modelId: string): boolean {
    const normalizedModelId = modelId.trim();
    return isCatalogModelId(normalizedModelId) || normalizedModelId in this.openRouterModels;
  }

  inferProvider(modelId: string): string | null {
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId) {
      return null;
    }

    const catalogProvider = inferCatalogProvider(normalizedModelId);
    if (catalogProvider) {
      return catalogProvider;
    }

    return normalizedModelId in this.openRouterModels ? "openrouter" : null;
  }

  inferFamily(descriptor: Pick<AgentModelDescriptor, "provider" | "modelId">): string | undefined {
    if (!descriptor?.provider || !descriptor?.modelId) {
      return undefined;
    }

    return inferCatalogFamily(descriptor.provider, descriptor.modelId);
  }

  getModelPresetInfoList(): ModelPresetInfo[] {
    return Object.values(this.catalog.families).flatMap((family) => {
      const enabledModels = this.getEnabledModelsByFamily(family.familyId);
      const effectiveDefaultModel = this.getEffectiveDefaultModelForFamily(family.familyId);

      if (!effectiveDefaultModel) {
        return [];
      }

      const variants: ModelVariantInfo[] = enabledModels
        .filter((model) => model.modelId !== effectiveDefaultModel.modelId)
        .map((model) => ({ modelId: model.modelId, label: model.displayName }));
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
        modelId: "gpt-5.3-codex",
        thinkingLevel: "xhigh",
      }
    );
  }

  getContextWindow(modelId: string): number | undefined {
    return this.getEffectiveContextWindow(modelId);
  }

  getEffectiveContextWindow(modelId: string): number | undefined {
    const normalizedModelId = modelId.trim();
    const model = getCatalogModel(normalizedModelId);
    if (model) {
      const cap = this.overrides[model.modelId]?.contextWindowCap;
      return cap !== undefined ? Math.min(model.contextWindow, cap) : model.contextWindow;
    }

    return this.openRouterModels[normalizedModelId]?.contextWindow;
  }

  getModelDisplayName(modelId: string): string {
    const normalizedModelId = modelId.trim();
    return getCatalogModel(normalizedModelId)?.displayName ?? this.openRouterModels[normalizedModelId]?.displayName ?? modelId;
  }

  supportsNativeWebSearch(modelId: string): boolean {
    return this.isModelEnabled(modelId) && getCatalogModel(modelId)?.webSearchCapability === "native";
  }

  isModelEnabled(modelId: string): boolean {
    const normalizedModelId = modelId.trim();
    const model = getCatalogModel(normalizedModelId);
    if (model) {
      return this.overrides[model.modelId]?.enabled ?? model.enabledByDefault;
    }

    return normalizedModelId in this.openRouterModels;
  }

  getOverride(modelId: string): ModelOverrideEntry | undefined {
    const model = getCatalogModel(modelId);
    if (!model) {
      return undefined;
    }

    const override = this.overrides[model.modelId];
    return override ? { ...override } : undefined;
  }

  getAllModelIds(): string[] {
    return [...new Set([...Object.keys(this.catalog.models), ...Object.keys(this.openRouterModels)])];
  }

  getAllProviders(): ForgeProviderDefinition[] {
    return Object.values(this.catalog.providers);
  }

  getAllFamilies() {
    return Object.values(this.catalog.families);
  }

  getModel(modelId: string): ForgeModelDefinition | undefined {
    return getCatalogModel(modelId);
  }

  getProvider(providerId: string): ForgeProviderDefinition | undefined {
    return getCatalogProvider(providerId);
  }

  private getEnabledModelsByFamily(familyId: string): ForgeModelDefinition[] {
    return getCatalogModelsByFamily(familyId).filter((model) => this.isModelEnabled(model.modelId));
  }

  private getEffectiveDefaultModelForFamily(familyId: string): ForgeModelDefinition | undefined {
    const familyModels = getCatalogModelsByFamily(familyId);
    const enabledDefaultModel = familyModels.find(
      (model) => model.isFamilyDefault && this.isModelEnabled(model.modelId),
    );

    if (enabledDefaultModel) {
      return enabledDefaultModel;
    }

    return familyModels.find((model) => this.isModelEnabled(model.modelId));
  }
}

export const modelCatalogService = new ModelCatalogService();
