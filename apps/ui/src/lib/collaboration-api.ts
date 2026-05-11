/**
 * Collab HTTP API helper — admin CRUD for channels and categories.
 *
 * All mutations go through REST; the collab WS client receives the resulting
 * fanout events to reconcile local state across all connected clients.
 *
 * ## Target-aware API
 *
 * Every exported function accepts an optional `apiBaseUrl` parameter as its
 * **last** argument.  When provided, the request targets that specific
 * collaboration backend.  When omitted, the default/last-active connection
 * is resolved via `resolveCollaborationApiBaseUrl()` — preserving
 * backward-compatibility for single-backend callers.
 */

import type {
  CollaborationCategory,
  CollaborationChannel,
  CollaborationChannelPromptPreviewResponse,
} from '@forge/protocol'
import { resolveCollaborationApiBaseUrl } from './collaboration-endpoints'

function apiUrl(path: string, baseUrl?: string): string {
  const base = baseUrl ?? resolveCollaborationApiBaseUrl()
  return new URL(path, base).toString()
}

async function apiFetch<T>(path: string, init?: RequestInit, baseUrl?: string): Promise<T> {
  const response = await fetch(apiUrl(path, baseUrl), {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
    ...init,
  })

  if (!response.ok) {
    let errorMessage: string
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      errorMessage = body.error ?? body.message ?? response.statusText
    } catch {
      errorMessage = response.statusText
    }
    throw new Error(`${response.status}: ${errorMessage}`)
  }

  if (response.status === 204) {
    return undefined as unknown as T
  }

  return (await response.json()) as T
}

export async function getChannel(channelId: string, apiBaseUrl?: string): Promise<CollaborationChannel> {
  const response = await apiFetch<{ channel: CollaborationChannel }>(
    `/api/collaboration/channels/${encodeURIComponent(channelId)}`,
    undefined,
    apiBaseUrl,
  )
  return response.channel
}

export function fetchChannelPromptPreview(channelId: string, apiBaseUrl?: string): Promise<CollaborationChannelPromptPreviewResponse> {
  return apiFetch<CollaborationChannelPromptPreviewResponse>(
    `/api/collaboration/channels/${encodeURIComponent(channelId)}/prompt-preview`,
    undefined,
    apiBaseUrl,
  )
}

export async function createChannel(
  params: {
    name: string
    categoryId?: string
    description?: string
    aiEnabled?: boolean
  },
  apiBaseUrl?: string,
): Promise<CollaborationChannel> {
  const response = await apiFetch<{ ok: true; channel: CollaborationChannel }>(
    '/api/collaboration/channels',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
    apiBaseUrl,
  )
  return response.channel
}

export async function updateChannel(
  channelId: string,
  params: {
    name?: string
    description?: string | null
    categoryId?: string | null
    aiEnabled?: boolean
    modelId?: string
    reasoningLevel?: string
    promptOverlay?: string | null
  },
  apiBaseUrl?: string,
): Promise<CollaborationChannel> {
  const response = await apiFetch<{ ok: true; channel: CollaborationChannel }>(
    `/api/collaboration/channels/${encodeURIComponent(channelId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(params),
    },
    apiBaseUrl,
  )
  return response.channel
}

export function archiveChannel(channelId: string, apiBaseUrl?: string): Promise<void> {
  return apiFetch<void>(
    `/api/collaboration/channels/${encodeURIComponent(channelId)}/archive`,
    { method: 'POST' },
    apiBaseUrl,
  )
}

export function reorderChannels(channelIds: string[], apiBaseUrl?: string): Promise<void> {
  return apiFetch<void>(
    '/api/collaboration/channels/reorder',
    {
      method: 'POST',
      body: JSON.stringify({ channelIds }),
    },
    apiBaseUrl,
  )
}

export async function createCategory(
  params: {
    name: string
    channelCreationDefaults?: CollaborationCategory['channelCreationDefaults'] | null
    defaultModelId?: string | null
    defaultSelectedSpecialistHandles?: string[]
  },
  apiBaseUrl?: string,
): Promise<CollaborationCategory> {
  const response = await apiFetch<{ ok: true; category: CollaborationCategory }>(
    '/api/collaboration/categories',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
    apiBaseUrl,
  )
  return response.category
}

export async function updateCategory(
  categoryId: string,
  params: {
    name?: string
    channelCreationDefaults?: CollaborationCategory['channelCreationDefaults'] | null
    defaultModelId?: string | null
    defaultSelectedSpecialistHandles?: string[]
  },
  apiBaseUrl?: string,
): Promise<CollaborationCategory> {
  const response = await apiFetch<{ ok: true; category: CollaborationCategory }>(
    `/api/collaboration/categories/${encodeURIComponent(categoryId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(params),
    },
    apiBaseUrl,
  )
  return response.category
}

export function deleteCategory(categoryId: string, apiBaseUrl?: string): Promise<void> {
  return apiFetch<void>(
    `/api/collaboration/categories/${encodeURIComponent(categoryId)}`,
    { method: 'DELETE' },
    apiBaseUrl,
  )
}

export function reorderCategories(categoryIds: string[], apiBaseUrl?: string): Promise<void> {
  return apiFetch<void>(
    '/api/collaboration/categories/reorder',
    {
      method: 'POST',
      body: JSON.stringify({ categoryIds }),
    },
    apiBaseUrl,
  )
}
