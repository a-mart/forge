import type {
  SessionAuditEntryCategory,
  SessionAuditEntryDetailResponse,
  SessionAuditOrder,
  SessionAuditPageResponse,
  SessionAuditScope,
  SessionAuditSourceKind,
} from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

export interface SessionAuditPageQuery {
  scope?: SessionAuditScope
  workerId?: string
  sourceKind?: SessionAuditSourceKind
  cursor?: string
  offset?: number
  order?: SessionAuditOrder
  limit?: number
  categories?: SessionAuditEntryCategory[]
  types?: string[]
  signal?: AbortSignal
}

export interface SessionAuditEntryDetailQuery {
  scope?: SessionAuditScope
  workerId?: string
  sourceKind?: SessionAuditSourceKind
  byteOffset: number
  nextByteOffset?: number
  signal?: AbortSignal
}

export class SessionAuditApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'SessionAuditApiError'
  }
}

export async function fetchSessionAuditPage(
  wsUrl: string | undefined,
  sessionAgentId: string,
  query: SessionAuditPageQuery = {},
): Promise<SessionAuditPageResponse> {
  const trimmedSessionAgentId = sessionAgentId.trim()
  if (!trimmedSessionAgentId) {
    throw new SessionAuditApiError('Missing session agent ID')
  }

  const params = new URLSearchParams()
  appendString(params, 'scope', query.scope)
  appendString(params, 'workerId', query.workerId)
  appendString(params, 'sourceKind', query.sourceKind)
  appendString(params, 'cursor', query.cursor)
  appendNumber(params, 'offset', query.offset)
  appendString(params, 'order', query.order)
  appendNumber(params, 'limit', query.limit)
  appendList(params, 'category', query.categories)
  appendList(params, 'type', query.types)

  const queryString = params.toString()
  const path = `/api/sessions/${encodeURIComponent(trimmedSessionAgentId)}/audit${queryString ? `?${queryString}` : ''}`
  const response = await fetch(resolveApiEndpoint(wsUrl, path), { signal: query.signal })
  const payload = await readJson(response)

  if (!response.ok) {
    const message = typeof payload?.error === 'string'
      ? payload.error
      : `Session audit request failed (${response.status})`
    throw new SessionAuditApiError(message, response.status)
  }

  return payload as unknown as SessionAuditPageResponse
}

export async function fetchSessionAuditEntryDetail(
  wsUrl: string | undefined,
  sessionAgentId: string,
  query: SessionAuditEntryDetailQuery,
): Promise<SessionAuditEntryDetailResponse> {
  const trimmedSessionAgentId = sessionAgentId.trim()
  if (!trimmedSessionAgentId) {
    throw new SessionAuditApiError('Missing session agent ID')
  }
  if (!Number.isSafeInteger(query.byteOffset) || query.byteOffset < 0) {
    throw new SessionAuditApiError('Missing or invalid byteOffset')
  }

  const params = new URLSearchParams()
  appendString(params, 'scope', query.scope)
  appendString(params, 'workerId', query.workerId)
  appendString(params, 'sourceKind', query.sourceKind)
  params.set('byteOffset', String(query.byteOffset))
  appendNumber(params, 'nextByteOffset', query.nextByteOffset)

  const path = `/api/sessions/${encodeURIComponent(trimmedSessionAgentId)}/audit/entry?${params.toString()}`
  const response = await fetch(resolveApiEndpoint(wsUrl, path), { signal: query.signal })
  const payload = await readJson(response)

  if (!response.ok) {
    const message = typeof payload?.error === 'string'
      ? payload.error
      : `Session audit entry request failed (${response.status})`
    throw new SessionAuditApiError(message, response.status)
  }

  return payload as unknown as SessionAuditEntryDetailResponse
}

function appendString(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim()
  if (trimmed) {
    params.set(key, trimmed)
  }
}

function appendNumber(params: URLSearchParams, key: string, value: number | undefined): void {
  if (typeof value === 'number') {
    params.set(key, String(value))
  }
}

function appendList(params: URLSearchParams, key: string, values: readonly string[] | undefined): void {
  for (const value of values ?? []) {
    const trimmed = value.trim()
    if (trimmed) {
      params.append(key, trimmed)
    }
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return undefined
  }
}
