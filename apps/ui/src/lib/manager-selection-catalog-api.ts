import type {
  ApplyRecommendedManagerDefaultsResponse,
  ManagerSelectionCatalogResponse,
} from '@forge/protocol'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { resolveSettingsApiClient } from '@/components/settings/settings-api-client'
import { fetchModelOverrides } from '@/components/settings/models-api'
import { decodeManagerSelectionCatalog } from '@/lib/manager-selection-catalog'

export const MANAGER_SELECTION_CATALOG_PATH = '/api/settings/manager-selection-catalog'
export const RECOMMENDED_MANAGER_DEFAULTS_PATH = '/api/settings/recommended-manager-defaults'
const LOCAL_FIRST_CATALOG_ERROR = 'Failed to load models.'

export class ManagerSelectionCatalogRequestError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ManagerSelectionCatalogRequestError'
    this.status = status
  }
}

function isDefinitivelyUnsupportedCatalogStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501
}

export async function fetchManagerSelectionCatalog(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  init?: RequestInit,
): Promise<ManagerSelectionCatalogResponse> {
  const client = resolveSettingsApiClient(clientOrWsUrl)
  let response: Response
  try {
    response = await client.fetch(MANAGER_SELECTION_CATALOG_PATH, { ...init, cache: 'no-store' })
  } catch (error) {
    throw new ManagerSelectionCatalogRequestError(
      error instanceof Error ? error.message : LOCAL_FIRST_CATALOG_ERROR,
    )
  }

  if (response.ok) {
    return decodeManagerSelectionCatalog(await response.json())
  }

  // Product compatibility only: a missing route on an older server may
  // reconstruct from the previous model-config payload. Auth, 5xx, and
  // network failures stay local-first and never activate that path.
  if (isDefinitivelyUnsupportedCatalogStatus(response.status)) {
    const [{ reconstructLegacyManagerSelectionCatalog }, overrides] = await Promise.all([
      import('@/lib/manager-selection-catalog-legacy'),
      fetchModelOverrides(client, init),
    ])
    return reconstructLegacyManagerSelectionCatalog({
      overrides: overrides.overrides,
      providerAvailability: overrides.providerAvailability,
      openRouterModels: overrides.openRouterModels,
    })
  }

  throw new ManagerSelectionCatalogRequestError(LOCAL_FIRST_CATALOG_ERROR, response.status)
}

export async function applyRecommendedManagerDefaults(
  clientOrWsUrl: SettingsApiClient | string | undefined,
): Promise<ApplyRecommendedManagerDefaultsResponse> {
  const client = resolveSettingsApiClient(clientOrWsUrl)
  return client.fetchJson<ApplyRecommendedManagerDefaultsResponse>(
    RECOMMENDED_MANAGER_DEFAULTS_PATH,
    { method: 'POST' },
  )
}
