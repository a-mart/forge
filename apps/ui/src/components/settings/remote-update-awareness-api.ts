import type {
  ActivateRemoteUpdateAwarenessProjectResponse,
  DismissRemoteUpdateAwarenessProjectUpdateResponse,
  GetRemoteUpdateAwarenessIncomingResponse,
  GetRemoteUpdateAwarenessSettingsResponse,
  RefreshRemoteUpdateAwarenessProjectResponse,
  RemoteUpdateAwarenessProjectOverride,
  UpdateRemoteUpdateAwarenessProjectOverrideResponse,
  UpdateRemoteUpdateAwarenessSettingsResponse,
} from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

const BASE_PATH = '/api/git/remote-update-awareness'

async function request<T>(wsUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiEndpoint(wsUrl, `${BASE_PATH}${path}`), {
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Git monitoring request failed.')
  }
  return response.json() as Promise<T>
}

export function fetchRemoteUpdateAwarenessSettings(wsUrl: string): Promise<GetRemoteUpdateAwarenessSettingsResponse> {
  return request(wsUrl, '/settings')
}

export function updateRemoteUpdateAwarenessSettings(
  wsUrl: string,
  globalEnabled: boolean,
): Promise<UpdateRemoteUpdateAwarenessSettingsResponse> {
  return request(wsUrl, '/settings', { method: 'PATCH', body: JSON.stringify({ globalEnabled }) })
}

export function updateRemoteUpdateAwarenessProjectOverride(
  wsUrl: string,
  projectId: string,
  override: RemoteUpdateAwarenessProjectOverride,
): Promise<UpdateRemoteUpdateAwarenessProjectOverrideResponse> {
  return request(wsUrl, '/project', { method: 'PATCH', body: JSON.stringify({ projectId, override }) })
}

export function activateRemoteUpdateAwarenessProject(
  wsUrl: string,
  projectId: string,
): Promise<ActivateRemoteUpdateAwarenessProjectResponse> {
  return request(wsUrl, '/activate', { method: 'POST', body: JSON.stringify({ projectId }) })
}

export function refreshRemoteUpdateAwarenessProject(
  wsUrl: string,
  projectId: string,
): Promise<RefreshRemoteUpdateAwarenessProjectResponse> {
  return request(wsUrl, '/refresh', { method: 'POST', body: JSON.stringify({ projectId }) })
}

export function dismissRemoteUpdateAwarenessProjectUpdate(
  wsUrl: string,
  projectId: string,
  generation: number,
): Promise<DismissRemoteUpdateAwarenessProjectUpdateResponse> {
  return request(wsUrl, '/dismiss', {
    method: 'POST',
    body: JSON.stringify({ projectId, dismissalTarget: { generation } }),
  })
}

export function fetchRemoteUpdateAwarenessIncoming(
  wsUrl: string,
  projectId: string,
): Promise<GetRemoteUpdateAwarenessIncomingResponse> {
  return request(wsUrl, `/incoming?projectId=${encodeURIComponent(projectId)}`)
}
