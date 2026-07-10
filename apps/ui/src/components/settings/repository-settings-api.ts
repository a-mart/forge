import type {
  GetRepositorySettingsResponse,
  RepositorySettings,
  UpdateRepositorySettingsResponse,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { createBuilderSettingsApiClient } from './settings-api-client'

const REPOSITORY_SETTINGS_PATH = '/api/settings/repositories'

function resolveClient(clientOrWsUrl: SettingsApiClient | string | undefined): SettingsApiClient {
  return typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
}

export async function fetchRepositorySettings(
  clientOrWsUrl: SettingsApiClient | string | undefined,
): Promise<RepositorySettings> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch(REPOSITORY_SETTINGS_PATH, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as GetRepositorySettingsResponse
  return payload.settings
}

export async function updateRepositorySettings(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  configuredHome: string | null,
): Promise<RepositorySettings> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch(REPOSITORY_SETTINGS_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configuredHome }),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as UpdateRepositorySettingsResponse
  return payload.settings
}
