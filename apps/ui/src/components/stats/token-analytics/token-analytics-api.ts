import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type {
  TokenAnalyticsQuery,
  TokenAnalyticsSnapshot,
  TokenAnalyticsWorkerPage,
  TokenAnalyticsWorkerPageQuery,
  TokenAnalyticsWorkerEventsQuery,
  TokenAnalyticsWorkerEventsResponse,
} from '@forge/protocol'

function getBrowserTimezone(): string | null {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof timezone === 'string' && timezone.trim().length > 0 ? timezone : null
  } catch {
    return null
  }
}

function buildQueryParams(query: TokenAnalyticsQuery): URLSearchParams {
  const params = new URLSearchParams()
  params.set('rangePreset', query.rangePreset)
  if (query.startDate) params.set('startDate', query.startDate)
  if (query.endDate) params.set('endDate', query.endDate)
  const tz = query.timezone ?? getBrowserTimezone()
  if (tz) params.set('tz', tz)
  if (query.profileId) params.set('profileId', query.profileId)
  if (query.provider) params.set('provider', query.provider)
  if (query.modelId) params.set('modelId', query.modelId)
  if (query.attribution) params.set('attribution', query.attribution)
  if (query.specialistId) params.set('specialistId', query.specialistId)
  return params
}

export async function fetchTokenAnalytics(
  wsUrl: string,
  query: TokenAnalyticsQuery,
): Promise<TokenAnalyticsSnapshot> {
  const params = buildQueryParams(query)
  const endpoint = resolveApiEndpoint(wsUrl, `/api/stats/tokens?${params.toString()}`)
  const response = await fetch(endpoint)
  if (!response.ok) {
    throw new Error(`Failed to fetch token analytics: ${response.status}`)
  }
  return response.json() as Promise<TokenAnalyticsSnapshot>
}

export async function refreshTokenAnalytics(
  wsUrl: string,
  query: TokenAnalyticsQuery,
): Promise<TokenAnalyticsSnapshot> {
  const params = buildQueryParams(query)
  const endpoint = resolveApiEndpoint(wsUrl, `/api/stats/tokens/refresh?${params.toString()}`)
  const response = await fetch(endpoint, { method: 'POST' })
  if (!response.ok) {
    throw new Error(`Failed to refresh token analytics: ${response.status}`)
  }
  return response.json() as Promise<TokenAnalyticsSnapshot>
}

export async function fetchTokenWorkers(
  wsUrl: string,
  query: TokenAnalyticsWorkerPageQuery,
): Promise<TokenAnalyticsWorkerPage> {
  const params = buildQueryParams(query)
  if (query.limit) params.set('limit', String(query.limit))
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.sort) params.set('sort', query.sort)
  if (query.direction) params.set('direction', query.direction)
  const endpoint = resolveApiEndpoint(wsUrl, `/api/stats/tokens/workers?${params.toString()}`)
  const response = await fetch(endpoint)
  if (!response.ok) {
    throw new Error(`Failed to fetch worker runs: ${response.status}`)
  }
  return response.json() as Promise<TokenAnalyticsWorkerPage>
}

export async function fetchTokenWorkerEvents(
  wsUrl: string,
  query: TokenAnalyticsWorkerEventsQuery,
): Promise<TokenAnalyticsWorkerEventsResponse> {
  const params = new URLSearchParams({
    profileId: query.profileId,
    sessionId: query.sessionId,
    workerId: query.workerId,
  })
  const endpoint = resolveApiEndpoint(wsUrl, `/api/stats/tokens/worker-events?${params.toString()}`)
  const response = await fetch(endpoint)
  if (!response.ok) {
    throw new Error(`Failed to fetch worker events: ${response.status}`)
  }
  return response.json() as Promise<TokenAnalyticsWorkerEventsResponse>
}
