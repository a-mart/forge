import { useEffect, useState } from 'react'
import type {
  AgentDescriptor,
  ManagerModelPreset,
  ManagerReasoningLevel,
  ModelPresetInfo,
  ModelVariantInfo,
} from '@forge/protocol'
import {
  MANAGER_MODEL_PRESETS,
  MANAGER_REASONING_LEVELS,
  getCatalogModel,
  getCatalogModelsByFamily,
  getSpecialistFamilies,
  inferCatalogFamily,
} from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

// Generate fallback from the checked-in catalog so the UI works offline
const FALLBACK_MODEL_PRESET_INFO: ModelPresetInfo[] = getSpecialistFamilies().map((family) => {
  const familyModels = getCatalogModelsByFamily(family.familyId)
  const defaultModel = familyModels.find((m) => m.isFamilyDefault)
  const variants = familyModels
    .filter((m) => !m.isFamilyDefault)
    .map((m) => ({ modelId: m.modelId, label: m.displayName }))
  const supportsWebSearch = familyModels.some((m) => m.webSearchCapability === 'native')

  return {
    presetId: family.familyId as ManagerModelPreset,
    displayName: family.displayName,
    provider: family.provider,
    modelId: family.defaultModelId,
    defaultReasoningLevel: (defaultModel?.defaultReasoningLevel ?? family.defaultReasoningLevel) as ManagerReasoningLevel,
    supportedReasoningLevels: (defaultModel?.supportedReasoningLevels ?? MANAGER_REASONING_LEVELS) as ManagerReasoningLevel[],
    ...(supportsWebSearch ? { webSearch: true } : {}),
    ...(variants.length > 0 ? { variants } : {}),
  }
})

export function inferModelPreset(agent: AgentDescriptor): ManagerModelPreset | undefined {
  const provider = agent.model.provider.trim().toLowerCase()
  const modelId = agent.model.modelId.trim().toLowerCase()
  return inferCatalogFamily(provider, modelId) as ManagerModelPreset | undefined
}

export function getModelPresetInfoMap(models: readonly ModelPresetInfo[]): Map<string, ModelPresetInfo> {
  const presetInfoMap = new Map<string, ModelPresetInfo>()

  for (const info of models) {
    presetInfoMap.set(info.presetId, info)
  }

  return presetInfoMap
}

export function getModelPresetInfo(
  presetId: string,
  modelPresetInfoMap: ReadonlyMap<string, ModelPresetInfo>,
): ModelPresetInfo | undefined {
  if (!MANAGER_MODEL_PRESETS.includes(presetId as ManagerModelPreset)) {
    return undefined
  }

  return modelPresetInfoMap.get(presetId)
}

export function getDefaultReasoningLevelForModelPreset(
  presetId: string,
  modelPresetInfoMap: ReadonlyMap<string, ModelPresetInfo>,
): ManagerReasoningLevel {
  return getModelPresetInfo(presetId, modelPresetInfoMap)?.defaultReasoningLevel ?? 'high'
}

export function getSupportedReasoningLevelsForModelPreset(
  presetId: string,
  modelPresetInfoMap: ReadonlyMap<string, ModelPresetInfo>,
): readonly ManagerReasoningLevel[] {
  return getModelPresetInfo(presetId, modelPresetInfoMap)?.supportedReasoningLevels ?? MANAGER_REASONING_LEVELS
}

export function normalizeReasoningLevelForModelPreset(
  presetId: string,
  reasoningLevel: string | undefined,
  modelPresetInfoMap: ReadonlyMap<string, ModelPresetInfo>,
): ManagerReasoningLevel {
  const normalizedReasoningLevel = reasoningLevel?.trim()
  const supportedReasoningLevels = getSupportedReasoningLevelsForModelPreset(presetId, modelPresetInfoMap)

  if (normalizedReasoningLevel && supportedReasoningLevels.includes(normalizedReasoningLevel as ManagerReasoningLevel)) {
    return normalizedReasoningLevel as ManagerReasoningLevel
  }

  return getDefaultReasoningLevelForModelPreset(presetId, modelPresetInfoMap)
}

export function formatModelPresetDisplay(
  presetId: string,
  modelPresetInfoMap: ReadonlyMap<string, ModelPresetInfo>,
): string {
  const info = modelPresetInfoMap.get(presetId)
  if (!info) {
    return presetId
  }

  return `${info.displayName} (${info.modelId})`
}

export async function fetchModelPresets(wsUrl: string | undefined): Promise<ModelPresetInfo[]> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/models')
  const response = await fetch(endpoint, { cache: 'no-store' })

  if (!response.ok) {
    throw new Error(`Failed to load model presets (${response.status})`)
  }

  const payload = (await response.json()) as { models?: unknown }
  if (!payload || !Array.isArray(payload.models)) {
    return []
  }

  return payload.models.filter(isModelPresetInfo)
}

export function useModelPresets(wsUrl: string | undefined, refreshKey = 0): ModelPresetInfo[] {
  const [modelPresets, setModelPresets] = useState<ModelPresetInfo[]>(FALLBACK_MODEL_PRESET_INFO)

  useEffect(() => {
    let cancelled = false

    const loadModelPresets = async () => {
      try {
        const models = await fetchModelPresets(wsUrl)
        if (!cancelled) {
          setModelPresets(models)
        }
        return
      } catch {
        // Keep fallback metadata if request fails.
      }

      if (!cancelled) {
        setModelPresets(FALLBACK_MODEL_PRESET_INFO)
      }
    }

    void loadModelPresets()

    return () => {
      cancelled = true
    }
  }, [refreshKey, wsUrl])

  return modelPresets
}

function isModelPresetInfo(value: unknown): value is ModelPresetInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const model = value as Record<string, unknown>
  if (!MANAGER_MODEL_PRESETS.includes(model.presetId as ManagerModelPreset)) {
    return false
  }

  if (!MANAGER_REASONING_LEVELS.includes(model.defaultReasoningLevel as ManagerReasoningLevel)) {
    return false
  }

  if (
    typeof model.displayName !== 'string' ||
    typeof model.provider !== 'string' ||
    typeof model.modelId !== 'string' ||
    !Array.isArray(model.supportedReasoningLevels) ||
    model.supportedReasoningLevels.some(
      (level) => !MANAGER_REASONING_LEVELS.includes(level as ManagerReasoningLevel),
    ) ||
    (model.webSearch !== undefined && typeof model.webSearch !== 'boolean')
  ) {
    return false
  }

  if (model.variants === undefined) {
    return true
  }

  if (!Array.isArray(model.variants)) {
    return false
  }

  return model.variants.every(isModelVariantInfo)
}

function isModelVariantInfo(value: unknown): value is ModelVariantInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const variant = value as Record<string, unknown>
  return typeof variant.modelId === 'string' && typeof variant.label === 'string'
}

/**
 * Return a human-friendly display label for a raw modelId.
 *
 * Checks default modelIds and variant modelIds across all presets.
 * Falls back to the raw modelId if no match is found.
 */
export function getModelDisplayLabel(modelId: string, presets: ModelPresetInfo[]): string {
  for (const preset of presets) {
    if (preset.modelId === modelId) {
      return preset.displayName
    }
    if (preset.variants) {
      for (const variant of preset.variants) {
        if (variant.modelId === modelId) {
          return variant.label
        }
      }
    }
  }
  return modelId
}

/**
 * Look up the supported reasoning levels for a given modelId.
 * Checks both primary preset modelIds and variant modelIds (variants inherit parent's levels).
 * Falls back to all levels if the modelId is unknown.
 */
export function getSupportedReasoningLevelsForModelId(
  modelId: string,
  presets: ModelPresetInfo[],
): ManagerReasoningLevel[] {
  // Try catalog first for per-model accuracy
  const catalogModel = getCatalogModel(modelId)
  if (catalogModel) {
    return catalogModel.supportedReasoningLevels as ManagerReasoningLevel[]
  }
  // Fall back to preset-level data
  for (const preset of presets) {
    if (preset.modelId === modelId) {
      return preset.supportedReasoningLevels
    }
    if (preset.variants) {
      for (const variant of preset.variants) {
        if (variant.modelId === modelId) {
          return preset.supportedReasoningLevels
        }
      }
    }
  }
  return [...MANAGER_REASONING_LEVELS]
}

export interface SelectableModel {
  modelId: string
  label: string
  provider: string
  isVariant: boolean
}

/**
 * Build a flat list of all selectable model IDs from preset info,
 * including the default model and each variant for every preset.
 */
export function getAllSelectableModels(presets: ModelPresetInfo[]): SelectableModel[] {
  const models: SelectableModel[] = []
  for (const preset of presets) {
    models.push({
      modelId: preset.modelId,
      label: preset.displayName,
      provider: preset.provider,
      isVariant: false,
    })
    if (preset.variants) {
      for (const variant of preset.variants) {
        models.push({
          modelId: variant.modelId,
          label: variant.label,
          provider: preset.provider,
          isVariant: true,
        })
      }
    }
  }
  return models
}
