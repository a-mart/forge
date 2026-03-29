/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByTestId, queryByTestId, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CortexDocumentEntry, CortexFileReviewHistoryResult, GitFileLogResult } from '@forge/protocol'
import { KnowledgeFileViewer } from './KnowledgeFileViewer'

const historyState = vi.hoisted(() => ({
  fileLog: null as {
    data: GitFileLogResult | null
    isLoading: boolean
    error: string | null
    refetch: ReturnType<typeof vi.fn>
  } | null,
  reviewHistory: null as {
    data: CortexFileReviewHistoryResult | null
    isLoading: boolean
    error: string | null
    refetch: ReturnType<typeof vi.fn>
  } | null,
}))

vi.mock('./use-cortex-history', () => ({
  useGitFileLog: () =>
    historyState.fileLog ?? {
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    },
  useCortexFileReviewHistory: () =>
    historyState.reviewHistory ?? {
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    },
}))

vi.mock('../MarkdownMessage', () => ({
  MarkdownMessage: ({ content }: { content: string }) => createElement('div', { 'data-testid': 'markdown-message' }, content),
}))

let container: HTMLDivElement
let root: Root | null = null
const originalFetch = globalThis.fetch

const DOCUMENT: CortexDocumentEntry = {
  id: 'shared/knowledge/common.md',
  label: 'Common Knowledge',
  description: 'Shared knowledge base across all profiles',
  group: 'commonKnowledge',
  surface: 'knowledge',
  absolutePath: '/data/shared/knowledge/common.md',
  gitPath: 'shared/knowledge/common.md',
  profileId: 'cortex',
  exists: true,
  sizeBytes: 128,
  editable: true,
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  Element.prototype.scrollIntoView ??= vi.fn()
  historyState.fileLog = {
    data: buildFileLogResult(),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }
  historyState.reviewHistory = {
    data: buildReviewHistoryResult(),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    if (url.endsWith('/api/read-file') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { path?: string }
      return {
        ok: true,
        json: async () => ({ path: body.path ?? DOCUMENT.absolutePath, content: '# Common Knowledge\nBody\n' }),
      } as Response
    }

    if (url.endsWith('/api/write-file') && method === 'POST') {
      return { ok: true, json: async () => ({ ok: true }) } as Response
    }

    if (url.includes('/api/agents/review-session-1/system-prompt') && method === 'GET') {
      return { ok: true, json: async () => ({ systemPrompt: 'ok' }) } as Response
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`)
  }) as typeof fetch
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

function renderViewer(options?: { canOpenSession?: (agentId: string) => boolean; onOpenSession?: (agentId: string) => void }) {
  if (!root) {
    root = createRoot(container)
  }

  flushSync(() => {
    root?.render(
      createElement(KnowledgeFileViewer, {
        wsUrl: 'ws://127.0.0.1:47187',
        document: DOCUMENT,
        documents: [DOCUMENT],
        agentId: 'cortex',
        onArtifactClick: vi.fn(),
        onOpenSession: options?.onOpenSession,
        canOpenSession: options?.canOpenSession,
      }),
    )
  })
}

function buildFileLogResult(overrides?: Partial<GitFileLogResult>): GitFileLogResult {
  return {
    file: DOCUMENT.gitPath,
    commits: [
      {
        sha: 'abcdef1234567890',
        shortSha: 'abcdef12',
        message: 'Knowledge update',
        author: 'Cortex',
        date: '2026-03-29T12:00:00.000Z',
        filesChanged: 1,
      },
    ],
    stats: {
      totalEdits: 5,
      lastModifiedAt: '2026-03-29T12:00:00.000Z',
      editsToday: 2,
      editsThisWeek: 4,
    },
    hasMore: false,
    ...overrides,
  }
}

function buildReviewHistoryResult(overrides?: Partial<CortexFileReviewHistoryResult>): CortexFileReviewHistoryResult {
  return {
    file: DOCUMENT.gitPath,
    runs: [
      {
        reviewId: 'review-1',
        recordedAt: '2026-03-29T13:00:00.000Z',
        status: 'success',
        changedFiles: [DOCUMENT.gitPath],
        notes: ['Updated common knowledge'],
        blockers: [],
        watermarksAdvanced: true,
        trigger: 'scheduled',
        scopeLabel: 'nightly review',
        sessionAgentId: 'review-session-1',
        scheduleName: 'nightly-cortex',
        manifestExists: true,
      },
    ],
    latestRun: {
      reviewId: 'review-1',
      recordedAt: '2026-03-29T13:00:00.000Z',
      status: 'success',
      changedFiles: [DOCUMENT.gitPath],
      notes: ['Updated common knowledge'],
      blockers: [],
      watermarksAdvanced: true,
      trigger: 'scheduled',
      scopeLabel: 'nightly review',
      sessionAgentId: 'review-session-1',
      scheduleName: 'nightly-cortex',
      manifestExists: true,
    },
    ...overrides,
  }
}

describe('KnowledgeFileViewer', () => {
  it('renders the metadata strip from file-log stats', async () => {
    renderViewer()
    await flushPromises()

    const metaStrip = getByTestId(container, 'cortex-document-meta-strip')
    expect(metaStrip.textContent).toContain('Modified')
    expect(metaStrip.textContent).toContain('5 edits')
    expect(metaStrip.textContent).toContain('active today')
  })

  it('shows the recent change banner and toggles into history mode', async () => {
    renderViewer({ canOpenSession: () => false })
    await flushPromises()

    const banner = getByTestId(container, 'cortex-recent-change-banner')
    expect(banner.textContent).toContain('Latest Cortex review touched this file.')

    const openRunButton = getByRole(container, 'button', { name: /open run/i }) as HTMLButtonElement
    expect(openRunButton.disabled).toBe(true)

    fireEvent.click(getByRole(container, 'button', { name: 'View changes' }))
    await flushPromises()

    expect(container.querySelector('[data-testid="cortex-document-viewer-shell"]')?.getAttribute('data-mode')).toBe('history')
    expect(queryByTestId(container, 'cortex-recent-change-banner')).toBeNull()
  })

  it('disables the history toggle while there are unsaved edits', async () => {
    renderViewer()
    await flushPromises()

    fireEvent.click(getByRole(container, 'button', { name: 'Edit file' }))
    await flushPromises()

    const historyToggle = getByTestId(container, 'cortex-history-toggle') as HTMLButtonElement
    expect(historyToggle.disabled).toBe(false)

    fireEvent.change(getByRole(container, 'textbox'), {
      target: { value: '# Common Knowledge\nChanged body\n' },
    })

    await waitFor(() => {
      expect((getByTestId(container, 'cortex-history-toggle') as HTMLButtonElement).disabled).toBe(true)
    })
  })

  it('gracefully degrades when the versioning repo is not initialized', async () => {
    historyState.fileLog = {
      data: buildFileLogResult({
        commits: [],
        stats: {
          totalEdits: 0,
          lastModifiedAt: null,
          editsToday: 0,
          editsThisWeek: 0,
        },
        notInitialized: true,
      }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
    historyState.reviewHistory = {
      data: buildReviewHistoryResult({ runs: [], latestRun: null }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }

    renderViewer()
    await flushPromises()

    expect(getByTestId(container, 'cortex-document-meta-strip').textContent).toContain('No history available.')
    expect(queryByTestId(container, 'cortex-recent-change-banner')).toBeNull()
  })
})
