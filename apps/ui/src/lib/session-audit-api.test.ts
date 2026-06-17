import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchSessionAuditPage, SessionAuditApiError } from './session-audit-api'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('fetchSessionAuditPage', () => {
  it('requests the session audit endpoint with supported filters only', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({
        sessionAgentId: 'manager 1',
        manifest: { sessionAgentId: 'manager 1', sessionRelativePath: 'session.jsonl', workers: [] },
        scope: 'session',
        sourceId: 'manager 1',
        sourceKind: 'canonical_session_jsonl',
        order: 'asc',
        limit: 25,
        items: [],
        page: { startOffset: 0, endOffset: 0, sourceBytes: 0, scannedLines: 0, scannedBytes: 0, returnedItems: 0, scanLimited: false },
        hasMore: false,
      }),
    } as Response))
    vi.stubGlobal('fetch', fetchMock)

    await fetchSessionAuditPage('ws://127.0.0.1:47187/ws', 'manager 1', {
      scope: 'worker',
      workerId: 'worker 1',
      sourceKind: 'canonical_worker_jsonl',
      limit: 25,
      cursor: 'next cursor',
      categories: ['worker_tool_call'],
      types: ['agent_tool_call'],
    })

    const requestedUrl = (fetchMock.mock.calls as Array<[RequestInfo | URL]>)[0]?.[0]
    expect(typeof requestedUrl).toBe('string')
    const url = new URL(requestedUrl as unknown as string)
    expect(url.origin).toBe('http://127.0.0.1:47187')
    expect(url.pathname).toBe('/api/sessions/manager%201/audit')
    expect(url.searchParams.get('scope')).toBe('worker')
    expect(url.searchParams.get('workerId')).toBe('worker 1')
    expect(url.searchParams.get('sourceKind')).toBe('canonical_worker_jsonl')
    expect(url.searchParams.get('limit')).toBe('25')
    expect(url.searchParams.get('cursor')).toBe('next cursor')
    expect(url.searchParams.getAll('category')).toEqual(['worker_tool_call'])
    expect(url.searchParams.getAll('type')).toEqual(['agent_tool_call'])
    expect(url.searchParams.has('includeConversationEntry')).toBe(false)
  })

  it('surfaces backend errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'unsupported filter' }),
    } as Response)))

    await expect(fetchSessionAuditPage(undefined, 'manager-1')).rejects.toEqual(
      new SessionAuditApiError('unsupported filter', 400),
    )
  })
})
