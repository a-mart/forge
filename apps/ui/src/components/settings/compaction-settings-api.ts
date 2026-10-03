import type {
  GetCompactionSettingsResponse,
  UpdateCompactionSettingsRequest,
  UpdateCompactionSettingsResponse,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { resolveSettingsApiClient } from './settings-api-client'

export async function fetchCompactionSettings(
  clientOrWsUrl: SettingsApiClient | string | undefined,
): Promise<GetCompactionSettingsResponse> {
  const client = resolveSettingsApiClient(clientOrWsUrl)
  const response = await client.fetch('/api/settings/compaction', { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }
  return await response.json() as GetCompactionSettingsResponse
}

export async function updateCompactionSettings(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  patch: UpdateCompactionSettingsRequest,
): Promise<UpdateCompactionSettingsResponse> {
  const client = resolveSettingsApiClient(clientOrWsUrl)
  const response = await client.fetch('/api/settings/compaction', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }
  return await response.json() as UpdateCompactionSettingsResponse
}
