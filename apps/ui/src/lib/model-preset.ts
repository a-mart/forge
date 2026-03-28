import { useEffect, useState } from 'react'
import type {
  AgentDescriptor,
  ManagerModelPreset,
  ManagerReasoningLevel,
  ModelPresetInfo,
  ModelVariantInfo,
} from '@forge/protocol'
import { MANAGER_MODEL_PRESETS, MANAGER_REASONING_LEVELS } from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

const FALLBACK_MODEL_PRESET_INFO: ModelPresetInfo[] = [
  {
    presetId: 'pi-codex',
    displayName: 'GPT-5.3 Codex',
    provider: 'openai-codex',
    modelId: 'gpt-5.3-codex',
    defaultReasoningLevel: 'xhigh',
    supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    variants: [{ modelId: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' }],
  },
  {
    presetId: 'pi-5.4',
    displayName: 'GPT-5.4',
    provider: 'openai-codex',
    modelId: 'gpt-5.4',
    defaultReasoningLevel: 'xhigh',
    supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    variants: [
      { modelId: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { modelId: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
    ],
  },
  {
    presetId: 'pi-grok',
    displayName: 'Grok 4',
    provider: 'xai',
    modelId: 'grok-4',
    defaultReasoningLevel: 'high',
    supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    variants: [
      { modelId: 'grok-4-fast', label: 'Grok 4 Fast' },
      { modelId: 'grok-3', label: 'Grok 3' },
    ],
  },
  {
    presetId: 'pi-opus',
    displayName: 'Claude Opus 4.6',
    provider: 'anthropic',
    modelId: 'claude-opus-4-6',
    defaultReasoningLevel: 'high',
    supportedReasoningLevels: ['low', 'medium', 'high'],
    variants: [
      { modelId: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
      { modelId: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
  },
  {
    presetId: 'codex-app',
    displayName: 'Codex App Runtime',
    provider: 'openai-codex-app-server',
    modelId: 'default',
    defaultReasoningLevel: 'xhigh',
    supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
]

export function inferModelPreset(agent: AgentDescriptor): ManagerModelPreset | undefined {
  const provider = agent.model.provider.trim().toLowerCase()
  const modelId = agent.model.modelId.trim().toLowerCase()

  if (provider === 'openai-codex' && modelId === 'gpt-5.3-codex') {
    return 'pi-codex'
  }

  if (provider === 'openai-codex' && modelId === 'gpt-5.4') {
    return 'pi-5.4'
  }

  if (provider === 'xai' && modelId.startsWith('grok-')) {
    return 'pi-grok'
  }

  if (provider === 'anthropic' && modelId === 'claude-opus-4-6') {
    return 'pi-opus'
  }

  if (provider === 'openai-codex-app-server' && modelId === 'default') {
    return 'codex-app'
  }

  return undefined
}

export function getModelPresetInfoMap(models: readonly ModelPresetInfo[]): Map<string, ModelPresetInfo> {
  const presetInfoMap = new Map<string, ModelPresetInfo>()

  for (const fallbackInfo of FALLBACK_MODEL_PRESET_INFO) {
    presetInfoMap.set(fallbackInfo.presetId, fallbackInfo)
  }

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

export function useModelPresets(wsUrl: string): ModelPresetInfo[] {
  const [modelPresets, setModelPresets] = useState<ModelPresetInfo[]>(FALLBACK_MODEL_PRESET_INFO)

  useEffect(() => {
    let cancelled = false

    const loadModelPresets = async () => {
      try {
        const models = await fetchModelPresets(wsUrl)
        if (!cancelled && models.length > 0) {
          setModelPresets(models)
          return
        }
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
  }, [wsUrl])

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
    )
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
