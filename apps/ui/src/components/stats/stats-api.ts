import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { StatsSnapshot, StatsRange } from '@forge/protocol'

function getBrowserTimezone(): string | null {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof timezone === 'string' && timezone.trim().length > 0 ? timezone : null
  } catch {
    return null
  }
}

function buildStatsQuery(range: StatsRange): string {
  const params = new URLSearchParams({ range })
  const timezone = getBrowserTimezone()
  if (timezone) {
    params.set('tz', timezone)
  }
  return params.toString()
}

export async function fetchStats(wsUrl: string, range: StatsRange = '7d'): Promise<StatsSnapshot> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/stats?${buildStatsQuery(range)}`)
  const response = await fetch(endpoint)
  if (!response.ok) {
    throw new Error(`Failed to fetch stats: ${response.status}`)
  }
  return response.json() as Promise<StatsSnapshot>
}

export async function refreshStats(wsUrl: string, range: StatsRange = '7d'): Promise<StatsSnapshot> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/stats/refresh?${buildStatsQuery(range)}`)
  const response = await fetch(endpoint, { method: 'POST' })
  if (!response.ok) {
    throw new Error(`Failed to refresh stats: ${response.status}`)
  }
  return response.json() as Promise<StatsSnapshot>
}
