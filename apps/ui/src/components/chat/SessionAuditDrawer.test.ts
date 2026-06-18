/** @vitest-environment jsdom */

import { fireEvent, getAllByText, getByPlaceholderText, getByRole, getByText, queryByRole, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { highlightCode } from '@/lib/syntax-highlight'
import { SessionAuditDrawer } from './SessionAuditDrawer'

vi.mock('@/lib/syntax-highlight', () => ({
  highlightCode: vi.fn((source: string) => `HL:${source}`),
}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(highlightCode).mockClear()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/audit/entry')) {
      return responseFor({
        sessionAgentId: 'manager-1',
        scope: 'session',
        sourceId: 'session',
        sourceKind: 'canonical_session_jsonl',
        relativePath: 'sessions/manager-1/session.jsonl',
        byteOffset: Number(url.searchParams.get('byteOffset')),
        nextByteOffset: 220,
        rawBytes: 210,
        rawText: '{"type":"custom","id":"tool-1","data":{"text":"tool result raw"}}',
        truncated: false,
        maxBytes: 8388608,
        formattedJson: '{\n  "type": "custom",\n  "id": "tool-1",\n  "data": {\n    "text": "tool result raw"\n  }\n}',
      })
    }
    return responseFor(auditPageFixture())
  }))
  const localStorageEntries = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => localStorageEntries.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageEntries.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        localStorageEntries.delete(key)
      }),
      clear: vi.fn(() => {
        localStorageEntries.clear()
      }),
    },
  })
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => undefined) },
  })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
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
  it('loads capped audit rows and auto-loads full JSON detail for the selected row', async () => {
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

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Worker tool call/i })).toBeTruthy())
    expect(getByText(document.body, /Complete persisted session audit/)).toBeTruthy()
    expect(getByText(document.body, 'Manager canonical JSONL')).toBeTruthy()
    expect(getAllByText(document.body, /sessions\/manager-1\/session\.jsonl/).length).toBeGreaterThan(0)
    expect(getByText(document.body, /Select any audit row/i)).toBeTruthy()
    expect(getByText(document.body, 'normal_view_hidden')).toBeTruthy()
    expect(getByRole(document.body, 'listbox', { name: /session audit rows/i })).toBeTruthy()
    expect(getByRole(document.body, 'option', { name: /Worker tool call/i })).toBeTruthy()
    expect(queryByText(document.body, 'View JSON')).toBeNull()

    await waitFor(() => expect(getByRole(document.body, 'button', { name: 'Copy JSON' })).toBeTruthy())
    await waitFor(() => expect(document.body.textContent).toContain('tool result raw'))

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const listUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(listUrl.searchParams.get('order')).toBe('desc')
    expect(listUrl.searchParams.has('includeConversationEntry')).toBe(false)

    const detailUrl = new URL(String(fetchMock.mock.calls.find((call) => String(call[0]).includes('/audit/entry'))?.[0]))
    expect(detailUrl.searchParams.get('byteOffset')).toBe('10')
    expect(detailUrl.searchParams.get('nextByteOffset')).toBe('220')
  })

  it('fetches distinct JSON details when selecting a different row', async () => {
    const page = auditPageFixture()
    page.items = [
      page.items[0],
      {
        ...page.items[0],
        id: 'canonical_session_jsonl:manager-1:221',
        byteOffset: 221,
        nextByteOffset: 480,
        title: 'Second audit row',
        summary: 'manager-1 emitted a different audit row',
        actorAgentId: 'manager-1',
        toolCallId: 'tool-2',
      },
    ]

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/audit/entry')) {
        const byteOffset = Number(url.searchParams.get('byteOffset'))
        return responseFor({
          sessionAgentId: 'manager-1',
          scope: 'session',
          sourceId: 'session',
          sourceKind: 'canonical_session_jsonl',
          relativePath: 'sessions/manager-1/session.jsonl',
          byteOffset,
          nextByteOffset: Number(url.searchParams.get('nextByteOffset')),
          rawBytes: 100,
          rawText: JSON.stringify({ byteOffset, detail: byteOffset === 221 ? 'second-row-detail' : 'first-row-detail' }),
          truncated: false,
          maxBytes: 8388608,
          formattedJson: JSON.stringify({ byteOffset, detail: byteOffset === 221 ? 'second-row-detail' : 'first-row-detail' }, null, 2),
        })
      }
      return responseFor(page)
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

    await waitFor(() => expect(document.body.textContent).toContain('first-row-detail'))
    fireEvent.click(getByRole(document.body, 'option', { name: /Second audit row/i }))
    await waitFor(() => expect(document.body.textContent).toContain('second-row-detail'))
    expect(document.body.textContent).toContain('bytes 221 → 480')

    const detailUrls = fetchMock.mock.calls
      .map((call) => new URL(String(call[0])))
      .filter((url) => url.pathname.endsWith('/audit/entry'))
    expect(detailUrls.map((url) => url.searchParams.get('byteOffset'))).toContain('10')
    expect(detailUrls.map((url) => url.searchParams.get('byteOffset'))).toContain('221')
    expect(detailUrls.at(-1)?.searchParams.get('nextByteOffset')).toBe('480')
  })

  it('supports formatted/raw toggle and truncated detail rendering', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/audit/entry')) {
        return responseFor({
          sessionAgentId: 'manager-1',
          scope: 'session',
          sourceId: 'session',
          sourceKind: 'canonical_session_jsonl',
          relativePath: 'sessions/manager-1/session.jsonl',
          byteOffset: 10,
          nextByteOffset: 220,
          rawBytes: 5000,
          rawText: '{"truncated":true}',
          truncated: true,
          maxBytes: 8388608,
          parseError: 'Row exceeds the 8388608 byte detail cap',
        })
      }
      return responseFor(auditPageFixture())
    }))

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

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Worker tool call/i })).toBeTruthy())
    await waitFor(() => expect(getByText(document.body, /detail cap/)).toBeTruthy())

    fireEvent.click(getByRole(document.body, 'button', { name: 'Raw' }))
    await waitFor(() => expect(getByRole(document.body, 'button', { name: 'Copy JSON' })).toBeTruthy())
    expect(document.body.textContent).toContain('{"truncated":true}')
  })

  it('keeps the inspector usable when filters change', async () => {
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

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Worker tool call/i })).toBeTruthy())
    await waitFor(() => expect(getByRole(document.body, 'button', { name: 'Copy JSON' })).toBeTruthy())

    fireEvent.change(getByPlaceholderText(document.body, 'wrapper/custom/conversation type'), { target: { value: 'filtered' } })
    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Worker tool call/i })).toBeTruthy())
    await waitFor(() => expect(getByRole(document.body, 'button', { name: 'Copy JSON' })).toBeTruthy())
  })

  it('uses plain scrollable rendering for large detail payloads without syntax highlighting', async () => {
    const hugeRaw = `{"payload":"${'z'.repeat(20_000)}"}`
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/audit/entry')) {
        return responseFor({
          sessionAgentId: 'manager-1',
          scope: 'session',
          sourceId: 'session',
          sourceKind: 'canonical_session_jsonl',
          relativePath: 'sessions/manager-1/session.jsonl',
          byteOffset: 10,
          nextByteOffset: 220,
          rawBytes: hugeRaw.length,
          rawText: hugeRaw,
          truncated: false,
          maxBytes: 8388608,
          formattedJson: undefined,
          parseError: 'Unexpected end of JSON input',
        })
      }
      return responseFor(auditPageFixture())
    }))

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

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Worker tool call/i })).toBeTruthy())
    await waitFor(() => expect(getByText(document.body, /plain scrollable view/i)).toBeTruthy())

    expect(vi.mocked(highlightCode)).not.toHaveBeenCalled()
    expect(document.body.querySelector('pre')?.textContent).toContain(hugeRaw.slice(0, 32))
    expect(document.body.querySelector('.syntax-highlight table')).toBeNull()

    fireEvent.click(getByRole(document.body, 'button', { name: 'Copy JSON' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(hugeRaw))
  })

  it('renders as a full-screen audit surface without a drawer resize dependency', async () => {
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

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Worker tool call/i })).toBeTruthy())
    const dialog = getByRole(document.body, 'dialog', { name: /session audit log/i }) as HTMLElement

    expect(dialog.style.inset).toBe('0')
    expect(dialog.style.width).toBe('100vw')
    expect(dialog.style.maxWidth).toBe('none')
    expect(dialog.style.height).toBe('100vh')
    expect(dialog.style.maxHeight).toBe('none')
    expect(dialog.style.margin).toBe('0px')
    expect(dialog.style.transform).toBe('none')
    expect(getByRole(document.body, 'button', { name: /close session audit log/i })).toBeTruthy()
    expect(document.body.querySelector('[aria-label="Resize session audit panel"]')).toBeNull()
    expect(window.localStorage.setItem).not.toHaveBeenCalled()
  })

  it('switches from manager to worker source with worker request params and no stale manager rows', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.searchParams.get('scope') === 'worker') {
        return responseFor(auditPageFixture({
          title: 'Worker source row',
          source: 'worker',
          workers: [workerSummary({ workerId: 'worker-1', displayName: 'Frontend Worker' })],
        }))
      }
      return responseFor(auditPageFixture({
        title: 'Manager source row',
        workers: [workerSummary({ workerId: 'worker-1', displayName: 'Frontend Worker' })],
      }))
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

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Manager source row/i })).toBeTruthy())
    openAuditSourceSelect()
    fireEvent.click(await waitForOption('Worker: Frontend Worker'))

    await waitFor(() => expect(queryByRole(document.body, 'option', { name: /Manager source row/i } )).toBeNull())
    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Worker source row/i })).toBeTruthy())

    const workerUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]))
    expect(workerUrl.searchParams.get('scope')).toBe('worker')
    expect(workerUrl.searchParams.get('workerId')).toBe('worker-1')
    expect(workerUrl.searchParams.get('sourceKind')).toBe('canonical_worker_jsonl')
  })

  it('switches from worker back to manager source with manager request params', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.searchParams.get('scope') === 'worker') {
        return responseFor(auditPageFixture({
          title: 'Worker source row',
          source: 'worker',
          workers: [workerSummary({ workerId: 'worker-1', displayName: 'Frontend Worker' })],
        }))
      }
      return responseFor(auditPageFixture({
        title: fetchMock.mock.calls.length > 1 ? 'Manager source row again' : 'Manager source row',
        workers: [workerSummary({ workerId: 'worker-1', displayName: 'Frontend Worker' })],
      }))
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

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Manager source row/i })).toBeTruthy())
    openAuditSourceSelect()
    fireEvent.click(await waitForOption('Worker: Frontend Worker'))
    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Worker source row/i })).toBeTruthy())

    openAuditSourceSelect()
    fireEvent.click(await waitForOption('Manager canonical JSONL'))

    await waitFor(() => expect(queryByRole(document.body, 'option', { name: /Worker source row/i } )).toBeNull())
    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Manager source row again/i })).toBeTruthy())
    const managerUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]))
    expect(managerUrl.searchParams.get('scope')).toBe('session')
    expect(managerUrl.searchParams.get('sourceKind')).toBe('canonical_session_jsonl')
    expect(managerUrl.searchParams.has('workerId')).toBe(false)
  })

  it('labels orphan worker sources as file-only when descriptor metadata is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseFor(auditPageFixture({
      workers: [workerSummary({ workerId: 'orphan-worker', descriptorPresent: false, displayName: undefined })],
    }))))

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

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Worker tool call/i })).toBeTruthy())
    openAuditSourceSelect()
    expect(await waitForOption('Worker: orphan-worker (file only)')).toBeTruthy()
  })

  it('does not show previous manager rows immediately after switching sessions', async () => {
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(SessionAuditDrawer, {
        open: true,
        onOpenChange: vi.fn(),
        sessionAgentId: 'manager-1',
        sessionLabel: 'Project / Session A',
        wsUrl: 'ws://127.0.0.1:47187/ws',
      }))
    })

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Worker tool call/i })).toBeTruthy())

    flushSync(() => {
      root?.render(createElement(SessionAuditDrawer, {
        open: true,
        onOpenChange: vi.fn(),
        sessionAgentId: 'manager-2',
        sessionLabel: 'Project / Session B',
        wsUrl: 'ws://127.0.0.1:47187/ws',
      }))
    })

    expect(queryByRole(document.body, 'option', { name: /Worker tool call/i } )).toBeNull()
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

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Worker tool call/i })).toBeTruthy())

    flushSync(() => {
      root?.render(createElement(SessionAuditDrawer, {
        open: true,
        onOpenChange: vi.fn(),
        sessionAgentId: null,
        sessionLabel: 'Worker',
        wsUrl: 'ws://127.0.0.1:47187/ws',
      }))
    })

    await waitFor(() => expect(queryByRole(document.body, 'option', { name: /Worker tool call/i } )).toBeNull())
    expect(getByText(document.body, 'No audit rows found')).toBeTruthy()
  })

  it('does not append a stale load-more page after filters change away and back', async () => {
    const loadMore = createDeferred<Response>()
    let unfilteredPage = 0
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
      unfilteredPage += 1
      return responseFor(auditPageFixture({ title: unfilteredPage === 1 ? 'Initial row' : 'Fresh row', hasMore: true, nextCursor: 'cursor-1' }))
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

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Initial row/i })).toBeTruthy())
    fireEvent.click(getByRole(document.body, 'button', { name: /load older audit rows/i }))
    fireEvent.change(getByPlaceholderText(document.body, 'wrapper/custom/conversation type'), { target: { value: 'filtered' } })
    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Filtered row/i })).toBeTruthy())
    fireEvent.change(getByPlaceholderText(document.body, 'wrapper/custom/conversation type'), { target: { value: '' } })
    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Fresh row/i })).toBeTruthy())

    loadMore.resolve(responseFor(auditPageFixture({ title: 'Stale old page', hasMore: false, nextCursor: undefined })))
    await settlePromises(loadMore.promise)

    expect(queryByRole(document.body, 'option', { name: /Stale old page/i } )).toBeNull()
    expect(queryByRole(document.body, 'option', { name: /Initial row/i } )).toBeNull()
    expect(queryByRole(document.body, 'option', { name: /Filtered row/i } )).toBeNull()
    expect(getByRole(document.body, 'option', { name: /Fresh row/i })).toBeTruthy()
  })

  it('does not append a stale load-more page after close and reopen with the same session', async () => {
    const loadMore = createDeferred<Response>()
    let initialPage = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.searchParams.get('cursor') === 'cursor-1') {
        return loadMore.promise
      }
      initialPage += 1
      return responseFor(auditPageFixture({ title: initialPage === 1 ? 'Before close row' : 'After reopen row', hasMore: true, nextCursor: 'cursor-1' }))
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

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /Before close row/i })).toBeTruthy())
    fireEvent.click(getByRole(document.body, 'button', { name: /load older audit rows/i }))

    flushSync(() => {
      root?.render(createElement(SessionAuditDrawer, {
        open: false,
        onOpenChange: vi.fn(),
        sessionAgentId: 'manager-1',
        sessionLabel: 'Project / Session',
        wsUrl: 'ws://127.0.0.1:47187/ws',
      }))
    })
    flushSync(() => {
      root?.render(createElement(SessionAuditDrawer, {
        open: true,
        onOpenChange: vi.fn(),
        sessionAgentId: 'manager-1',
        sessionLabel: 'Project / Session',
        wsUrl: 'ws://127.0.0.1:47187/ws',
      }))
    })

    await waitFor(() => expect(getByRole(document.body, 'option', { name: /After reopen row/i })).toBeTruthy())
    loadMore.resolve(responseFor(auditPageFixture({ title: 'Stale after reopen page', hasMore: false, nextCursor: undefined })))
    await settlePromises(loadMore.promise)

    expect(queryByRole(document.body, 'option', { name: /Stale after reopen page/i } )).toBeNull()
    expect(queryByRole(document.body, 'option', { name: /Before close row/i } )).toBeNull()
    expect(getByRole(document.body, 'option', { name: /After reopen row/i })).toBeTruthy()
  })
})

function openAuditSourceSelect(): void {
  const trigger = getByRole(document.body, 'combobox', { name: /audit source/i })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

async function waitForOption(name: string): Promise<HTMLElement> {
  return waitFor(() => getByRole(document.body, 'option', { name }))
}

function auditPageFixture(options: { title?: string; hasMore?: boolean; nextCursor?: string; source?: 'session' | 'worker'; workers?: ReturnType<typeof workerSummary>[] } = {}) {
  const source = options.source ?? 'session'
  const sourceId = source === 'worker' ? 'worker-1' : 'manager-1'
  const sourceKind = source === 'worker' ? 'canonical_worker_jsonl' : 'canonical_session_jsonl'
  const relativePath = source === 'worker' ? 'workers/worker-1.jsonl' : 'sessions/manager-1/session.jsonl'
  return {
    sessionAgentId: 'manager-1',
    manifest: { sessionAgentId: 'manager-1', sessionRelativePath: 'sessions/manager-1/session.jsonl', sessionBytes: 220, workers: options.workers ?? [] },
    scope: source,
    sourceId,
    sourceKind,
    order: 'desc',
    limit: 50,
    items: [
      {
        id: `${sourceKind}:${sourceId}:10`,
        scope: source,
        sourceId,
        sourceLabel: source === 'worker' ? 'Worker worker-1' : 'Manager session',
        sourceKind,
        relativePath,
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

function workerSummary(options: { workerId: string; displayName?: string; descriptorPresent?: boolean }) {
  return {
    workerId: options.workerId,
    displayName: options.displayName,
    status: options.descriptorPresent === false ? undefined : 'idle' as const,
    descriptorPresent: options.descriptorPresent ?? true,
    relativePath: `workers/${options.workerId}.jsonl`,
    bytes: 1234,
    updatedAt: '2026-06-17T12:00:00.000Z',
  }
}

function responseFor(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
  } as Response
}

async function settlePromises<T>(promise: Promise<T>): Promise<void> {
  await promise
  await Promise.resolve()
  await Promise.resolve()
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
