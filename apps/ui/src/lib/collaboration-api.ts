/**
 * Collab HTTP API helper — admin CRUD for channels and categories.
 *
 * All mutations go through REST; the collab WS client receives the resulting
 * fanout events to reconcile local state across all connected clients.
 */

import type {
  CollaborationAiRole,
  CollaborationCategory,
  CollaborationChannel,
} from '@forge/protocol'
import { resolveCollaborationApiBaseUrl } from './collaboration-endpoints'

function apiUrl(path: string): string {
  return new URL(path, resolveCollaborationApiBaseUrl()).toString()
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
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

export async function getChannel(channelId: string): Promise<CollaborationChannel> {
  const response = await apiFetch<{ channel: CollaborationChannel }>(`/api/collaboration/channels/${encodeURIComponent(channelId)}`)
  return response.channel
}

export async function createChannel(
  params: {
    name: string
    categoryId?: string
    description?: string
    aiEnabled?: boolean
    aiRole?: CollaborationAiRole
  },
): Promise<CollaborationChannel> {
  const response = await apiFetch<{ ok: true; channel: CollaborationChannel }>(
    '/api/collaboration/channels',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
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
    aiRole?: CollaborationAiRole
    promptOverlay?: string | null
  },
): Promise<CollaborationChannel> {
  const response = await apiFetch<{ ok: true; channel: CollaborationChannel }>(`/api/collaboration/channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    body: JSON.stringify(params),
  })
  return response.channel
}

export function archiveChannel(channelId: string): Promise<void> {
  return apiFetch<void>(`/api/collaboration/channels/${encodeURIComponent(channelId)}/archive`, {
    method: 'POST',
  })
}

export function reorderChannels(channelIds: string[]): Promise<void> {
  return apiFetch<void>(
    '/api/collaboration/channels/reorder',
    {
      method: 'POST',
      body: JSON.stringify({ channelIds }),
    },
  )
}

export async function createCategory(
  params: { name: string; defaultModelId?: string | null; defaultAiRole?: CollaborationAiRole },
): Promise<CollaborationCategory> {
  const response = await apiFetch<{ ok: true; category: CollaborationCategory }>(
    '/api/collaboration/categories',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
  )
  return response.category
}

export async function updateCategory(
  categoryId: string,
  params: { name?: string; defaultModelId?: string | null; defaultAiRole?: CollaborationAiRole },
): Promise<CollaborationCategory> {
  const response = await apiFetch<{ ok: true; category: CollaborationCategory }>(`/api/collaboration/categories/${encodeURIComponent(categoryId)}`, {
    method: 'PATCH',
    body: JSON.stringify(params),
  })
  return response.category
}

export function deleteCategory(categoryId: string): Promise<void> {
  return apiFetch<void>(`/api/collaboration/categories/${encodeURIComponent(categoryId)}`, {
    method: 'DELETE',
  })
}

export function reorderCategories(categoryIds: string[]): Promise<void> {
  return apiFetch<void>(
    '/api/collaboration/categories/reorder',
    {
      method: 'POST',
      body: JSON.stringify({ categoryIds }),
    },
  )
}
