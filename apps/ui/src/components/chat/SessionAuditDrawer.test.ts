/** @vitest-environment jsdom */

import { fireEvent, getByPlaceholderText, getByRole, getByText, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionAuditDrawer } from './SessionAuditDrawer'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => auditPageFixture(),
  } as Response)))
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => undefined) },
  })
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  root = null
})

describe('SessionAuditDrawer', () => {
  it('loads capped audit rows and renders diagnostic metadata', async () => {
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(SessionAuditDrawer, {
        open: true,
        onOpenChange: vi.fn(),
        sessionAgentId: 'manager-1',
        sessionLabel: 'Project / Session',
        wsUrl: 'ws://127.0.0.1:47187/ws',
      }))
    })

    await waitFor(() => expect(getByText(document.body, 'Worker tool call')).toBeTruthy())
    expect(getByText(document.body, /Complete persisted session audit/)).toBeTruthy()
    expect(getByText(document.body, 'canonical_session_jsonl')).toBeTruthy()
    expect(getByText(document.body, 'sessions/manager-1/session.jsonl')).toBeTruthy()
    expect(getByText(document.body, '10 → 220')).toBeTruthy()
    expect(getByText(document.body, 'normal_view_hidden')).toBeTruthy()
    expect(queryByText(document.body, 'tool result raw')).toBeNull()

    fireEvent.click(getByRole(document.body, 'button', { name: /show capped json preview/i }))
    await waitFor(() => expect(getByText(document.body, 'tool result raw')).toBeTruthy())

    const requestUrl = new URL((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)
    expect(requestUrl.searchParams.has('includeConversationEntry')).toBe(false)
  })

  it('clears loaded rows when the active session becomes ineligible', async () => {
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(SessionAuditDrawer, {
        open: true,
        onOpenChange: vi.fn(),
        sessionAgentId: 'manager-1',
        sessionLabel: 'Project / Session',
        wsUrl: 'ws://127.0.0.1:47187/ws',
      }))
    })

    await waitFor(() => expect(getByText(document.body, 'Worker tool call')).toBeTruthy())

    flushSync(() => {
      root?.render(createElement(SessionAuditDrawer, {
        open: true,
        onOpenChange: vi.fn(),
        sessionAgentId: null,
        sessionLabel: 'Worker',
        wsUrl: 'ws://127.0.0.1:47187/ws',
      }))
    })

    await waitFor(() => expect(queryByText(document.body, 'Worker tool call')).toBeNull())
    expect(getByText(document.body, 'No audit rows found')).toBeTruthy()
  })

  it('does not append a stale load-more page after filters change', async () => {
    const loadMore = createDeferred<Response>()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const cursor = url.searchParams.get('cursor')
      const type = url.searchParams.get('type')
      if (cursor === 'cursor-1') {
        return loadMore.promise
      }
      if (type === 'filtered') {
        return responseFor(auditPageFixture({ title: 'Filtered row', hasMore: false, nextCursor: undefined }))
      }
      return responseFor(auditPageFixture({ title: 'Initial row', hasMore: true, nextCursor: 'cursor-1' }))
    })
    vi.stubGlobal('fetch', fetchMock)

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(SessionAuditDrawer, {
        open: true,
        onOpenChange: vi.fn(),
        sessionAgentId: 'manager-1',
        sessionLabel: 'Project / Session',
        wsUrl: 'ws://127.0.0.1:47187/ws',
      }))
    })

    await waitFor(() => expect(getByText(document.body, 'Initial row')).toBeTruthy())
    fireEvent.click(getByRole(document.body, 'button', { name: /load more audit rows/i }))
    fireEvent.change(getByPlaceholderText(document.body, 'wrapper/custom/conversation type'), { target: { value: 'filtered' } })
    await waitFor(() => expect(getByText(document.body, 'Filtered row')).toBeTruthy())

    loadMore.resolve(responseFor(auditPageFixture({ title: 'Stale old page', hasMore: false, nextCursor: undefined })))

    await waitFor(() => expect(queryByText(document.body, 'Stale old page')).toBeNull())
    expect(queryByText(document.body, 'Initial row')).toBeNull()
    expect(getByText(document.body, 'Filtered row')).toBeTruthy()
  })
})

function auditPageFixture(options: { title?: string; hasMore?: boolean; nextCursor?: string } = {}) {
  return {
    sessionAgentId: 'manager-1',
    manifest: { sessionAgentId: 'manager-1', sessionRelativePath: 'sessions/manager-1/session.jsonl', workers: [] },
    scope: 'session',
    sourceId: 'manager-1',
    sourceKind: 'canonical_session_jsonl',
    order: 'asc',
    limit: 50,
    items: [
      {
        id: 'canonical_session_jsonl:manager-1:10',
        scope: 'session',
        sourceId: 'manager-1',
        sourceLabel: 'Manager session',
        sourceKind: 'canonical_session_jsonl',
        relativePath: 'sessions/manager-1/session.jsonl',
        lineNumber: 3,
        byteOffset: 10,
        nextByteOffset: 220,
        wrapperTimestamp: '2026-06-17T12:00:00.000Z',
        wrapperType: 'agent_tool_call',
        category: 'worker_tool_call',
        actorAgentId: 'worker-1',
        toolCallId: 'tool-1',
        renderable: false,
        hiddenReason: 'normal_view_hidden',
        title: options.title ?? 'Worker tool call',
        summary: 'worker-1 called read',
        preview: '{\n  "title": "Worker tool call"\n}',
        rawPreview: 'tool result raw',
        rawBytes: 210,
      },
    ],
    page: { startOffset: 0, endOffset: 220, sourceBytes: 220, scannedLines: 3, scannedBytes: 220, returnedItems: 1, scanLimited: false },
    nextCursor: options.nextCursor,
    hasMore: options.hasMore ?? false,
  }
}

function responseFor(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
  } as Response
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}
