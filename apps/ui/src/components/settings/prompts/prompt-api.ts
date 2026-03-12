/* ------------------------------------------------------------------ */
/*  API client for /api/prompts/* endpoints                           */
/* ------------------------------------------------------------------ */

import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type {
  PromptCategory,
  PromptSourceLayer,
  PromptListEntry,
  PromptContentResponse,
} from '@middleman/protocol'

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch { /* ignore */ }
  try {
    const text = await response.text()
    if (text.trim().length > 0) return text
  } catch { /* ignore */ }
  return `Request failed (${response.status})`
}

export async function fetchPromptList(
  wsUrl: string | undefined,
  profileId?: string,
): Promise<PromptListEntry[]> {
  const params = profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''
  const endpoint = resolveApiEndpoint(wsUrl, `/api/prompts${params}`)
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const data = (await response.json()) as { prompts?: unknown }
  if (!data || !Array.isArray(data.prompts)) return []
  return data.prompts as PromptListEntry[]
}

export async function fetchPromptContent(
  wsUrl: string | undefined,
  category: PromptCategory,
  promptId: string,
  profileId?: string,
  layer?: PromptSourceLayer,
): Promise<PromptContentResponse> {
  const params = new URLSearchParams()
  if (profileId) params.set('profileId', profileId)
  if (layer) params.set('layer', layer)
  const qs = params.toString()
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/prompts/${encodeURIComponent(category)}/${encodeURIComponent(promptId)}${qs ? `?${qs}` : ''}`,
  )
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  return (await response.json()) as PromptContentResponse
}

export async function savePromptOverride(
  wsUrl: string | undefined,
  category: PromptCategory,
  promptId: string,
  content: string,
  profileId: string,
): Promise<void> {
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/prompts/${encodeURIComponent(category)}/${encodeURIComponent(promptId)}`,
  )
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, profileId }),
  })
  if (!response.ok) throw new Error(await readApiError(response))
}

export interface PromptPreviewResponse {
  content: string
  components: string[]
}

export async function fetchPromptPreview(
  wsUrl: string | undefined,
  profileId: string,
): Promise<PromptPreviewResponse> {
  const params = new URLSearchParams({ profileId })
  const endpoint = resolveApiEndpoint(wsUrl, `/api/prompts/preview?${params}`)
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  return (await response.json()) as PromptPreviewResponse
}

export async function deletePromptOverride(
  wsUrl: string | undefined,
  category: PromptCategory,
  promptId: string,
  profileId: string,
): Promise<void> {
  const params = new URLSearchParams({ profileId })
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/prompts/${encodeURIComponent(category)}/${encodeURIComponent(promptId)}?${params}`,
  )
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
}
