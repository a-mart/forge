import type { OpenRouterEndpointsResponse, OpenRouterRoutingConfig, OpenRouterRoutingSettingsResponse } from '@forge/protocol'
import { createBuilderSettingsApiClient, type SettingsApiClient } from './settings-api-client'

type Client = SettingsApiClient | string | undefined
const clientFor = (client: Client) => typeof client === 'object' ? client : createBuilderSettingsApiClient(client ?? '')
const routingPath = (modelId?: string) => `/api/settings/openrouter/routing${modelId ? `/models/${encodeURIComponent(modelId)}` : ''}`

export function fetchOpenRouterRouting(client: Client, modelId?: string): Promise<OpenRouterRoutingSettingsResponse> {
  return clientFor(client).fetchJson(routingPath(modelId), { cache: 'no-store' })
}

export async function saveOpenRouterRouting(client: Client, modelId: string | undefined, revision: string, routing: OpenRouterRoutingConfig): Promise<OpenRouterRoutingSettingsResponse> {
  const api = clientFor(client)
  const response = await api.fetch(routingPath(modelId), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, routing }),
  })
  if (!response.ok) {
    if (response.status === 409) throw new Error('Routing changed elsewhere. Reload settings and review before saving again.')
    throw new Error(await api.readApiError(response))
  }
  return response.json()
}

export function fetchOpenRouterEndpoints(client: Client, modelId: string, refresh = false): Promise<OpenRouterEndpointsResponse> {
  return clientFor(client).fetchJson(`/api/settings/openrouter/endpoints/${encodeURIComponent(modelId)}${refresh ? '?refresh=true' : ''}`, { cache: 'no-store' })
}
