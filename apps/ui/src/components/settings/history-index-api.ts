import type { HistoryIndexStatus, UpdateHistoryIndexSettingsRequest } from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

export async function fetchHistoryIndex(wsUrl: string, signal?: AbortSignal): Promise<HistoryIndexStatus> {
  return request(wsUrl, { signal })
}

export async function setHistoryIndexPaused(wsUrl: string, paused: boolean): Promise<HistoryIndexStatus> {
  const body: UpdateHistoryIndexSettingsRequest = { paused }
  return request(wsUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function request(wsUrl: string, options: RequestInit): Promise<HistoryIndexStatus> {
  const response = await fetch(resolveApiEndpoint(wsUrl, '/api/history/index'), { cache: 'no-store', ...options })
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof data?.error === 'string' ? data.error : 'History index is unavailable.')
  }
  return response.json() as Promise<HistoryIndexStatus>
}
