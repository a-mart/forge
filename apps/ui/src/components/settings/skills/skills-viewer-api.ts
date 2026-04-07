/* ------------------------------------------------------------------ */
/*  API helpers for the Skills Viewer                                 */
/* ------------------------------------------------------------------ */

import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type {
  SkillInventoryEntry,
  SkillFilesResponse,
  SkillFileContentResponse,
} from './skills-viewer-types'

const SKILLS_FETCH_OPTIONS = { cache: 'no-store' } as const

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

/* ------------------------------------------------------------------ */
/*  Skill inventory                                                   */
/* ------------------------------------------------------------------ */

export async function fetchSkillInventory(
  wsUrl: string,
  profileId?: string,
): Promise<SkillInventoryEntry[]> {
  let endpoint = resolveApiEndpoint(wsUrl, '/api/settings/skills')
  if (profileId) {
    endpoint += `${endpoint.includes('?') ? '&' : '?'}profileId=${encodeURIComponent(profileId)}`
  }
  const response = await fetch(endpoint, SKILLS_FETCH_OPTIONS)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { skills?: unknown }
  if (!payload || !Array.isArray(payload.skills)) return []
  return payload.skills as SkillInventoryEntry[]
}

/* ------------------------------------------------------------------ */
/*  Skill files                                                       */
/* ------------------------------------------------------------------ */

export async function fetchSkillFiles(
  wsUrl: string,
  skillId: string,
  relativePath = '',
): Promise<SkillFilesResponse> {
  const base = resolveApiEndpoint(
    wsUrl,
    `/api/settings/skills/${encodeURIComponent(skillId)}/files`,
  )
  const url = relativePath
    ? `${base}?path=${encodeURIComponent(relativePath)}`
    : base
  const response = await fetch(url, SKILLS_FETCH_OPTIONS)
  if (!response.ok) throw new Error(await readApiError(response))
  return (await response.json()) as SkillFilesResponse
}

/* ------------------------------------------------------------------ */
/*  Skill file content                                                */
/* ------------------------------------------------------------------ */

export async function fetchSkillFileContent(
  wsUrl: string,
  skillId: string,
  relativePath: string,
): Promise<SkillFileContentResponse> {
  const base = resolveApiEndpoint(
    wsUrl,
    `/api/settings/skills/${encodeURIComponent(skillId)}/content`,
  )
  const url = `${base}?path=${encodeURIComponent(relativePath)}`
  const response = await fetch(url, SKILLS_FETCH_OPTIONS)
  if (!response.ok) throw new Error(await readApiError(response))
  return (await response.json()) as SkillFileContentResponse
}
