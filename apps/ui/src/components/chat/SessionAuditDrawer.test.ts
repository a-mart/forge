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
    expect(getByText(document.body, 'Manager canonical JSONL')).toBeTruthy()
    expect(getByText(document.body, 'sessions/manager-1/session.jsonl')).toBeTruthy()
    expect(getByText(document.body, '10 → 220')).toBeTruthy()
    expect(getByText(document.body, 'normal_view_hidden')).toBeTruthy()
    expect(queryByText(document.body, 'tool result raw')).toBeNull()

    fireEvent.click(getByRole(document.body, 'button', { name: /show capped json preview/i }))
    await waitFor(() => expect(getByText(document.body, 'tool result raw')).toBeTruthy())

    const requestUrl = new URL((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)
    expect(requestUrl.searchParams.get('order')).toBe('desc')
    expect(requestUrl.searchParams.has('includeConversationEntry')).toBe(false)
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

    await waitFor(() => expect(getByText(document.body, 'Worker tool call')).toBeTruthy())
    const dialog = getByRole(document.body, 'dialog', { name: /session audit log/i }) as HTMLElement

    expect(dialog.style.width).toBe('calc(100vw - 24px)')
    expect(dialog.style.maxWidth).toBe('none')
    expect(dialog.style.height).toBe('calc(100vh - 24px)')
    expect(dialog.style.maxHeight).toBe('calc(100vh - 24px)')
    expect(dialog.style.transform).toBe('none')
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

    await waitFor(() => expect(getByText(document.body, 'Manager source row')).toBeTruthy())
    openAuditSourceSelect()
    fireEvent.click(await waitForOption('Worker: Frontend Worker'))

    await waitFor(() => expect(queryByText(document.body, 'Manager source row')).toBeNull())
    await waitFor(() => expect(getByText(document.body, 'Worker source row')).toBeTruthy())

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

    await waitFor(() => expect(getByText(document.body, 'Manager source row')).toBeTruthy())
    openAuditSourceSelect()
    fireEvent.click(await waitForOption('Worker: Frontend Worker'))
    await waitFor(() => expect(getByText(document.body, 'Worker source row')).toBeTruthy())

    openAuditSourceSelect()
    fireEvent.click(await waitForOption('Manager canonical JSONL'))

    await waitFor(() => expect(queryByText(document.body, 'Worker source row')).toBeNull())
    await waitFor(() => expect(getByText(document.body, 'Manager source row again')).toBeTruthy())
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

    await waitFor(() => expect(getByText(document.body, 'Worker tool call')).toBeTruthy())
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

    await waitFor(() => expect(getByText(document.body, 'Worker tool call')).toBeTruthy())

    flushSync(() => {
      root?.render(createElement(SessionAuditDrawer, {
        open: true,
        onOpenChange: vi.fn(),
        sessionAgentId: 'manager-2',
        sessionLabel: 'Project / Session B',
        wsUrl: 'ws://127.0.0.1:47187/ws',
      }))
    })

    expect(queryByText(document.body, 'Worker tool call')).toBeNull()
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

    await waitFor(() => expect(getByText(document.body, 'Initial row')).toBeTruthy())
    fireEvent.click(getByRole(document.body, 'button', { name: /load older audit rows/i }))
    fireEvent.change(getByPlaceholderText(document.body, 'wrapper/custom/conversation type'), { target: { value: 'filtered' } })
    await waitFor(() => expect(getByText(document.body, 'Filtered row')).toBeTruthy())
    fireEvent.change(getByPlaceholderText(document.body, 'wrapper/custom/conversation type'), { target: { value: '' } })
    await waitFor(() => expect(getByText(document.body, 'Fresh row')).toBeTruthy())

    loadMore.resolve(responseFor(auditPageFixture({ title: 'Stale old page', hasMore: false, nextCursor: undefined })))
    await settlePromises(loadMore.promise)

    expect(queryByText(document.body, 'Stale old page')).toBeNull()
    expect(queryByText(document.body, 'Initial row')).toBeNull()
    expect(queryByText(document.body, 'Filtered row')).toBeNull()
    expect(getByText(document.body, 'Fresh row')).toBeTruthy()
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

    await waitFor(() => expect(getByText(document.body, 'Before close row')).toBeTruthy())
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

    await waitFor(() => expect(getByText(document.body, 'After reopen row')).toBeTruthy())
    loadMore.resolve(responseFor(auditPageFixture({ title: 'Stale after reopen page', hasMore: false, nextCursor: undefined })))
    await settlePromises(loadMore.promise)

    expect(queryByText(document.body, 'Stale after reopen page')).toBeNull()
    expect(queryByText(document.body, 'Before close row')).toBeNull()
    expect(getByText(document.body, 'After reopen row')).toBeTruthy()
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
