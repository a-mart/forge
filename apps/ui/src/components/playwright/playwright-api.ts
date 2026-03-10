import type {
  ClosePlaywrightSessionResponse,
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
  PlaywrightLivePreviewHandle,
  UpdatePlaywrightSettingsRequest,
} from '@middleman/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

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

export async function fetchPlaywrightSnapshot(
  wsUrl: string,
): Promise<PlaywrightDiscoverySnapshot> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/playwright/sessions')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { snapshot?: PlaywrightDiscoverySnapshot }
  if (!payload?.snapshot) throw new Error('Invalid snapshot response from backend.')
  return payload.snapshot
}

export async function triggerPlaywrightRescan(
  wsUrl: string,
): Promise<PlaywrightDiscoverySnapshot> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/playwright/rescan')
  const response = await fetch(endpoint, { method: 'POST' })
  if (!response.ok) throw new Error(await readApiError(response))
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
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as ClosePlaywrightSessionResponse
  if (!payload?.ok) throw new Error('Invalid close session response from backend.')
  return payload
}

export async function fetchPlaywrightSettings(
  wsUrl: string,
): Promise<PlaywrightDiscoverySettings> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/playwright')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { settings?: PlaywrightDiscoverySettings }
  if (!payload?.settings) throw new Error('Invalid Playwright settings response from backend.')
  return payload.settings
}

// --- Live Preview APIs ---

export async function startPlaywrightLivePreview(
  wsUrl: string,
  sessionId: string,
  mode: 'embedded' | 'focus' = 'embedded',
): Promise<PlaywrightLivePreviewHandle> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/playwright/live-preview/start')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, mode }),
  })
  if (!response.ok) throw new Error(await readApiError(response))
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
  wsUrl: string,
  patch: UpdatePlaywrightSettingsRequest,
): Promise<{ settings: PlaywrightDiscoverySettings; snapshot: PlaywrightDiscoverySnapshot }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/playwright')
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(await readApiError(response))
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
