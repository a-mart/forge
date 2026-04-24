import type { AvailableOpenRouterModel, OpenRouterModelEntry } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { createBuilderSettingsApiClient } from './settings-api-client'

export type { AvailableOpenRouterModel }

export interface OpenRouterModelsResponse {
  models: OpenRouterModelEntry[]
  isConfigured: boolean
}

export async function fetchOpenRouterModels(clientOrWsUrl: SettingsApiClient | string | undefined): Promise<OpenRouterModelsResponse> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const response = await client.fetch('/api/settings/openrouter/models', { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))

  const data = (await response.json()) as Partial<OpenRouterModelsResponse>
  return {
    models: Array.isArray(data.models) ? data.models : [],
    isConfigured: typeof data.isConfigured === 'boolean' ? data.isConfigured : false,
  }
}

export async function fetchAvailableOpenRouterModels(clientOrWsUrl: SettingsApiClient | string | undefined): Promise<AvailableOpenRouterModel[]> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const response = await client.fetch('/api/settings/openrouter/available-models', { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))

  const data = (await response.json()) as { models?: unknown }
  return Array.isArray(data.models) ? data.models : []
}

export async function addOpenRouterModel(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  model: AvailableOpenRouterModel,
): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const response = await client.fetch(`/api/settings/openrouter/models/${encodeURIComponent(model.modelId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function removeOpenRouterModel(clientOrWsUrl: SettingsApiClient | string | undefined, modelId: string): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const response = await client.fetch(`/api/settings/openrouter/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}
