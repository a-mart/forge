import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type {
  GenerationThroughputCallsPage,
  GenerationThroughputCallsQuery,
  GenerationThroughputQuery,
  GenerationThroughputSnapshot,
} from '@forge/protocol'

export class GenerationThroughputApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'GenerationThroughputApiError'
  }
}

function browserTimezone(): string | null {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof timezone === 'string' && timezone.trim() ? timezone : null
  } catch {
    return null
  }
}

function paramsFor(query: GenerationThroughputQuery): URLSearchParams {
  const params = new URLSearchParams({ rangePreset: query.rangePreset })
  if (query.startDate) params.set('startDate', query.startDate)
  if (query.endDate) params.set('endDate', query.endDate)
  const timezone = query.timezone ?? browserTimezone()
  if (timezone) params.set('tz', timezone)
  if (query.profileId) params.set('profileId', query.profileId)
  if (query.role) params.set('role', query.role)
  if (query.provider) params.set('provider', query.provider)
  if (query.modelId) params.set('modelId', query.modelId)
  if (query.quality) params.set('quality', query.quality)
  if (query.attribution) params.set('attribution', query.attribution)
  if (query.specialistId) params.set('specialistId', query.specialistId)
  return params
}

async function request<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const response = await fetch(endpoint, init)
  if (!response.ok) {
    throw new GenerationThroughputApiError(response.status, `Throughput request failed: ${response.status}`)
  }
  return response.json() as Promise<T>
}

export function fetchGenerationThroughput(wsUrl: string, query: GenerationThroughputQuery): Promise<GenerationThroughputSnapshot> {
  return request(resolveApiEndpoint(wsUrl, `/api/stats/throughput?${paramsFor(query).toString()}`))
}

export function refreshGenerationThroughput(wsUrl: string, query: GenerationThroughputQuery): Promise<GenerationThroughputSnapshot> {
  return request(resolveApiEndpoint(wsUrl, `/api/stats/throughput/refresh?${paramsFor(query).toString()}`), { method: 'POST' })
}

export function fetchGenerationCalls(wsUrl: string, query: GenerationThroughputCallsQuery): Promise<GenerationThroughputCallsPage> {
  const params = paramsFor(query)
  if (query.limit) params.set('limit', String(query.limit))
  if (query.cursor) params.set('cursor', query.cursor)
  return request(resolveApiEndpoint(wsUrl, `/api/stats/throughput/calls?${params.toString()}`))
}
