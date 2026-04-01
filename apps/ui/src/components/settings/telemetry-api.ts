import type { TelemetrySettingsResponse } from '@forge/protocol'
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

export async function fetchTelemetrySettings(
  wsUrl: string,
): Promise<TelemetrySettingsResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/telemetry')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { settings?: TelemetrySettingsResponse }
  if (!payload?.settings) throw new Error('Invalid telemetry settings response')
  return payload.settings
}

export async function updateTelemetrySettings(
  wsUrl: string,
  patch: { enabled: boolean },
): Promise<TelemetrySettingsResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/telemetry')
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { ok?: boolean; settings?: TelemetrySettingsResponse }
  if (!payload?.settings) throw new Error('Invalid telemetry settings update response')
  return payload.settings
}

export async function resetTelemetryInstallId(
  wsUrl: string,
): Promise<TelemetrySettingsResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/telemetry/reset-id')
  const response = await fetch(endpoint, { method: 'POST' })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { ok?: boolean; settings?: TelemetrySettingsResponse }
  if (!payload?.settings) throw new Error('Invalid telemetry reset response')
  return payload.settings
}
