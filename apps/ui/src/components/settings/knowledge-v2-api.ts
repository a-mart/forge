import type {
  GetKnowledgeV2SettingsResponse,
  UpdateKnowledgeV2SettingsRequest,
  UpdateKnowledgeV2SettingsResponse,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { createBuilderSettingsApiClient } from './settings-api-client'

const KNOWLEDGE_V2_SETTINGS_PATH = '/api/settings/knowledge-v2'

/**
 * Result of loading knowledge-v2 settings.
 *
 * `available: false` means the endpoint returned 404, which the backend uses
 * to signal that knowledge-v2 settings are only reachable from the Builder
 * runtime.  Callers should hide/disable the control in that case rather than
 * surface an error.
 */
export type FetchKnowledgeV2SettingsResult =
  | { available: true; response: GetKnowledgeV2SettingsResponse }
  | { available: false }

function resolveClient(clientOrWsUrl: SettingsApiClient | string | undefined): SettingsApiClient {
  return typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
}

export async function fetchKnowledgeV2Settings(
  clientOrWsUrl: SettingsApiClient | string | undefined,
): Promise<FetchKnowledgeV2SettingsResult> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch(KNOWLEDGE_V2_SETTINGS_PATH, { cache: 'no-store' })
  // Builder-only endpoint: 404 means "not available here" — not an error.
  if (response.status === 404) return { available: false }
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as Partial<GetKnowledgeV2SettingsResponse>
  if (!payload?.settings) {
    throw new Error('Invalid knowledge-v2 settings response from backend.')
  }
  return { available: true, response: payload as GetKnowledgeV2SettingsResponse }
}

export async function updateKnowledgeV2Settings(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  patch: UpdateKnowledgeV2SettingsRequest,
): Promise<UpdateKnowledgeV2SettingsResponse> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch(KNOWLEDGE_V2_SETTINGS_PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as Partial<UpdateKnowledgeV2SettingsResponse>
  if (!payload?.settings) {
    throw new Error('Invalid knowledge-v2 settings update response from backend.')
  }
  return payload as UpdateKnowledgeV2SettingsResponse
}
