/* ------------------------------------------------------------------ */
/*  Collaboration settings API helpers                                */
/*                                                                    */
/*  Every exported function accepts an optional `apiBaseUrl` as its   */
/*  last argument.  When provided the request targets that specific   */
/*  collaboration backend; when omitted, the default/last-active      */
/*  connection is used — preserving single-backend compatibility.     */
/* ------------------------------------------------------------------ */

import type {
  CollaborationCreatedInvite,
  CollaborationInvite,
  CollaborationRole,
  CollaborationSessionInfo,
  CollaborationStatus,
  CollaborationUser,
} from '@forge/protocol'
import { resolveCollaborationApiBaseUrl } from '@/lib/collaboration-endpoints'

// ---------------------------------------------------------------------------
// Generic fetcher
// ---------------------------------------------------------------------------

function collabUrl(path: string, baseUrl?: string): string {
  const base = baseUrl ?? resolveCollaborationApiBaseUrl()
  return new URL(path, base).toString()
}

async function collabFetch<T>(path: string, init?: RequestInit, baseUrl?: string): Promise<T> {
  // Only set Content-Type: application/json when there is a request body.
  // GET/DELETE-without-body requests should not send a content-type header.
  const hasBody = init?.body != null
  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  }

  const response = await fetch(collabUrl(path, baseUrl), {
    credentials: 'include',
    headers,
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
    const err = new Error(`${response.status}: ${errorMessage}`)
    ;(err as AuthApiError).status = response.status
    throw err
  }

  if (response.status === 204) {
    return undefined as unknown as T
  }

  return (await response.json()) as T
}

/** Extended error with HTTP status code for auth-error detection. */
export interface AuthApiError extends Error {
  status?: number
}

export function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const status = (err as AuthApiError).status
  return status === 401 || status === 403
}

// ---------------------------------------------------------------------------
// Collaboration status (used by existing status panel)
// ---------------------------------------------------------------------------

export async function fetchCollaborationStatus(apiBaseUrl?: string): Promise<CollaborationStatus> {
  return collabFetch<CollaborationStatus>('/api/collaboration/status', undefined, apiBaseUrl)
}

// ---------------------------------------------------------------------------
// Session / current user
// ---------------------------------------------------------------------------

export async function fetchCollaborationMe(apiBaseUrl?: string): Promise<CollaborationSessionInfo> {
  return collabFetch<CollaborationSessionInfo>('/api/collaboration/me', undefined, apiBaseUrl)
}

// ---------------------------------------------------------------------------
// Self password change
// ---------------------------------------------------------------------------

export async function changeMyPassword(
  currentPassword: string,
  newPassword: string,
  apiBaseUrl?: string,
): Promise<void> {
  return collabFetch<void>(
    '/api/collaboration/me/password',
    {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    },
    apiBaseUrl,
  )
}

// ---------------------------------------------------------------------------
// Admin: user management
// ---------------------------------------------------------------------------

export async function fetchCollaborationUsers(apiBaseUrl?: string, signal?: AbortSignal): Promise<CollaborationUser[]> {
  const data = await collabFetch<{ users: CollaborationUser[] }>('/api/collaboration/users', signal ? { signal } : undefined, apiBaseUrl)
  return data.users
}

export async function updateCollaborationUser(
  userId: string,
  params: { role?: CollaborationRole; disabled?: boolean; name?: string },
  apiBaseUrl?: string,
): Promise<CollaborationUser> {
  const data = await collabFetch<{ user: CollaborationUser }>(
    `/api/collaboration/users/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: JSON.stringify(params) },
    apiBaseUrl,
  )
  return data.user
}

export async function resetUserPassword(
  userId: string,
  temporaryPassword: string,
  apiBaseUrl?: string,
): Promise<void> {
  return collabFetch<void>(
    `/api/collaboration/users/${encodeURIComponent(userId)}/password-reset`,
    { method: 'POST', body: JSON.stringify({ temporaryPassword }) },
    apiBaseUrl,
  )
}

// ---------------------------------------------------------------------------
// Admin: invites
// ---------------------------------------------------------------------------

export async function fetchCollaborationInvites(apiBaseUrl?: string, signal?: AbortSignal): Promise<CollaborationInvite[]> {
  const data = await collabFetch<{ invites: CollaborationInvite[] }>('/api/collaboration/invites', signal ? { signal } : undefined, apiBaseUrl)
  return data.invites
}

export async function createCollaborationInvite(
  email: string,
  expiresInDays?: number,
  apiBaseUrl?: string,
): Promise<CollaborationCreatedInvite> {
  const data = await collabFetch<{ ok: true; invite: CollaborationCreatedInvite }>(
    '/api/collaboration/invites',
    {
      method: 'POST',
      body: JSON.stringify({ email, ...(expiresInDays != null ? { expiresInDays } : {}) }),
    },
    apiBaseUrl,
  )
  return data.invite
}

export async function revokeCollaborationInvite(inviteId: string, apiBaseUrl?: string): Promise<void> {
  return collabFetch<void>(
    `/api/collaboration/invites/${encodeURIComponent(inviteId)}`,
    { method: 'DELETE' },
    apiBaseUrl,
  )
}
