import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { StatsSnapshot, StatsRange } from './stats-types'

export async function fetchStats(wsUrl: string, range: StatsRange = '7d'): Promise<StatsSnapshot> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/stats?range=${range}`)
  const response = await fetch(endpoint)
  if (!response.ok) {
    throw new Error(`Failed to fetch stats: ${response.status}`)
  }
  return response.json() as Promise<StatsSnapshot>
}

export async function refreshStats(wsUrl: string, range: StatsRange = '7d'): Promise<StatsSnapshot> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/stats/refresh?range=${range}`)
  const response = await fetch(endpoint, { method: 'POST' })
  if (!response.ok) {
    throw new Error(`Failed to refresh stats: ${response.status}`)
  }
  return response.json() as Promise<StatsSnapshot>
}
