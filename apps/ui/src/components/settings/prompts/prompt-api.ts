/* ------------------------------------------------------------------ */
/*  API client for /api/prompts/* endpoints                           */
/* ------------------------------------------------------------------ */

import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type {
  CortexPromptSurfaceContentResponse,
  CortexPromptSurfaceListResponse,
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

export interface PromptPreviewSection {
  label: string
  content: string
  source: string
}

export interface PromptPreviewResponse {
  sections: PromptPreviewSection[]
}

export async function fetchPromptPreview(
  wsUrl: string | undefined,
  profileId: string,
): Promise<PromptPreviewResponse> {
  const params = new URLSearchParams({ profileId })
  const endpoint = resolveApiEndpoint(wsUrl, `/api/prompts/preview?${params}`)
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))

  const data = (await response.json()) as { sections?: unknown }
  const sections = Array.isArray(data?.sections)
    ? data.sections
        .filter((section): section is PromptPreviewSection => {
          if (!section || typeof section !== 'object') return false
          const candidate = section as Partial<PromptPreviewSection>
          return (
            typeof candidate.label === 'string' &&
            typeof candidate.content === 'string' &&
            typeof candidate.source === 'string'
          )
        })
    : []

  return { sections }
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

export async function fetchCortexPromptSurfaceList(
  wsUrl: string | undefined,
  profileId: string,
): Promise<CortexPromptSurfaceListResponse> {
  const params = new URLSearchParams({ profileId })
  const endpoint = resolveApiEndpoint(wsUrl, `/api/prompts/cortex-surfaces?${params}`)
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))

  const data = (await response.json()) as Partial<CortexPromptSurfaceListResponse>
  return {
    enabled: data.enabled === true,
    surfaces: Array.isArray(data.surfaces) ? data.surfaces : [],
  }
}

export async function fetchCortexPromptSurfaceContent(
  wsUrl: string | undefined,
  surfaceId: string,
  profileId: string,
): Promise<CortexPromptSurfaceContentResponse> {
  const params = new URLSearchParams({ profileId })
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/prompts/cortex-surfaces/${encodeURIComponent(surfaceId)}?${params}`,
  )
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  return (await response.json()) as CortexPromptSurfaceContentResponse
}

export async function saveCortexPromptSurface(
  wsUrl: string | undefined,
  surfaceId: string,
  content: string,
  profileId: string,
): Promise<void> {
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/prompts/cortex-surfaces/${encodeURIComponent(surfaceId)}`,
  )
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, profileId }),
  })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function resetCortexPromptSurface(
  wsUrl: string | undefined,
  surfaceId: string,
  profileId: string,
): Promise<void> {
  const params = new URLSearchParams({ profileId })
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/prompts/cortex-surfaces/${encodeURIComponent(surfaceId)}/reset?${params}`,
  )
  const response = await fetch(endpoint, { method: 'POST' })
  if (!response.ok) throw new Error(await readApiError(response))
}
