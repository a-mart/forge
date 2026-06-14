import type { SettingsApiClient } from './settings-api-client'
import { createBuilderSettingsApiClient } from './settings-api-client'

const MODEL_CACHE_VISUALIZATION_ENABLED_PATH = '/api/settings/model-cache-visualization/enabled'

function resolveClient(clientOrWsUrl: SettingsApiClient | string | undefined): SettingsApiClient {
  return typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
}

export async function fetchModelCacheVisualizationEnabled(
  clientOrWsUrl: SettingsApiClient | string | undefined,
): Promise<boolean> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch(MODEL_CACHE_VISUALIZATION_ENABLED_PATH, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { enabled?: unknown }
  return typeof payload.enabled === 'boolean' ? payload.enabled : false
}

export async function setModelCacheVisualizationEnabledApi(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  enabled: boolean,
): Promise<void> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch(MODEL_CACHE_VISUALIZATION_ENABLED_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}
