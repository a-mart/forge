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
} from "@forge/protocol";
import type {
  ManagerReasoningLevel,
  ModelOverrideEntry,
  ModelPresetInfo,
  ModelVariantInfo,
} from "@forge/protocol";
import { readModelOverrides } from "./model-overrides.js";
import type { AgentModelDescriptor } from "./types.js";

const REASONING_LEVELS: ManagerReasoningLevel[] = ["none", "low", "medium", "high", "xhigh"];

export class ModelCatalogService {
  private readonly catalog: ForgeModelCatalog;
  private overrides: Record<string, ModelOverrideEntry> = {};

  constructor(catalog: ForgeModelCatalog = FORGE_MODEL_CATALOG) {
    this.catalog = catalog;
  }

  async loadOverrides(dataDir: string): Promise<void> {
    const file = await readModelOverrides(dataDir);
    this.overrides = { ...file.overrides };
  }

  getOverrides(): Record<string, ModelOverrideEntry> {
    return { ...this.overrides };
  }

  isKnownModelId(modelId: string): boolean {
    return isCatalogModelId(modelId);
  }

  inferProvider(modelId: string): string | null {
    return inferCatalogProvider(modelId);
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
    const model = getCatalogModel(modelId);
    if (!model) {
      return undefined;
    }

    const cap = this.overrides[model.modelId]?.contextWindowCap;
    return cap !== undefined ? Math.min(model.contextWindow, cap) : model.contextWindow;
  }

  getModelDisplayName(modelId: string): string {
    return getCatalogModel(modelId)?.displayName ?? modelId;
  }

  supportsNativeWebSearch(modelId: string): boolean {
    return this.isModelEnabled(modelId) && getCatalogModel(modelId)?.webSearchCapability === "native";
  }

  isModelEnabled(modelId: string): boolean {
    const model = getCatalogModel(modelId);
    if (!model) {
      return false;
    }

    return this.overrides[model.modelId]?.enabled ?? model.enabledByDefault;
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
    return Object.keys(this.catalog.models);
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
