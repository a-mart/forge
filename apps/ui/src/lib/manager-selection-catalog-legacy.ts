/**
 * Isolated old-server fallback for manager selection.
 *
 * DELETE THIS FILE when every supported Forge server advertises
 * GET /api/settings/manager-selection-catalog. Transient, auth, and decode
 * failures must never import this module.
 */

import {
  DEFAULT_MANAGER_POSTURE,
  MANAGER_SELECTION_CATALOG_VERSION,
  WORK_MODE_DEFINITIONS,
  type ManagerModelOption,
  type ManagerModelSurface,
  type ManagerSelectionCatalogResponse,
  type ModelOverrideEntry,
  type OpenRouterModelEntry,
} from '@forge/protocol'
import {
  buildManagerModelRows,
  type ManagerModelSelectRow,
} from '@/lib/manager-model-selection'

export const LEGACY_MANAGER_SELECTION_CATALOG_REVISION = 'legacy-client-reconstruction'

const SURFACES = ['create', 'change'] as const satisfies readonly ManagerModelSurface[]

export function reconstructLegacyManagerSelectionCatalog(input: {
  overrides: Record<string, ModelOverrideEntry>
  providerAvailability: Record<string, boolean>
  openRouterModels?: readonly OpenRouterModelEntry[]
}): ManagerSelectionCatalogResponse {
  const rowsBySurface = Object.fromEntries(
    SURFACES.map((surface) => [
      surface,
      buildManagerModelRows(
        surface,
        input.overrides,
        input.providerAvailability,
        input.openRouterModels,
      ),
    ]),
  ) as Record<ManagerModelSurface, ManagerModelSelectRow[]>
  const models = mergeLegacyModelOptions(rowsBySurface)
  const firstCreate = rowsBySurface.create.find((row) => !row.unavailableReason)

  return {
    version: MANAGER_SELECTION_CATALOG_VERSION,
    revision: LEGACY_MANAGER_SELECTION_CATALOG_REVISION,
    models,
    workModes: WORK_MODE_DEFINITIONS.map((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      selectable: definition.selectable,
    })),
    defaults: {
      ...(firstCreate
        ? {
            createManagerModel: {
              provider: firstCreate.provider,
              modelId: firstCreate.modelId,
              reasoningId: firstCreate.defaultReasoningLevel,
            },
          }
        : {}),
      workModeId: DEFAULT_MANAGER_POSTURE,
    },
  }
}

function mergeLegacyModelOptions(
  rowsBySurface: Record<ManagerModelSurface, ManagerModelSelectRow[]>,
): ManagerModelOption[] {
  const byKey = new Map<string, ManagerModelOption>()
  for (const surface of SURFACES) {
    for (const row of rowsBySurface[surface]) {
      const key = `${row.provider}\u0000${row.modelId}`
      const existing = byKey.get(key)
      const surfaceState = row.unavailableReason
        ? {
            selectable: false as const,
            unavailableReason: row.unavailableReason === 'Provider not configured'
              ? 'provider_not_configured' as const
              : 'disabled' as const,
          }
        : { selectable: true as const }
      if (existing) {
        existing.surfaces[surface] = surfaceState
        continue
      }
      byKey.set(key, {
        provider: row.provider,
        providerLabel: row.providerDisplayName,
        modelId: row.modelId,
        label: row.displayName,
        familyId: row.familyId,
        familyLabel: row.familyDisplayName,
        reasoningOptions: row.supportedReasoningLevels.map((id) => ({ id, label: id })),
        defaultReasoningId: row.defaultReasoningLevel,
        surfaces: { [surface]: surfaceState },
      })
    }
  }
  return [...byKey.values()]
}
