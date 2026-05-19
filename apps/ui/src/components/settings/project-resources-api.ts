import type {
  ProjectResourceMutationResponse,
  ProjectResourcesSnapshotResponse,
  ProjectResourceTrustRequest,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'

export function fetchProjectResourcesSnapshot(
  apiClient: SettingsApiClient,
  params: { profileId: string; sessionAgentId: string },
): Promise<ProjectResourcesSnapshotResponse> {
  const search = new URLSearchParams(params)
  return apiClient.fetchJson<ProjectResourcesSnapshotResponse>(`/api/settings/project-resources?${search.toString()}`)
}

export function updateProjectResourcesOverride(
  apiClient: SettingsApiClient,
  params: { profileId: string; sessionAgentId: string; forgeDir: string | null },
): Promise<ProjectResourceMutationResponse> {
  return apiClient.fetchJson<ProjectResourceMutationResponse>('/api/settings/project-resources/override', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
}

export function updateProjectResourcesTrust(
  apiClient: SettingsApiClient,
  params: ProjectResourceTrustRequest,
): Promise<ProjectResourceMutationResponse> {
  return apiClient.fetchJson<ProjectResourceMutationResponse>('/api/settings/project-resources/trust', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
}
