import type { ModelOverrideEntry } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { createBuilderSettingsApiClient } from './settings-api-client'

export interface ModelOverridePatch {
  enabled?: boolean | null
  contextWindowCap?: number | null
  modelSpecificInstructions?: string | null
}

export interface ModelOverridesResponse {
  version: number
  overrides: Record<string, ModelOverrideEntry>
  providerAvailability: Record<string, boolean>
}

export async function fetchModelOverrides(clientOrWsUrl: SettingsApiClient | string | undefined): Promise<ModelOverridesResponse> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const response = await client.fetch('/api/settings/model-overrides', { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))

  const data = (await response.json()) as Partial<ModelOverridesResponse>
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    overrides: data.overrides && typeof data.overrides === 'object' ? data.overrides : {},
    providerAvailability:
      data.providerAvailability && typeof data.providerAvailability === 'object'
        ? data.providerAvailability
        : {},
  }
}

export async function updateModelOverride(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  modelId: string,
  patch: ModelOverridePatch,
): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const response = await client.fetch(`/api/settings/model-overrides/${encodeURIComponent(modelId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function deleteModelOverride(clientOrWsUrl: SettingsApiClient | string | undefined, modelId: string): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const response = await client.fetch(`/api/settings/model-overrides/${encodeURIComponent(modelId)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function resetAllModelOverrides(clientOrWsUrl: SettingsApiClient | string | undefined): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const response = await client.fetch('/api/settings/model-overrides', { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}
