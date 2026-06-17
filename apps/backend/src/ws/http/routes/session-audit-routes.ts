import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionAuditEntryCategory, SessionAuditPageRequest } from '@forge/protocol'
import { SessionAuditError, SessionAuditService, type SessionAuditServiceHost } from '../../../swarm/session/session-audit-service.js'
import { applyCorsHeaders, sendJson } from '../../http-utils.js'
import type { HttpRoute } from '../shared/http-route.js'

const SESSION_AUDIT_ENDPOINT_PATTERN = /^\/api\/sessions\/([^/]+)\/audit$/
const METHODS = 'GET, OPTIONS'
const SESSION_AUDIT_ENTRY_CATEGORY_VALUES = [
  'session_header',
  'conversation_message',
  'agent_message',
  'manager_tool_call',
  'worker_tool_call',
  'runtime_log',
  'choice_request',
  'work_plan_created',
  'model_cache_observation',
  'custom',
  'unknown',
  'malformed',
] as const satisfies readonly SessionAuditEntryCategory[]

export function createSessionAuditRoutes(options: { swarmManager: SessionAuditServiceHost }): HttpRoute[] {
  const auditService = new SessionAuditService(options.swarmManager)

  return [
    {
      methods: METHODS,
      matches: (pathname) => SESSION_AUDIT_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleSessionAuditRequest(auditService, request, response, requestUrl)
      },
    },
  ]
}

async function handleSessionAuditRequest(
  auditService: SessionAuditService,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response, METHODS)
    response.statusCode = 204
    response.end()
    return
  }

  if (request.method !== 'GET') {
    applyCorsHeaders(request, response, METHODS)
    response.setHeader('Allow', METHODS)
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  applyCorsHeaders(request, response, METHODS)

  const matched = requestUrl.pathname.match(SESSION_AUDIT_ENDPOINT_PATTERN)
  const rawSessionAgentId = matched?.[1] ?? ''
  const sessionAgentId = decodeURIComponent(rawSessionAgentId).trim()

  try {
    const pageRequest = parseAuditPageRequest(requestUrl.searchParams)
    const page = await auditService.getSessionAuditPage(sessionAgentId, pageRequest)
    sendJson(response, 200, page as unknown as Record<string, unknown>)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const statusCode = error instanceof SessionAuditError ? error.statusCode : 500
    sendJson(response, statusCode, { error: message })
  }
}

function parseAuditPageRequest(searchParams: URLSearchParams): SessionAuditPageRequest {
  if (searchParams.has('q') || searchParams.has('search') || searchParams.has('textQuery')) {
    throw new SessionAuditError('Session audit search is not supported', 400)
  }
  if (searchParams.has('includeConversationEntry')) {
    throw new SessionAuditError('Full conversation entries are not exposed by audit pages; use capped previews', 400)
  }
  if (searchParams.has('source')) {
    throw new SessionAuditError('Use sourceKind for audit source filtering', 400)
  }

  const sourceKind = searchParams.get('sourceKind')
  if (sourceKind && sourceKind !== 'canonical_session_jsonl') {
    throw new SessionAuditError('Only canonical_session_jsonl audit source is supported', 400)
  }

  return {
    scope: parseOptionalEnum(searchParams.get('scope'), ['session', 'worker'] as const, 'scope'),
    workerId: optionalString(searchParams.get('workerId')),
    cursor: optionalString(searchParams.get('cursor')),
    offset: parseOptionalInteger(searchParams.get('offset'), 'offset'),
    order: parseOptionalEnum(searchParams.get('order'), ['asc', 'desc'] as const, 'order'),
    limit: parseOptionalInteger(searchParams.get('limit'), 'limit'),
    categories: parseCategories(searchParams),
    types: parseCsv(searchParams, 'type', 'types'),
  }
}

function parseCategories(searchParams: URLSearchParams): SessionAuditEntryCategory[] | undefined {
  const values = parseCsv(searchParams, 'category', 'categories')
  if (!values) {
    return undefined
  }

  const allowed = new Set<string>(SESSION_AUDIT_ENTRY_CATEGORY_VALUES)
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new SessionAuditError(`Unsupported audit category: ${value}`, 400)
    }
  }
  return values as SessionAuditEntryCategory[]
}

function parseCsv(searchParams: URLSearchParams, singleName: string, multiName: string): string[] | undefined {
  const values = [...searchParams.getAll(singleName), ...searchParams.getAll(multiName)]
    .flatMap((raw) => raw.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return values.length > 0 ? [...new Set(values)] : undefined
}

function parseOptionalInteger(raw: string | null, field: string): number | undefined {
  if (raw === null || raw.trim() === '') {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new SessionAuditError(`Invalid ${field}`, 400)
  }
  return value
}

function parseOptionalEnum<const T extends readonly string[]>(raw: string | null, allowed: T, field: string): T[number] | undefined {
  if (raw === null || raw.trim() === '') {
    return undefined
  }
  const normalized = raw.trim()
  if ((allowed as readonly string[]).includes(normalized)) {
    return normalized as T[number]
  }
  throw new SessionAuditError(`Unsupported ${field}`, 400)
}

function optionalString(raw: string | null): string | undefined {
  const trimmed = raw?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : undefined
}
