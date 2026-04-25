/* ------------------------------------------------------------------ */
/*  Collaboration settings API helpers                                */
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

function collabUrl(path: string): string {
  return new URL(path, resolveCollaborationApiBaseUrl()).toString()
}

async function collabFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(collabUrl(path), {
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

export async function fetchCollaborationStatus(): Promise<CollaborationStatus> {
  return collabFetch<CollaborationStatus>('/api/collaboration/status')
}

// ---------------------------------------------------------------------------
// Session / current user
// ---------------------------------------------------------------------------

export async function fetchCollaborationMe(): Promise<CollaborationSessionInfo> {
  return collabFetch<CollaborationSessionInfo>('/api/collaboration/me')
}

// ---------------------------------------------------------------------------
// Self password change
// ---------------------------------------------------------------------------

export async function changeMyPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  return collabFetch<void>('/api/collaboration/me/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

// ---------------------------------------------------------------------------
// Admin: user management
// ---------------------------------------------------------------------------

export async function fetchCollaborationUsers(): Promise<CollaborationUser[]> {
  const data = await collabFetch<{ users: CollaborationUser[] }>('/api/collaboration/users')
  return data.users
}

export async function updateCollaborationUser(
  userId: string,
  params: { role?: CollaborationRole; disabled?: boolean; name?: string },
): Promise<CollaborationUser> {
  const data = await collabFetch<{ user: CollaborationUser }>(
    `/api/collaboration/users/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: JSON.stringify(params) },
  )
  return data.user
}

export async function resetUserPassword(
  userId: string,
  temporaryPassword: string,
): Promise<void> {
  return collabFetch<void>(
    `/api/collaboration/users/${encodeURIComponent(userId)}/password-reset`,
    { method: 'POST', body: JSON.stringify({ temporaryPassword }) },
  )
}

// ---------------------------------------------------------------------------
// Admin: invites
// ---------------------------------------------------------------------------

export async function fetchCollaborationInvites(): Promise<CollaborationInvite[]> {
  const data = await collabFetch<{ invites: CollaborationInvite[] }>('/api/collaboration/invites')
  return data.invites
}

export async function createCollaborationInvite(
  email: string,
  expiresInDays?: number,
): Promise<CollaborationCreatedInvite> {
  const data = await collabFetch<{ ok: true; invite: CollaborationCreatedInvite }>(
    '/api/collaboration/invites',
    {
      method: 'POST',
      body: JSON.stringify({ email, ...(expiresInDays != null ? { expiresInDays } : {}) }),
    },
  )
  return data.invite
}

export async function revokeCollaborationInvite(inviteId: string): Promise<void> {
  return collabFetch<void>(
    `/api/collaboration/invites/${encodeURIComponent(inviteId)}`,
    { method: 'DELETE' },
  )
}
