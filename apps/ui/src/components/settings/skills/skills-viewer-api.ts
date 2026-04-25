/* ------------------------------------------------------------------ */
/*  API helpers for the Skills Viewer                                 */
/* ------------------------------------------------------------------ */

import type {
  SkillFileContentResponse,
  SkillFilesResponse,
  SkillInventoryEntry,
  SkillInventoryResponse,
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

export async function fetchSkillInventory(
  clientOrWsUrl: SettingsApiClient | string,
  profileId?: string,
): Promise<SkillInventoryEntry[]> {
  const client = resolveClient(clientOrWsUrl)
  const path = profileId
    ? `/api/settings/skills?profileId=${encodeURIComponent(profileId)}`
    : '/api/settings/skills'
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
): Promise<SkillFilesResponse> {
  const client = resolveClient(clientOrWsUrl)
  const basePath = `/api/settings/skills/${encodeURIComponent(skillId)}/files`
  const path = relativePath
    ? `${basePath}?path=${encodeURIComponent(relativePath)}`
    : basePath
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
): Promise<SkillFileContentResponse> {
  const client = resolveClient(clientOrWsUrl)
  const basePath = `/api/settings/skills/${encodeURIComponent(skillId)}/content`
  const path = `${basePath}?path=${encodeURIComponent(relativePath)}`
  const response = await client.fetch(path, SKILLS_FETCH_OPTIONS)
  if (!response.ok) throw new Error(await client.readApiError(response))
  return (await response.json()) as SkillFileContentResponse
}
