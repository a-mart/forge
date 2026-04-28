/* ------------------------------------------------------------------ */
/*  API client for /api/prompts/* endpoints                           */
/* ------------------------------------------------------------------ */

import type {
  CortexPromptSurfaceContentResponse,
  CortexPromptSurfaceListResponse,
  PromptCategory,
  PromptContentResponse,
  PromptListEntry,
  PromptPreviewResponse,
  PromptPreviewSection,
  PromptSourceLayer,
} from '@forge/protocol'
import type { SettingsApiClient } from '../settings-api-client'
import { createBuilderSettingsApiClient } from '../settings-api-client'

export async function fetchPromptList(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  profileId?: string,
): Promise<PromptListEntry[]> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const params = profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''
  const response = await client.fetch(`/api/prompts${params}`)
  if (!response.ok) throw new Error(await client.readApiError(response))
  const data = (await response.json()) as { prompts?: unknown }
  if (!data || !Array.isArray(data.prompts)) return []
  return data.prompts as PromptListEntry[]
}

export async function fetchPromptContent(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  category: PromptCategory,
  promptId: string,
  profileId?: string,
  layer?: PromptSourceLayer,
): Promise<PromptContentResponse> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const params = new URLSearchParams()
  if (profileId) params.set('profileId', profileId)
  if (layer) params.set('layer', layer)
  const qs = params.toString()
  const response = await client.fetch(
    `/api/prompts/${encodeURIComponent(category)}/${encodeURIComponent(promptId)}${qs ? `?${qs}` : ''}`,
  )
  if (!response.ok) throw new Error(await client.readApiError(response))
  return (await response.json()) as PromptContentResponse
}

export async function savePromptOverride(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  category: PromptCategory,
  promptId: string,
  content: string,
  profileId: string,
): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const response = await client.fetch(
    `/api/prompts/${encodeURIComponent(category)}/${encodeURIComponent(promptId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, profileId }),
    },
  )
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export type { PromptPreviewResponse, PromptPreviewSection } from '@forge/protocol'

export async function fetchPromptPreview(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  profileId: string,
  agentId?: string,
): Promise<PromptPreviewResponse> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const params = new URLSearchParams({ profileId })
  if (agentId) params.set('agentId', agentId)
  const response = await client.fetch(`/api/prompts/preview?${params}`)
  if (!response.ok) throw new Error(await client.readApiError(response))

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
  clientOrWsUrl: SettingsApiClient | string | undefined,
  category: PromptCategory,
  promptId: string,
  profileId: string,
): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const params = new URLSearchParams({ profileId })
  const response = await client.fetch(
    `/api/prompts/${encodeURIComponent(category)}/${encodeURIComponent(promptId)}?${params}`,
    { method: 'DELETE' },
  )
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function fetchCortexPromptSurfaceList(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  profileId: string,
): Promise<CortexPromptSurfaceListResponse> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const params = new URLSearchParams({ profileId })
  const response = await client.fetch(`/api/prompts/cortex-surfaces?${params}`)
  if (!response.ok) throw new Error(await client.readApiError(response))

  const data = (await response.json()) as Partial<CortexPromptSurfaceListResponse>
  return {
    enabled: data.enabled === true,
    surfaces: Array.isArray(data.surfaces) ? data.surfaces : [],
  }
}

export async function fetchCortexPromptSurfaceContent(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  surfaceId: string,
  profileId: string,
): Promise<CortexPromptSurfaceContentResponse> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const params = new URLSearchParams({ profileId })
  const response = await client.fetch(
    `/api/prompts/cortex-surfaces/${encodeURIComponent(surfaceId)}?${params}`,
  )
  if (!response.ok) throw new Error(await client.readApiError(response))
  return (await response.json()) as CortexPromptSurfaceContentResponse
}

export async function saveCortexPromptSurface(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  surfaceId: string,
  content: string,
  profileId: string,
): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const response = await client.fetch(
    `/api/prompts/cortex-surfaces/${encodeURIComponent(surfaceId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, profileId }),
    },
  )
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function resetCortexPromptSurface(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  surfaceId: string,
  profileId: string,
): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
  const params = new URLSearchParams({ profileId })
  const response = await client.fetch(
    `/api/prompts/cortex-surfaces/${encodeURIComponent(surfaceId)}/reset?${params}`,
    { method: 'POST' },
  )
  if (!response.ok) throw new Error(await client.readApiError(response))
}
