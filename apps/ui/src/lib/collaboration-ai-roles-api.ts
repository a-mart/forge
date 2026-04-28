/**
 * Collaboration AI Roles API helpers.
 *
 * CRUD operations for AI role configuration, consumed by the Settings > AI Roles
 * panel. All endpoints target the collaboration backend (not the Builder backend).
 *
 * Endpoint prefix: /api/collaboration/ai-roles
 */

import type { AiRoleConfig, CloneAiRoleParams, CreateAiRoleParams, UpdateAiRoleParams } from './collaboration-ai-roles'
import { resolveCollaborationApiBaseUrl } from './collaboration-endpoints'

/* ------------------------------------------------------------------ */
/*  Generic fetcher (mirrors collaboration-settings-api pattern)      */
/* ------------------------------------------------------------------ */

function collabUrl(path: string): string {
  return new URL(path, resolveCollaborationApiBaseUrl()).toString()
}

/** Extended error with HTTP status for auth-error detection. */
export interface AiRolesApiError extends Error {
  status?: number
}

async function aiRolesFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null
  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  }

  const response = await fetch(collabUrl(path), {
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
    ;(err as AiRolesApiError).status = response.status
    throw err
  }

  if (response.status === 204) {
    return undefined as unknown as T
  }

  return (await response.json()) as T
}

export function isAiRolesAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const status = (err as AiRolesApiError).status
  return status === 401 || status === 403
}

/* ------------------------------------------------------------------ */
/*  Role listing                                                      */
/* ------------------------------------------------------------------ */

export interface FetchAiRolesResponse {
  roles: AiRoleConfig[]
  workspaceDefaultAiRoleId: string
  workspaceDefaultAiRole?: string
}

/** Fetch all AI roles (builtins + custom) along with workspace default. */
export async function fetchAiRoles(): Promise<FetchAiRolesResponse> {
  return aiRolesFetch<FetchAiRolesResponse>('/api/collaboration/ai-roles')
}

/* ------------------------------------------------------------------ */
/*  Role CRUD                                                         */
/* ------------------------------------------------------------------ */

/** Create a new custom AI role from scratch. */
export async function createAiRole(params: CreateAiRoleParams): Promise<AiRoleConfig> {
  const data = await aiRolesFetch<{ ok: true; role: AiRoleConfig }>(
    '/api/collaboration/ai-roles',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
  )
  return data.role
}

/** Clone an existing AI role to create a custom variant. */
export async function cloneAiRole(
  sourceRoleId: string,
  params: CloneAiRoleParams,
): Promise<AiRoleConfig> {
  const data = await aiRolesFetch<{ ok: true; role: AiRoleConfig }>(
    `/api/collaboration/ai-roles/${encodeURIComponent(sourceRoleId)}/clone`,
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
  )
  return data.role
}

/** Update an existing custom AI role. Builtins cannot be updated. */
export async function updateAiRole(
  roleId: string,
  params: UpdateAiRoleParams,
): Promise<AiRoleConfig> {
  const data = await aiRolesFetch<{ ok: true; role: AiRoleConfig }>(
    `/api/collaboration/ai-roles/${encodeURIComponent(roleId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(params),
    },
  )
  return data.role
}

/** Delete a custom AI role. Builtins cannot be deleted. */
export async function deleteAiRole(
  roleId: string,
  replacementRoleId?: string,
): Promise<{ deletedRoleId: string; replacementRoleId?: string }> {
  return aiRolesFetch<{ deletedRoleId: string; replacementRoleId?: string }>(
    `/api/collaboration/ai-roles/${encodeURIComponent(roleId)}`,
    {
      method: 'DELETE',
      body: JSON.stringify(replacementRoleId ? { replacementRoleId } : {}),
    },
  )
}

/* ------------------------------------------------------------------ */
/*  Workspace default                                                 */
/* ------------------------------------------------------------------ */

/** Update the workspace-level default AI role. */
export async function updateWorkspaceDefaultAiRole(
  defaultAiRoleId: string,
): Promise<{ role: AiRoleConfig; workspaceDefaultAiRoleId: string }> {
  return aiRolesFetch<{ ok: true; role: AiRoleConfig; workspaceDefaultAiRoleId: string }>(
    '/api/collaboration/ai-roles/workspace-default',
    {
      method: 'PATCH',
      body: JSON.stringify({ defaultAiRoleId }),
    },
  )
}

/* ------------------------------------------------------------------ */
/*  Role prompt preview                                               */
/* ------------------------------------------------------------------ */

/** Fetch the rendered prompt block for a given role. */
export async function fetchAiRolePromptPreview(
  roleId: string,
): Promise<{ role: AiRoleConfig; promptBlock: string }> {
  return aiRolesFetch<{ role: AiRoleConfig; promptBlock: string }>(
    `/api/collaboration/ai-roles/${encodeURIComponent(roleId)}/prompt-preview`,
  )
}
