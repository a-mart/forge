import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type {
  ManagerModelPreset,
  ManagerReasoningLevel,
  ResolvedSpecialistDefinition,
} from '@forge/protocol'

export interface SaveSpecialistPayload {
  displayName: string
  color: string
  enabled: boolean
  whenToUse: string
  model: ManagerModelPreset
  reasoningLevel?: ManagerReasoningLevel
  promptBody: string
}

function buildSpecialistEndpoint(
  wsUrl: string | undefined,
  profileId: string,
  pathSuffix = '',
): string {
  const params = new URLSearchParams({ profileId })
  return resolveApiEndpoint(wsUrl, `/api/settings/specialists${pathSuffix}?${params}`)
}

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

export async function fetchSpecialists(
  wsUrl: string | undefined,
  profileId: string,
): Promise<ResolvedSpecialistDefinition[]> {
  const endpoint = buildSpecialistEndpoint(wsUrl, profileId)
  const response = await fetch(endpoint, { cache: 'no-store' })
  if (!response.ok) throw new Error(await readApiError(response))
  const data = (await response.json()) as { specialists?: unknown }
  if (!data || !Array.isArray(data.specialists)) return []
  return data.specialists as ResolvedSpecialistDefinition[]
}

export async function saveSpecialist(
  wsUrl: string | undefined,
  profileId: string,
  handle: string,
  data: SaveSpecialistPayload,
): Promise<void> {
  const endpoint = buildSpecialistEndpoint(wsUrl, profileId, `/${encodeURIComponent(handle)}`)
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function deleteSpecialist(
  wsUrl: string | undefined,
  profileId: string,
  handle: string,
): Promise<void> {
  const endpoint = buildSpecialistEndpoint(wsUrl, profileId, `/${encodeURIComponent(handle)}`)
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function fetchRosterPrompt(
  wsUrl: string | undefined,
  profileId: string,
): Promise<string> {
  const endpoint = buildSpecialistEndpoint(wsUrl, profileId, '/roster-prompt')
  const response = await fetch(endpoint, { cache: 'no-store' })
  if (!response.ok) throw new Error(await readApiError(response))
  const data = (await response.json()) as { markdown?: unknown }
  return typeof data.markdown === 'string' ? data.markdown : ''
}
