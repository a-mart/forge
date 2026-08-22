import {
  FORGE_MODEL_CATALOG,
  getCatalogFamily,
  getCatalogModelKey,
  getCatalogProvider,
  getEffectiveManagerEnabled,
  getEffectiveOpenRouterManagerEnabled,
  getOpenRouterManagerDefaultReasoningLevel,
  getOpenRouterModelOverrideKey,
  isCatalogModelManagerSupported,
  isRetiredForgeModel,
  type ForgeModelDefinition,
  type ManagerModelSurface,
  type ModelOverrideEntry,
  type OpenRouterModelEntry,
} from '@forge/protocol'
import type { ManagerReasoningLevel } from '@forge/protocol'

/** A single exact model row for manager selectors (local UI type, not protocol DTO). */
export interface ManagerModelSelectRow {
  /** Stable select value: `${provider}::${modelId}` */
  key: string
  provider: string
  providerDisplayName: string
  familyId: string
  familyDisplayName: string
  modelId: string
  displayName: string
  supportedReasoningLevels: ManagerReasoningLevel[]
  defaultReasoningLevel: ManagerReasoningLevel
  /** When set, the row should be shown as unavailable with this reason. */
  unavailableReason?: string
}

/** A group of rows sharing a provider for rendering grouped selectors. */
export interface ManagerModelProviderGroup {
  provider: string
  providerDisplayName: string
  rows: ManagerModelSelectRow[]
}

const OPENROUTER_FAMILY_ID = 'openrouter'
const GENERIC_REASONING_LEVELS: ManagerReasoningLevel[] = ['none', 'low', 'medium', 'high', 'xhigh']

/** Encode a provider + modelId into a unique select value. */
export function encodeManagerModelValue(provider: string, modelId: string): string {
  return `${provider}::${modelId}`
}

/** Decode a select value back to provider + modelId. Returns undefined on invalid input. */
export function decodeManagerModelValue(value: string): { provider: string; modelId: string } | undefined {
  const idx = value.indexOf('::')
  if (idx < 1) return undefined
  return { provider: value.slice(0, idx), modelId: value.slice(idx + 2) }
}

function findOpenRouterModelEntry(
  modelId: string,
  openRouterModels: readonly OpenRouterModelEntry[],
): OpenRouterModelEntry | undefined {
  const normalizedModelId = modelId.trim()
  if (!normalizedModelId) return undefined
  return openRouterModels.find((entry) => entry.modelId === normalizedModelId)
}

function buildOpenRouterManagerRow(
  entry: OpenRouterModelEntry,
  overrides: Record<string, ModelOverrideEntry>,
  providerAvailability: Record<string, boolean>,
  surface: ManagerModelSurface,
): ManagerModelSelectRow | undefined {
  if (isRetiredForgeModel('openrouter', entry.modelId)) return undefined
  if (!getEffectiveOpenRouterManagerEnabled(entry, overrides[getOpenRouterModelOverrideKey(entry.modelId)], surface)) {
    return undefined
  }

  const provider = getCatalogProvider('openrouter')
  if (!provider) return undefined

  const providerAvailable = providerAvailability.openrouter === true

  return {
    key: encodeManagerModelValue('openrouter', entry.modelId),
    provider: 'openrouter',
    providerDisplayName: provider.displayName,
    familyId: OPENROUTER_FAMILY_ID,
    familyDisplayName: provider.displayName,
    modelId: entry.modelId,
    displayName: entry.displayName,
    supportedReasoningLevels: [...entry.supportedReasoningLevels] as ManagerReasoningLevel[],
    defaultReasoningLevel: getOpenRouterManagerDefaultReasoningLevel(entry) as ManagerReasoningLevel,
    ...(providerAvailable ? {} : { unavailableReason: 'Provider not configured' }),
  }
}

/**
 * Build the full list of exact manager-selectable model rows from the shared catalog,
 * user-added OpenRouter models from the model-config response, overrides, and provider
 * availability. No second fetch/cache is required.
 */
export function buildManagerModelRows(
  surface: ManagerModelSurface,
  overrides: Record<string, ModelOverrideEntry>,
  providerAvailability: Record<string, boolean>,
  openRouterModels: readonly OpenRouterModelEntry[] = [],
): ManagerModelSelectRow[] {
  const addedOpenRouterModels = openRouterModels ?? []
  const rows: ManagerModelSelectRow[] = []

  for (const model of Object.values(FORGE_MODEL_CATALOG.models) as ForgeModelDefinition[]) {
    if (!isCatalogModelManagerSupported(model, surface)) continue

    const modelKey = getCatalogModelKey(model)
    const override = overrides[modelKey]
    if (!getEffectiveManagerEnabled(model, override, surface)) continue

    const provider = getCatalogProvider(model.provider)
    const family = getCatalogFamily(model.familyId)
    if (!provider || !family) continue

    // For managed-auth providers, require explicit availability confirmation.
    // Missing/undefined entries are treated as unavailable so that rows don't
    // appear selectable while the availability fetch is still pending or failed.
    const providerAvailable =
      provider.availabilityMode === 'external' ||
      providerAvailability[model.provider] === true

    const row: ManagerModelSelectRow = {
      key: encodeManagerModelValue(model.provider, model.modelId),
      provider: model.provider,
      providerDisplayName: provider.displayName,
      familyId: model.familyId,
      familyDisplayName: family.displayName,
      modelId: model.modelId,
      displayName: model.displayName,
      supportedReasoningLevels: model.supportedReasoningLevels as ManagerReasoningLevel[],
      defaultReasoningLevel: model.defaultReasoningLevel as ManagerReasoningLevel,
      ...(providerAvailable ? {} : { unavailableReason: 'Provider not configured' }),
    }

    rows.push(row)
  }

  const openRouterRows = addedOpenRouterModels
    .map((entry) => buildOpenRouterManagerRow(entry, overrides, providerAvailability, surface))
    .filter((row): row is ManagerModelSelectRow => row !== undefined)
    .sort((left, right) => left.displayName.localeCompare(right.displayName))

  rows.push(...openRouterRows)

  return rows
}

/**
 * Group rows by provider, preserving catalog order within each group.
 */
export function groupManagerModelRows(rows: ManagerModelSelectRow[]): ManagerModelProviderGroup[] {
  const map = new Map<string, ManagerModelProviderGroup>()

  for (const row of rows) {
    let group = map.get(row.provider)
    if (!group) {
      group = {
        provider: row.provider,
        providerDisplayName: row.providerDisplayName,
        rows: [],
      }
      map.set(row.provider, group)
    }

    group.rows.push(row)
  }

  return Array.from(map.values())
}

/**
 * Build a fallback row for a current model descriptor that isn't in the selectable list.
 * This prevents dialogs from silently switching away from a hidden/unavailable model.
 */
export function buildCurrentModelFallbackRow(
  provider: string,
  modelId: string,
  thinkingLevel?: string,
  openRouterModels: readonly OpenRouterModelEntry[] = [],
): ManagerModelSelectRow {
  const addedOpenRouterModels = openRouterModels ?? []
  const providerDef = getCatalogProvider(provider)
  const catalogModel = Object.values(FORGE_MODEL_CATALOG.models).find(
    (m) => m.provider === provider && m.modelId === modelId,
  ) as ForgeModelDefinition | undefined
  const family = catalogModel ? getCatalogFamily(catalogModel.familyId) : undefined
  const openRouterModel = provider === 'openrouter'
    ? findOpenRouterModelEntry(modelId, addedOpenRouterModels)
    : undefined

  return {
    key: encodeManagerModelValue(provider, modelId),
    provider,
    providerDisplayName: providerDef?.displayName ?? provider,
    familyId: catalogModel?.familyId ?? (openRouterModel ? OPENROUTER_FAMILY_ID : 'unknown'),
    familyDisplayName: family?.displayName ?? (openRouterModel ? (providerDef?.displayName ?? 'OpenRouter') : 'Other'),
    modelId,
    displayName: catalogModel?.displayName ?? openRouterModel?.displayName ?? modelId,
    supportedReasoningLevels: catalogModel
      ? (catalogModel.supportedReasoningLevels as ManagerReasoningLevel[])
      : openRouterModel
        ? ([...openRouterModel.supportedReasoningLevels] as ManagerReasoningLevel[])
        : GENERIC_REASONING_LEVELS,
    defaultReasoningLevel: openRouterModel
      ? getOpenRouterManagerDefaultReasoningLevel(openRouterModel) as ManagerReasoningLevel
      : ((thinkingLevel as ManagerReasoningLevel) ?? 'high'),
    unavailableReason: 'Not available for selection',
  }
}
