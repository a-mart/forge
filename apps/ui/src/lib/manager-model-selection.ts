import {
  FORGE_MODEL_CATALOG,
  getCatalogFamily,
  getCatalogModelKey,
  getCatalogProvider,
  getEffectiveManagerEnabled,
  isCatalogModelManagerSupported,
  type ForgeModelDefinition,
  type ManagerModelSurface,
  type ModelOverrideEntry,
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

/**
 * Build the full list of exact manager-selectable model rows from the shared catalog,
 * overrides, and provider availability. No server endpoint required.
 */
export function buildManagerModelRows(
  surface: ManagerModelSurface,
  overrides: Record<string, ModelOverrideEntry>,
  providerAvailability: Record<string, boolean>,
): ManagerModelSelectRow[] {
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
): ManagerModelSelectRow {
  const providerDef = getCatalogProvider(provider)
  const catalogModel = Object.values(FORGE_MODEL_CATALOG.models).find(
    (m) => m.provider === provider && m.modelId === modelId,
  ) as ForgeModelDefinition | undefined
  const family = catalogModel ? getCatalogFamily(catalogModel.familyId) : undefined

  return {
    key: encodeManagerModelValue(provider, modelId),
    provider,
    providerDisplayName: providerDef?.displayName ?? provider,
    familyId: catalogModel?.familyId ?? 'unknown',
    familyDisplayName: family?.displayName ?? 'Other',
    modelId,
    displayName: catalogModel?.displayName ?? modelId,
    supportedReasoningLevels: catalogModel
      ? (catalogModel.supportedReasoningLevels as ManagerReasoningLevel[])
      : (['none', 'low', 'medium', 'high', 'xhigh'] as ManagerReasoningLevel[]),
    defaultReasoningLevel: (thinkingLevel as ManagerReasoningLevel) ?? 'high',
    unavailableReason: 'Not available for selection',
  }
}
