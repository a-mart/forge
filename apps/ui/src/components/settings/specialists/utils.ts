import type {
  ManagerReasoningLevel,
  ModelPresetInfo,
  ResolvedSpecialistDefinition,
} from '@forge/protocol'
import { MANAGER_REASONING_LEVELS } from '@forge/protocol'
import type { SelectableModel } from '@/lib/model-preset'
import type { CardEditState } from './types'
import { PROVIDER_LABELS, SPECIALIST_COLORS } from './types'
import type { SaveSpecialistPayload } from '../specialists-api'

/* ------------------------------------------------------------------ */
/*  Type guards                                                        */
/* ------------------------------------------------------------------ */

export function isManagerReasoningLevel(value: string): value is ManagerReasoningLevel {
  return MANAGER_REASONING_LEVELS.includes(value as ManagerReasoningLevel)
}

/* ------------------------------------------------------------------ */
/*  Provider / model helpers                                           */
/* ------------------------------------------------------------------ */

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

export function modelSupportsWebSearch(
  modelId: string,
  presets: ModelPresetInfo[],
  provider?: string,
): boolean {
  for (const preset of presets) {
    if (provider && preset.provider !== provider) {
      continue
    }
    if (preset.modelId === modelId || preset.variants?.some((variant) => variant.modelId === modelId)) {
      return preset.webSearch === true
    }
  }
  return false
}

export function encodeSelectableModelKey(provider: string, modelId: string): string {
  return `${provider}::${modelId}`
}

export function decodeSelectableModelKey(value: string): { provider: string; modelId: string } | null {
  const separatorIndex = value.indexOf('::')
  if (separatorIndex <= 0 || separatorIndex >= value.length - 2) {
    return null
  }
  return {
    provider: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 2),
  }
}

export function groupModelsByProvider(
  models: SelectableModel[],
): Array<{ provider: string; label: string; models: SelectableModel[] }> {
  const groups = new Map<string, SelectableModel[]>()
  for (const m of models) {
    let group = groups.get(m.provider)
    if (!group) {
      group = []
      groups.set(m.provider, group)
    }
    group.push(m)
  }
  return Array.from(groups.entries()).map(([provider, items]) => ({
    provider,
    label: providerLabel(provider),
    models: items,
  }))
}

/* ------------------------------------------------------------------ */
/*  Handle / naming helpers                                            */
/* ------------------------------------------------------------------ */

/** Normalize a raw string into a kebab-case handle. */
export function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Generate a unique clone handle that doesn't collide with existing specialist IDs. */
export function generateUniqueCloneHandle(baseHandle: string, existingIds: Set<string>): string {
  const candidate = `${baseHandle}-copy`
  if (!existingIds.has(candidate)) return candidate
  for (let i = 2; ; i++) {
    const numbered = `${baseHandle}-copy-${i}`
    if (!existingIds.has(numbered)) return numbered
  }
}

/** Pick the first color not already used by any existing specialist. */
export function pickAvailableColor(existingSpecialists: ResolvedSpecialistDefinition[]): string {
  const usedColors = new Set(existingSpecialists.map((s) => s.color.toLowerCase()))
  for (const color of SPECIALIST_COLORS) {
    if (!usedColors.has(color.toLowerCase())) return color
  }
  return SPECIALIST_COLORS[0]
}

/** Derive display name from handle: kebab-case → Title Case */
export function handleToDisplayName(handle: string): string {
  return handle
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/* ------------------------------------------------------------------ */
/*  State conversion                                                   */
/* ------------------------------------------------------------------ */

export function specialistToEditState(
  specialist: ResolvedSpecialistDefinition,
): CardEditState {
  return {
    handle: specialist.specialistId,
    displayName: specialist.displayName,
    color: specialist.color,
    enabled: specialist.enabled,
    whenToUse: specialist.whenToUse,
    modelId: specialist.modelId,
    provider: specialist.provider,
    reasoningLevel: specialist.reasoningLevel ?? 'high',
    fallbackModelId: specialist.fallbackModelId ?? '',
    fallbackProvider: specialist.fallbackProvider ?? '',
    fallbackReasoningLevel: specialist.fallbackReasoningLevel ?? '',
    pinned: specialist.pinned,
    webSearch: specialist.webSearch ?? false,
    promptBody: specialist.promptBody,
  }
}

export function toSaveSpecialistPayload(state: CardEditState): SaveSpecialistPayload {
  const reasoningLevel = state.reasoningLevel.trim()
  if (reasoningLevel && !isManagerReasoningLevel(reasoningLevel)) {
    throw new Error(`Reasoning level is invalid: ${reasoningLevel}`)
  }

  const normalizedReasoningLevel = reasoningLevel
    ? (reasoningLevel as ManagerReasoningLevel)
    : undefined

  const fallbackReasoningLevel = state.fallbackReasoningLevel.trim()
  if (fallbackReasoningLevel && !isManagerReasoningLevel(fallbackReasoningLevel)) {
    throw new Error(`Fallback reasoning level is invalid: ${fallbackReasoningLevel}`)
  }

  const normalizedFallbackReasoningLevel = fallbackReasoningLevel
    ? (fallbackReasoningLevel as ManagerReasoningLevel)
    : undefined

  const normalizedFallbackModelId = state.fallbackModelId || undefined
  const normalizedFallbackProvider = normalizedFallbackModelId ? (state.fallbackProvider || undefined) : undefined

  return {
    displayName: state.displayName,
    color: state.color,
    enabled: state.enabled,
    whenToUse: state.whenToUse,
    modelId: state.modelId,
    provider: state.provider || undefined,
    reasoningLevel: normalizedReasoningLevel,
    fallbackModelId: normalizedFallbackModelId,
    fallbackProvider: normalizedFallbackProvider,
    fallbackReasoningLevel: normalizedFallbackModelId ? normalizedFallbackReasoningLevel : undefined,
    pinned: state.pinned,
    webSearch: state.webSearch,
    promptBody: state.promptBody,
  }
}
