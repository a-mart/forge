import type {
  CortexAutoReviewSettings,
  UpdateCortexAutoReviewSettingsRequest,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { createBuilderSettingsApiClient } from './settings-api-client'

export interface CortexAutoReviewSettingsResponse {
  settings: CortexAutoReviewSettings
  cortexDisabled?: boolean
}

function resolveClient(clientOrWsUrl: SettingsApiClient | string): SettingsApiClient {
  return typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
}

export async function fetchCortexAutoReviewSettings(
  clientOrWsUrl: SettingsApiClient | string,
): Promise<CortexAutoReviewSettingsResponse> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch('/api/settings/cortex-auto-review')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as Partial<CortexAutoReviewSettingsResponse>
  if (!payload?.settings) throw new Error('Invalid Cortex auto-review settings response from backend.')
  return payload as CortexAutoReviewSettingsResponse
}

export async function updateCortexAutoReviewSettings(
  clientOrWsUrl: SettingsApiClient | string,
  patch: UpdateCortexAutoReviewSettingsRequest,
): Promise<CortexAutoReviewSettings> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch('/api/settings/cortex-auto-review', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { ok?: boolean; settings?: CortexAutoReviewSettings }
  if (!payload?.settings) throw new Error('Invalid Cortex auto-review settings update response from backend.')
  return payload.settings
}
