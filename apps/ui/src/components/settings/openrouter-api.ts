import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { AvailableOpenRouterModel, OpenRouterModelEntry } from '@forge/protocol'

export type { AvailableOpenRouterModel }

export interface OpenRouterModelsResponse {
  models: OpenRouterModelEntry[]
  isConfigured: boolean
}

async function readApiError(response: Response): Promise<string> {
  let text = ''

  try {
    text = await response.text()
  } catch {
    // ignore
  }

  if (text.trim()) {
    try {
      const payload = JSON.parse(text) as { error?: unknown; message?: unknown }
      if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
      if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
    } catch {
      // ignore
    }

    return text
  }

  return `Request failed (${response.status})`
}

export async function fetchOpenRouterModels(wsUrl: string | undefined): Promise<OpenRouterModelsResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/openrouter/models')
  const response = await fetch(endpoint, { cache: 'no-store' })
  if (!response.ok) throw new Error(await readApiError(response))

  const data = (await response.json()) as Partial<OpenRouterModelsResponse>
  return {
    models: Array.isArray(data.models) ? data.models : [],
    isConfigured: typeof data.isConfigured === 'boolean' ? data.isConfigured : false,
  }
}

export async function fetchAvailableOpenRouterModels(wsUrl: string | undefined): Promise<AvailableOpenRouterModel[]> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/openrouter/available-models')
  const response = await fetch(endpoint, { cache: 'no-store' })
  if (!response.ok) throw new Error(await readApiError(response))

  const data = (await response.json()) as { models?: unknown }
  return Array.isArray(data.models) ? data.models : []
}

export async function addOpenRouterModel(
  wsUrl: string | undefined,
  model: AvailableOpenRouterModel,
): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/openrouter/models/${encodeURIComponent(model.modelId)}`)
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function removeOpenRouterModel(wsUrl: string | undefined, modelId: string): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/openrouter/models/${encodeURIComponent(modelId)}`)
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
}
