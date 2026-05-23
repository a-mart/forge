import type {
  ActivateRepoProjectAgentRequest,
  ProjectResourceMutationResponse,
  ProjectResourcesSnapshotResponse,
  ProjectResourceTrustRequest,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'

export interface ActivateRepoProjectAgentResponse extends ProjectResourceMutationResponse {
  agentId: string
  projectAgent: Record<string, unknown>
}

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

export function activateRepoProjectAgent(
  apiClient: SettingsApiClient,
  params: ActivateRepoProjectAgentRequest,
): Promise<ActivateRepoProjectAgentResponse> {
  return apiClient.fetchJson<ActivateRepoProjectAgentResponse>('/api/settings/project-resources/project-agents/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
}
