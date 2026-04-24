import type {
  ManagerReasoningLevel,
  ResolvedSpecialistDefinition,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { createBuilderSettingsApiClient } from './settings-api-client'

export interface SaveSpecialistPayload {
  displayName: string
  color: string
  enabled: boolean
  whenToUse: string
  modelId: string
  provider?: string
  reasoningLevel?: ManagerReasoningLevel
  fallbackModelId?: string
  fallbackProvider?: string
  fallbackReasoningLevel?: ManagerReasoningLevel
  pinned?: boolean
  webSearch?: boolean
  promptBody: string
}

function resolveClient(clientOrWsUrl: SettingsApiClient | string | undefined): SettingsApiClient {
  return typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
}

function buildSpecialistPath(profileId?: string, pathSuffix = ''): string {
  const params = profileId ? new URLSearchParams({ profileId }) : undefined
  const query = params ? `?${params}` : ''
  return `/api/settings/specialists${pathSuffix}${query}`
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
    (specialist.webSearch === undefined || typeof specialist.webSearch === 'boolean') &&
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
  clientOrWsUrl: SettingsApiClient | string | undefined,
  profileId: string,
): Promise<ResolvedSpecialistDefinition[]> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath(profileId)
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { specialists?: unknown }
  return parseSpecialistList(payload)
}

export async function saveSpecialist(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  profileId: string,
  handle: string,
  data: SaveSpecialistPayload,
): Promise<void> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath(profileId, `/${encodeURIComponent(handle)}`)
  const response = await client.fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function deleteSpecialist(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  profileId: string,
  handle: string,
): Promise<void> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath(profileId, `/${encodeURIComponent(handle)}`)
  const response = await client.fetch(path, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function fetchRosterPrompt(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  profileId: string,
): Promise<string> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath(profileId, '/roster-prompt')
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { markdown?: unknown }
  return typeof payload.markdown === 'string' ? payload.markdown : ''
}

export async function fetchSharedSpecialists(
  clientOrWsUrl: SettingsApiClient | string | undefined,
): Promise<ResolvedSpecialistDefinition[]> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath()
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { specialists?: unknown }
  return parseSpecialistList(payload)
}

export async function saveSharedSpecialist(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  handle: string,
  data: SaveSpecialistPayload,
): Promise<void> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath(undefined, `/${encodeURIComponent(handle)}`)
  const response = await client.fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function deleteSharedSpecialist(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  handle: string,
): Promise<void> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath(undefined, `/${encodeURIComponent(handle)}`)
  const response = await client.fetch(path, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function fetchSpecialistsEnabled(clientOrWsUrl: SettingsApiClient | string | undefined): Promise<boolean> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath(undefined, '/enabled')
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { enabled?: unknown }
  return typeof payload.enabled === 'boolean' ? payload.enabled : true
}

export async function setSpecialistsEnabledApi(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  enabled: boolean,
): Promise<void> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath(undefined, '/enabled')
  const response = await client.fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function fetchWorkerTemplate(clientOrWsUrl: SettingsApiClient | string | undefined): Promise<string> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath(undefined, '/template')
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { template?: unknown }
  return typeof payload.template === 'string' ? payload.template : ''
}
