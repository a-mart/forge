import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { ModelOverrideEntry } from '@forge/protocol'

export interface ModelOverridePatch {
  enabled?: boolean | null
  contextWindowCap?: number | null
}

export interface ModelOverridesResponse {
  version: number
  overrides: Record<string, ModelOverrideEntry>
  providerAvailability: Record<string, boolean>
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch {
    // ignore
  }

  try {
    const text = await response.text()
    if (text.trim().length > 0) return text
  } catch {
    // ignore
  }

  return `Request failed (${response.status})`
}

export async function fetchModelOverrides(wsUrl: string | undefined): Promise<ModelOverridesResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/model-overrides')
  const response = await fetch(endpoint, { cache: 'no-store' })
  if (!response.ok) throw new Error(await readApiError(response))

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
  wsUrl: string | undefined,
  modelId: string,
  patch: ModelOverridePatch,
): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/model-overrides/${encodeURIComponent(modelId)}`)
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function deleteModelOverride(wsUrl: string | undefined, modelId: string): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/model-overrides/${encodeURIComponent(modelId)}`)
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function resetAllModelOverrides(wsUrl: string | undefined): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/model-overrides')
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
}
