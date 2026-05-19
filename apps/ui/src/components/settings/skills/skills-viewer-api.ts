/* ------------------------------------------------------------------ */
/*  API helpers for the Skills Viewer                                 */
/* ------------------------------------------------------------------ */

import type {
  SkillFileContentResponse,
  SkillFilesResponse,
  SkillImportPreviewResponse,
  SkillImportPreviewUrlRequest,
  SkillImportRequest,
  SkillImportResultResponse,
  SkillInventoryEntry,
  SkillInventoryResponse,
  SkillShareResponse,
} from '@forge/protocol'
import type { SettingsApiClient } from '../settings-api-client'
import { createBuilderSettingsApiClient } from '../settings-api-client'

const SKILLS_FETCH_OPTIONS = { cache: 'no-store' } as const

function resolveClient(clientOrWsUrl: SettingsApiClient | string): SettingsApiClient {
  return typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
}

/* ------------------------------------------------------------------ */
/*  Skill inventory                                                   */
/* ------------------------------------------------------------------ */

export interface SkillWorkspaceRequestContext {
  profileId?: string
  sessionAgentId?: string
}

function appendSkillContext(path: string, context?: SkillWorkspaceRequestContext): string {
  const params = new URLSearchParams()
  if (context?.profileId) params.set('profileId', context.profileId)
  if (context?.sessionAgentId) params.set('sessionAgentId', context.sessionAgentId)
  const query = params.toString()
  return query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path
}

export async function fetchSkillInventory(
  clientOrWsUrl: SettingsApiClient | string,
  profileId?: string,
  sessionAgentId?: string,
): Promise<SkillInventoryEntry[]> {
  const client = resolveClient(clientOrWsUrl)
  const path = appendSkillContext('/api/settings/skills', { profileId, sessionAgentId })
  const response = await client.fetch(path, SKILLS_FETCH_OPTIONS)
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as Partial<SkillInventoryResponse>
  if (!payload || !Array.isArray(payload.skills)) return []
  return payload.skills as SkillInventoryEntry[]
}

/* ------------------------------------------------------------------ */
/*  Skill files                                                       */
/* ------------------------------------------------------------------ */

export async function fetchSkillFiles(
  clientOrWsUrl: SettingsApiClient | string,
  skillId: string,
  relativePath = '',
  context?: SkillWorkspaceRequestContext,
): Promise<SkillFilesResponse> {
  const client = resolveClient(clientOrWsUrl)
  const basePath = `/api/settings/skills/${encodeURIComponent(skillId)}/files`
  const path = appendSkillContext(
    relativePath ? `${basePath}?path=${encodeURIComponent(relativePath)}` : basePath,
    context,
  )
  const response = await client.fetch(path, SKILLS_FETCH_OPTIONS)
  if (!response.ok) throw new Error(await client.readApiError(response))
  return (await response.json()) as SkillFilesResponse
}

/* ------------------------------------------------------------------ */
/*  Skill file content                                                */
/* ------------------------------------------------------------------ */

export async function fetchSkillFileContent(
  clientOrWsUrl: SettingsApiClient | string,
  skillId: string,
  relativePath: string,
  context?: SkillWorkspaceRequestContext,
): Promise<SkillFileContentResponse> {
  const client = resolveClient(clientOrWsUrl)
  const basePath = `/api/settings/skills/${encodeURIComponent(skillId)}/content`
  const path = appendSkillContext(`${basePath}?path=${encodeURIComponent(relativePath)}`, context)
  const response = await client.fetch(path, SKILLS_FETCH_OPTIONS)
  if (!response.ok) throw new Error(await client.readApiError(response))
  return (await response.json()) as SkillFileContentResponse
}

/* ------------------------------------------------------------------ */
/*  Skill sharing                                                     */
/* ------------------------------------------------------------------ */

export async function shareSkill(
  clientOrWsUrl: SettingsApiClient | string,
  skillId: string,
): Promise<SkillShareResponse> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch(`/api/settings/skills/${encodeURIComponent(skillId)}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  return (await response.json()) as SkillShareResponse
}

export async function previewSkillImportFromUrl(
  clientOrWsUrl: SettingsApiClient | string,
  request: SkillImportPreviewUrlRequest,
): Promise<SkillImportPreviewResponse> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch('/api/settings/skills/import/preview-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  return (await response.json()) as SkillImportPreviewResponse
}

export async function importSkill(
  clientOrWsUrl: SettingsApiClient | string,
  request: SkillImportRequest,
): Promise<SkillImportResultResponse> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch('/api/settings/skills/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  return (await response.json()) as SkillImportResultResponse
}
