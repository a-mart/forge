import type { ManagerSelectionCatalogResponse } from '@forge/protocol'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { createBuilderSettingsApiClient } from '@/components/settings/settings-api-client'
import { fetchModelOverrides } from '@/components/settings/models-api'
import { decodeManagerSelectionCatalog } from '@/lib/manager-selection-catalog'

export const MANAGER_SELECTION_CATALOG_PATH = '/api/settings/manager-selection-catalog'
const LOCAL_FIRST_CATALOG_ERROR = 'Failed to load models.'

export class ManagerSelectionCatalogRequestError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ManagerSelectionCatalogRequestError'
    this.status = status
  }
}

function resolveClient(clientOrWsUrl: SettingsApiClient | string | undefined): SettingsApiClient {
  return typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
}

function isDefinitivelyUnsupportedCatalogStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501
}

export async function fetchManagerSelectionCatalog(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  init?: RequestInit,
): Promise<ManagerSelectionCatalogResponse> {
  const client = resolveClient(clientOrWsUrl)
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
