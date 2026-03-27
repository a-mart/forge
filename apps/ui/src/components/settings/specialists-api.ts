import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type {
  ManagerReasoningLevel,
  ResolvedSpecialistDefinition,
} from '@forge/protocol'

export interface SaveSpecialistPayload {
  displayName: string
  color: string
  enabled: boolean
  whenToUse: string
  modelId: string
  reasoningLevel?: ManagerReasoningLevel
  fallbackModelId?: string
  fallbackReasoningLevel?: ManagerReasoningLevel
  pinned?: boolean
  promptBody: string
}

function buildSpecialistEndpoint(
  wsUrl: string | undefined,
  profileId?: string,
  pathSuffix = '',
): string {
  const params = profileId ? new URLSearchParams({ profileId }) : undefined
  const query = params ? `?${params}` : ''
  return resolveApiEndpoint(wsUrl, `/api/settings/specialists${pathSuffix}${query}`)
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch {
    // Ignore and fall back to plain text.
  }

  try {
    const text = await response.text()
    if (text.trim().length > 0) return text
  } catch {
    // Ignore and fall back to status code.
  }

  return `Request failed (${response.status})`
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  return (await response.json()) as T
}

async function requestOk(input: string, init?: RequestInit): Promise<void> {
  const response = await fetch(input, init)
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
}

function parseSpecialistList(payload: { specialists?: unknown } | null | undefined): ResolvedSpecialistDefinition[] {
  if (!payload || !Array.isArray(payload.specialists)) {
    return []
  }

  return payload.specialists.filter(isResolvedSpecialistDefinition)
}

function isResolvedSpecialistDefinition(value: unknown): value is ResolvedSpecialistDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const specialist = value as Record<string, unknown>
  return (
    typeof specialist.specialistId === 'string' &&
    typeof specialist.displayName === 'string' &&
    typeof specialist.color === 'string' &&
    typeof specialist.enabled === 'boolean' &&
    typeof specialist.whenToUse === 'string' &&
    typeof specialist.modelId === 'string' &&
    typeof specialist.provider === 'string' &&
    (specialist.reasoningLevel === undefined || typeof specialist.reasoningLevel === 'string') &&
    (specialist.fallbackModelId === undefined || typeof specialist.fallbackModelId === 'string') &&
    (specialist.fallbackProvider === undefined || typeof specialist.fallbackProvider === 'string') &&
    (specialist.fallbackReasoningLevel === undefined || typeof specialist.fallbackReasoningLevel === 'string') &&
    typeof specialist.builtin === 'boolean' &&
    typeof specialist.pinned === 'boolean' &&
    typeof specialist.promptBody === 'string' &&
    (specialist.sourceKind === 'builtin' || specialist.sourceKind === 'global' || specialist.sourceKind === 'profile') &&
    typeof specialist.available === 'boolean' &&
    (specialist.availabilityCode === 'ok' ||
      specialist.availabilityCode === 'invalid_model' ||
      specialist.availabilityCode === 'missing_auth') &&
    (specialist.availabilityMessage === undefined || typeof specialist.availabilityMessage === 'string') &&
    typeof specialist.shadowsGlobal === 'boolean'
  )
}

export async function fetchSpecialists(
  wsUrl: string | undefined,
  profileId: string,
): Promise<ResolvedSpecialistDefinition[]> {
  const endpoint = buildSpecialistEndpoint(wsUrl, profileId)
  const payload = await requestJson<{ specialists?: unknown }>(endpoint, { cache: 'no-store' })
  return parseSpecialistList(payload)
}

export async function saveSpecialist(
  wsUrl: string | undefined,
  profileId: string,
  handle: string,
  data: SaveSpecialistPayload,
): Promise<void> {
  const endpoint = buildSpecialistEndpoint(wsUrl, profileId, `/${encodeURIComponent(handle)}`)
  await requestOk(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deleteSpecialist(
  wsUrl: string | undefined,
  profileId: string,
  handle: string,
): Promise<void> {
  const endpoint = buildSpecialistEndpoint(wsUrl, profileId, `/${encodeURIComponent(handle)}`)
  await requestOk(endpoint, { method: 'DELETE' })
}

export async function fetchRosterPrompt(
  wsUrl: string | undefined,
  profileId: string,
): Promise<string> {
  const endpoint = buildSpecialistEndpoint(wsUrl, profileId, '/roster-prompt')
  const payload = await requestJson<{ markdown?: unknown }>(endpoint, { cache: 'no-store' })
  return typeof payload.markdown === 'string' ? payload.markdown : ''
}

export async function fetchSharedSpecialists(
  wsUrl: string | undefined,
): Promise<ResolvedSpecialistDefinition[]> {
  const endpoint = buildSpecialistEndpoint(wsUrl)
  const payload = await requestJson<{ specialists?: unknown }>(endpoint, { cache: 'no-store' })
  return parseSpecialistList(payload)
}

export async function saveSharedSpecialist(
  wsUrl: string | undefined,
  handle: string,
  data: SaveSpecialistPayload,
): Promise<void> {
  const endpoint = buildSpecialistEndpoint(wsUrl, undefined, `/${encodeURIComponent(handle)}`)
  await requestOk(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deleteSharedSpecialist(
  wsUrl: string | undefined,
  handle: string,
): Promise<void> {
  const endpoint = buildSpecialistEndpoint(wsUrl, undefined, `/${encodeURIComponent(handle)}`)
  await requestOk(endpoint, { method: 'DELETE' })
}

export async function fetchSpecialistsEnabled(wsUrl: string | undefined): Promise<boolean> {
  const endpoint = buildSpecialistEndpoint(wsUrl, undefined, '/enabled')
  const payload = await requestJson<{ enabled?: unknown }>(endpoint, { cache: 'no-store' })
  return typeof payload.enabled === 'boolean' ? payload.enabled : true
}

export async function setSpecialistsEnabledApi(
  wsUrl: string | undefined,
  enabled: boolean,
): Promise<void> {
  const endpoint = buildSpecialistEndpoint(wsUrl, undefined, '/enabled')
  await requestOk(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

export async function fetchWorkerTemplate(wsUrl: string | undefined): Promise<string> {
  const endpoint = buildSpecialistEndpoint(wsUrl, undefined, '/template')
  const payload = await requestJson<{ template?: unknown }>(endpoint, { cache: 'no-store' })
  return typeof payload.template === 'string' ? payload.template : ''
}
