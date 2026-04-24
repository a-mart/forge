import type {
  ClosePlaywrightSessionResponse,
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
  PlaywrightLivePreviewHandle,
  UpdatePlaywrightSettingsRequest,
} from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { createBuilderSettingsApiClient } from '@/components/settings/settings-api-client'

function resolveClient(clientOrWsUrl: SettingsApiClient | string): SettingsApiClient {
  return typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
}

export async function fetchPlaywrightSnapshot(
  wsUrl: string,
): Promise<PlaywrightDiscoverySnapshot> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/playwright/sessions')
  const response = await fetch(endpoint)
  if (!response.ok) {
    const client = createBuilderSettingsApiClient(wsUrl)
    throw new Error(await client.readApiError(response))
  }
  const payload = (await response.json()) as { snapshot?: PlaywrightDiscoverySnapshot }
  if (!payload?.snapshot) throw new Error('Invalid snapshot response from backend.')
  return payload.snapshot
}

export async function triggerPlaywrightRescan(
  wsUrl: string,
): Promise<PlaywrightDiscoverySnapshot> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/playwright/rescan')
  const response = await fetch(endpoint, { method: 'POST' })
  if (!response.ok) {
    const client = createBuilderSettingsApiClient(wsUrl)
    throw new Error(await client.readApiError(response))
  }
  const payload = (await response.json()) as { ok?: boolean; snapshot?: PlaywrightDiscoverySnapshot }
  if (!payload?.snapshot) throw new Error('Invalid rescan response from backend.')
  return payload.snapshot
}

export async function closePlaywrightSession(
  wsUrl: string,
  sessionId: string,
): Promise<ClosePlaywrightSessionResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/playwright/sessions/close')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
  if (!response.ok) {
    const client = createBuilderSettingsApiClient(wsUrl)
    throw new Error(await client.readApiError(response))
  }
  const payload = (await response.json()) as ClosePlaywrightSessionResponse
  if (!payload?.ok) throw new Error('Invalid close session response from backend.')
  return payload
}

export async function fetchPlaywrightSettings(
  clientOrWsUrl: SettingsApiClient | string,
): Promise<PlaywrightDiscoverySettings> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch('/api/settings/playwright')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { settings?: PlaywrightDiscoverySettings }
  if (!payload?.settings) throw new Error('Invalid Playwright settings response from backend.')
  return payload.settings
}

// --- Live Preview APIs ---

export async function startPlaywrightLivePreview(
  wsUrl: string,
  sessionId: string,
  mode: 'embedded' | 'focus' = 'embedded',
  options?: { reuseIfActive?: boolean },
): Promise<PlaywrightLivePreviewHandle> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/playwright/live-preview/start')
  const body: Record<string, unknown> = { sessionId, mode }
  if (options?.reuseIfActive === false) body.reuseIfActive = false
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const client = createBuilderSettingsApiClient(wsUrl)
    throw new Error(await client.readApiError(response))
  }
  const payload = (await response.json()) as { ok?: boolean; preview?: PlaywrightLivePreviewHandle }
  if (!payload?.preview) throw new Error('Invalid live preview start response from backend.')
  return payload.preview
}

export async function releasePlaywrightLivePreview(
  wsUrl: string,
  previewId: string,
): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/playwright/live-preview/${encodeURIComponent(previewId)}`)
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) {
    // Best-effort release; don't throw on cleanup failures
    console.warn('Failed to release preview lease:', response.status)
  }
}

// --- Settings APIs ---

export async function updatePlaywrightSettings(
  clientOrWsUrl: SettingsApiClient | string,
  patch: UpdatePlaywrightSettingsRequest,
): Promise<{ settings: PlaywrightDiscoverySettings; snapshot: PlaywrightDiscoverySnapshot }> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch('/api/settings/playwright', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as {
    ok?: boolean
    settings?: PlaywrightDiscoverySettings
    snapshot?: PlaywrightDiscoverySnapshot
  }
  if (!payload?.settings || !payload?.snapshot) {
    throw new Error('Invalid Playwright settings update response from backend.')
  }
  return { settings: payload.settings, snapshot: payload.snapshot }
}
