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
  getChangeManagerFamilies,
  getSpecialistFamilies,
  inferCatalogFamily,
} from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'

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

export async function fetchModelPresets(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  options?: { allowDynamicPresetIds?: boolean },
): Promise<ModelPresetInfo[]> {
  let response: Response

  if (clientOrWsUrl && typeof clientOrWsUrl === 'object') {
    // Use target-aware client (preserves Collab credentials)
    response = await clientOrWsUrl.fetch('/api/settings/models', { cache: 'no-store' })
  } else {
    const endpoint = resolveApiEndpoint(clientOrWsUrl, '/api/settings/models')
    response = await fetch(endpoint, { cache: 'no-store' })
  }

  if (!response.ok) {
    throw new Error(`Failed to load model presets (${response.status})`)
  }

  const payload = (await response.json()) as { models?: unknown }
  if (!payload || !Array.isArray(payload.models)) {
    return []
  }

  return payload.models.filter((value): value is ModelPresetInfo =>
    isModelPresetInfo(value, options?.allowDynamicPresetIds === true),
  )
}

export function useModelPresets(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  refreshKey = 0,
  options?: { allowDynamicPresetIds?: boolean },
): ModelPresetInfo[] {
  const [modelPresets, setModelPresets] = useState<ModelPresetInfo[]>(FALLBACK_MODEL_PRESET_INFO)
  const allowDynamicPresetIds = options?.allowDynamicPresetIds === true

  useEffect(() => {
    let cancelled = false

    const loadModelPresets = async () => {
      try {
        const models = await fetchModelPresets(clientOrWsUrl, { allowDynamicPresetIds })
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
  }, [allowDynamicPresetIds, refreshKey, clientOrWsUrl])

  return modelPresets
}

function isModelPresetInfo(value: unknown, allowDynamicPresetIds = false): value is ModelPresetInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const model = value as Record<string, unknown>
  if (typeof model.presetId !== 'string' || model.presetId.trim().length === 0) {
    return false
  }

  if (!allowDynamicPresetIds && !MANAGER_MODEL_PRESETS.includes(model.presetId as ManagerModelPreset)) {
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
export function getModelDisplayLabel(modelId: string, presets: ModelPresetInfo[], provider?: string): string {
  for (const preset of presets) {
    if (provider && preset.provider !== provider) {
      continue
    }

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
  provider?: string,
): ManagerReasoningLevel[] {
  // Try catalog first for per-model accuracy
  const catalogModel = getCatalogModel(modelId, provider)
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
  key: string
  modelId: string
  label: string
  provider: string
  isVariant: boolean
}

/**
 * Build a flat list of all selectable model IDs from preset info,
 * including the default model and each variant for every preset.
 */
export function getAvailableChangeManagerFamilies(
  modelPresets: ModelPresetInfo[],
): Array<{ familyId: string; displayName: string }> {
  const presetInfoById = new Map(modelPresets.map((preset) => [preset.presetId, preset]))
  const hasServerFilteredFamilies = modelPresets.length > 0

  return getChangeManagerFamilies().flatMap((family) => {
    const preset = presetInfoById.get(family.familyId)
    if (!preset && hasServerFilteredFamilies) {
      return []
    }

    return [{
      familyId: family.familyId,
      displayName: preset?.displayName ?? family.displayName,
    }]
  })
}

export function getAllSelectableModels(presets: ModelPresetInfo[]): SelectableModel[] {
  const models: SelectableModel[] = []
  const seen = new Set<string>()

  const pushIfNeeded = (model: SelectableModel) => {
    if (seen.has(model.key)) {
      return
    }

    seen.add(model.key)
    models.push(model)
  }

  for (const preset of presets) {
    pushIfNeeded({
      key: `${preset.provider}::${preset.modelId}`,
      modelId: preset.modelId,
      label: preset.displayName,
      provider: preset.provider,
      isVariant: false,
    })
    if (preset.variants) {
      for (const variant of preset.variants) {
        pushIfNeeded({
          key: `${preset.provider}::${variant.modelId}`,
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
