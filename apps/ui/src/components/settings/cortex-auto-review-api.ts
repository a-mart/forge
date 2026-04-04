import type {
  CortexAutoReviewSettings,
  UpdateCortexAutoReviewSettingsRequest,
} from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

export interface CortexAutoReviewSettingsResponse {
  settings: CortexAutoReviewSettings
  cortexDisabled?: boolean
}

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

export async function fetchCortexAutoReviewSettings(
  wsUrl: string,
): Promise<CortexAutoReviewSettingsResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/cortex-auto-review')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as Partial<CortexAutoReviewSettingsResponse>
  if (!payload?.settings) throw new Error('Invalid Cortex auto-review settings response from backend.')
  return payload as CortexAutoReviewSettingsResponse
}

export async function updateCortexAutoReviewSettings(
  wsUrl: string,
  patch: UpdateCortexAutoReviewSettingsRequest,
): Promise<CortexAutoReviewSettings> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/cortex-auto-review')
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { ok?: boolean; settings?: CortexAutoReviewSettings }
  if (!payload?.settings) throw new Error('Invalid Cortex auto-review settings update response from backend.')
  return payload.settings
}
