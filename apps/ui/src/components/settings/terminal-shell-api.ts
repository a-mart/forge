import { resolveApiEndpoint } from '@/lib/api-endpoint'

export interface ShellOption {
  path: string
  name: string
  available: boolean
}

export interface TerminalShellSettings {
  defaultShell: string | null
  persistedDefaultShell: string | null
  source: 'settings' | 'env' | 'default'
}

export interface AvailableShellsResponse {
  shells: ShellOption[]
  settings: TerminalShellSettings
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

export async function fetchAvailableShells(
  wsUrl: string,
): Promise<AvailableShellsResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/terminals/available-shells')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as AvailableShellsResponse
  if (!payload?.shells || !payload?.settings) {
    throw new Error('Invalid terminal shells response from backend.')
  }
  return payload
}

export async function updateTerminalShellSettings(
  wsUrl: string,
  defaultShell: string | null,
): Promise<TerminalShellSettings> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/terminals/settings')
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultShell }),
  })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { ok?: boolean; settings?: TerminalShellSettings }
  if (!payload?.settings) {
    throw new Error('Invalid terminal settings update response from backend.')
  }
  return payload.settings
}
