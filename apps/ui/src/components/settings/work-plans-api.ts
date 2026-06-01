import type { SettingsApiClient } from './settings-api-client'
import { createBuilderSettingsApiClient } from './settings-api-client'

const WORK_PLANS_ENABLED_PATH = '/api/settings/work-plans/enabled'

function resolveClient(clientOrWsUrl: SettingsApiClient | string | undefined): SettingsApiClient {
  return typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
}

export async function fetchWorkPlansEnabled(
  clientOrWsUrl: SettingsApiClient | string | undefined,
): Promise<boolean> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch(WORK_PLANS_ENABLED_PATH, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { enabled?: unknown }
  return typeof payload.enabled === 'boolean' ? payload.enabled : true
}

export async function setWorkPlansEnabledApi(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  enabled: boolean,
): Promise<void> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch(WORK_PLANS_ENABLED_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}
