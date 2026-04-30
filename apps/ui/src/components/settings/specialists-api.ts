import type {
  CollaborationCategory,
  CollaborationChannel,
  ManagerReasoningLevel,
  ResolvedSpecialistDefinition,
  SpecialistTargetSpace,
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
  targetSpace?: SpecialistTargetSpace[]
  promptBody: string
}

export interface ChannelSpecialistsResponse {
  channelId: string
  specialists: ResolvedSpecialistDefinition[]
  selectedGlobalSpecialistHandles: string[]
  missingSelectedSpecialistHandles: string[]
}

function resolveClient(clientOrWsUrl: SettingsApiClient | string | undefined): SettingsApiClient {
  return typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
}

function inferTargetSpace(client: SettingsApiClient): SpecialistTargetSpace {
  return client.target.kind === 'collab' ? 'collaboration' : 'builder'
}

function buildSpecialistPath(
  profileId?: string,
  pathSuffix = '',
  targetSpace?: SpecialistTargetSpace,
): string {
  const params = new URLSearchParams()
  if (profileId) params.set('profileId', profileId)
  if (targetSpace) params.set('targetSpace', targetSpace)
  const query = params.size > 0 ? `?${params}` : ''
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
    Array.isArray(specialist.targetSpace) &&
    specialist.targetSpace.every((space) => space === 'builder' || space === 'collaboration') &&
    typeof specialist.promptBody === 'string' &&
    (specialist.sourceKind === 'builtin' ||
      specialist.sourceKind === 'global' ||
      specialist.sourceKind === 'profile' ||
      specialist.sourceKind === 'channel') &&
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
  const path = buildSpecialistPath(profileId, '', inferTargetSpace(client))
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
  const path = buildSpecialistPath(profileId, `/${encodeURIComponent(handle)}`, inferTargetSpace(client))
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
  const path = buildSpecialistPath(profileId, `/${encodeURIComponent(handle)}`, inferTargetSpace(client))
  const response = await client.fetch(path, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function fetchRosterPrompt(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  profileId: string,
): Promise<string> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath(profileId, '/roster-prompt', inferTargetSpace(client))
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { markdown?: unknown }
  return typeof payload.markdown === 'string' ? payload.markdown : ''
}

export async function fetchSharedSpecialists(
  clientOrWsUrl: SettingsApiClient | string | undefined,
): Promise<ResolvedSpecialistDefinition[]> {
  const client = resolveClient(clientOrWsUrl)
  const path = buildSpecialistPath(undefined, '', inferTargetSpace(client))
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
  const path = buildSpecialistPath(undefined, `/${encodeURIComponent(handle)}`, inferTargetSpace(client))
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
  const path = buildSpecialistPath(undefined, `/${encodeURIComponent(handle)}`, inferTargetSpace(client))
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

/* ------------------------------------------------------------------ */
/*  Channel specialist API helpers                                     */
/* ------------------------------------------------------------------ */

export async function fetchChannelSpecialists(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  channelId: string,
): Promise<ChannelSpecialistsResponse> {
  const client = resolveClient(clientOrWsUrl)
  const path = `/api/collaboration/channels/${encodeURIComponent(channelId)}/specialists`
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as Record<string, unknown>
  return {
    channelId: typeof payload.channelId === 'string' ? payload.channelId : channelId,
    specialists: parseSpecialistList({ specialists: payload.specialists }),
    selectedGlobalSpecialistHandles: Array.isArray(payload.selectedGlobalSpecialistHandles)
      ? (payload.selectedGlobalSpecialistHandles as string[])
      : [],
    missingSelectedSpecialistHandles: Array.isArray(payload.missingSelectedSpecialistHandles)
      ? (payload.missingSelectedSpecialistHandles as string[])
      : [],
  }
}

export async function saveChannelSpecialist(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  channelId: string,
  handle: string,
  data: SaveSpecialistPayload,
): Promise<void> {
  const client = resolveClient(clientOrWsUrl)
  const path = `/api/collaboration/channels/${encodeURIComponent(channelId)}/specialists/${encodeURIComponent(handle)}`
  const response = await client.fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function deleteChannelSpecialistApi(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  channelId: string,
  handle: string,
): Promise<void> {
  const client = resolveClient(clientOrWsUrl)
  const path = `/api/collaboration/channels/${encodeURIComponent(channelId)}/specialists/${encodeURIComponent(handle)}`
  const response = await client.fetch(path, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function fetchChannelRosterPrompt(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  channelId: string,
): Promise<string> {
  const client = resolveClient(clientOrWsUrl)
  const path = `/api/collaboration/channels/${encodeURIComponent(channelId)}/specialists/roster-prompt`
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { markdown?: unknown }
  return typeof payload.markdown === 'string' ? payload.markdown : ''
}

export async function updateChannelSpecialistSelection(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  channelId: string,
  handles: string[],
): Promise<void> {
  const client = resolveClient(clientOrWsUrl)
  const path = `/api/collaboration/channels/${encodeURIComponent(channelId)}/specialists/selection`
  const response = await client.fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedGlobalSpecialistHandles: handles }),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function updateCategoryDefaultSpecialists(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  categoryId: string,
  handles: string[],
): Promise<void> {
  const client = resolveClient(clientOrWsUrl)
  const path = `/api/collaboration/categories/${encodeURIComponent(categoryId)}`
  const response = await client.fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultSelectedSpecialistHandles: handles }),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

/* ------------------------------------------------------------------ */
/*  Collab data helpers (for scope selector population)                */
/* ------------------------------------------------------------------ */

export async function fetchCollabCategories(
  clientOrWsUrl: SettingsApiClient | string | undefined,
): Promise<CollaborationCategory[]> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch('/api/collaboration/categories', { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { categories?: unknown }
  return Array.isArray(payload.categories) ? payload.categories as CollaborationCategory[] : []
}

export async function fetchCollabChannels(
  clientOrWsUrl: SettingsApiClient | string | undefined,
): Promise<CollaborationChannel[]> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch('/api/collaboration/channels', { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { channels?: unknown }
  return Array.isArray(payload.channels) ? payload.channels as CollaborationChannel[] : []
}
