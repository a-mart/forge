/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByTestId, getByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CortexDocumentEntry, CortexFileReviewHistoryResult, GitCommitDetail, GitDiffResult, GitFileLogResult } from '@forge/protocol'
import { CortexHistoryPanel } from './CortexHistoryPanel'

const historyState = vi.hoisted(() => ({
  fileLogByOffset: new Map<number, { data: GitFileLogResult | null; isLoading: boolean; error: string | null; refetch: ReturnType<typeof vi.fn> }>(),
  reviewHistory: null as {
    data: CortexFileReviewHistoryResult | null
    isLoading: boolean
    error: string | null
    refetch: ReturnType<typeof vi.fn>
  } | null,
  commitDetail: null as {
    data: GitCommitDetail | null
    isLoading: boolean
    error: string | null
    refetch: ReturnType<typeof vi.fn>
  } | null,
  commitDiff: null as {
    data: GitDiffResult | null
    isLoading: boolean
    error: string | null
    refetch: ReturnType<typeof vi.fn>
  } | null,
}))

vi.mock('./use-cortex-history', () => ({
  useGitFileLog: (_wsUrl: string, _agentId: string | null | undefined, _file: string | null | undefined, _limit = 1, offset = 0) =>
    historyState.fileLogByOffset.get(offset) ?? {
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

vi.mock('@/components/diff-viewer/use-diff-queries', () => ({
  useGitCommitDetail: () =>
    historyState.commitDetail ?? {
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    },
  useGitCommitDiff: () =>
    historyState.commitDiff ?? {
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    },
}))

vi.mock('@/components/diff-viewer/DiffPane', () => ({
  DiffPane: ({ oldContent, newContent, fileName }: { oldContent: string | null; newContent: string | null; fileName: string | null }) =>
    createElement(
      'div',
      {
        'data-testid': 'mock-diff-pane',
        'data-old': oldContent ?? '',
        'data-new': newContent ?? '',
        'data-file-name': fileName ?? '',
      },
      `${oldContent ?? ''}=>${newContent ?? ''}`,
    ),
}))

let container: HTMLDivElement
let root: Root | null = null
const originalFetch = globalThis.fetch

const DOCUMENTS: CortexDocumentEntry[] = [
  {
    id: 'shared/knowledge/common.md',
    label: 'Common Knowledge',
    description: 'Shared knowledge base across profiles',
    group: 'commonKnowledge',
    surface: 'knowledge',
    absolutePath: '/data/shared/knowledge/common.md',
    gitPath: 'shared/knowledge/common.md',
    profileId: 'cortex',
    exists: true,
    sizeBytes: 128,
    editable: true,
  },
  {
    id: 'profiles/alpha/reference/guide.md',
    label: 'guide.md',
    description: 'Reference doc',
    group: 'referenceDocs',
    surface: 'reference',
    absolutePath: '/data/profiles/alpha/reference/guide.md',
    gitPath: 'profiles/alpha/reference/guide.md',
    profileId: 'alpha',
    exists: true,
    sizeBytes: 64,
    editable: true,
  },
]

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  Element.prototype.scrollIntoView ??= vi.fn()
  globalThis.ResizeObserver ??= class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver

  historyState.fileLogByOffset.clear()
  historyState.fileLogByOffset.set(0, {
    data: buildFileLogPage({ hasMore: true }),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })
  historyState.fileLogByOffset.set(12, {
    data: buildFileLogPage({
      commits: [
        {
          sha: 'cccccccccccccccc',
          shortSha: 'cccccccc',
          message: 'Older change',
          author: 'Cortex',
          date: '2026-03-27T09:00:00.000Z',
          filesChanged: 1,
          metadata: {
            source: 'agent-edit-tool',
            paths: [DOCUMENTS[0].gitPath],
          },
        },
      ],
      hasMore: false,
    }),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })
  historyState.reviewHistory = {
    data: buildReviewHistory(),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }
  historyState.commitDetail = {
    data: buildCommitDetail(),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }
  historyState.commitDiff = {
    data: {
      oldContent: '# Previous\nBefore',
      newContent: '# Previous\nAfter commit',
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/api/read-file') && method === 'POST') {
      return {
        ok: true,
        json: async () => ({ path: DOCUMENTS[0].absolutePath, content: '# Current\nLatest content' }),
      } as Response
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

function renderPanel(options?: {
  onExitHistoryMode?: () => void
  onOpenSession?: (agentId: string) => void
  onSelectDocument?: (documentId: string) => void
  onOpenDiffViewer?: (initialState: unknown) => void
  canOpenSession?: (agentId: string) => boolean
}) {
  if (!root) {
    root = createRoot(container)
  }

  flushSync(() => {
    root?.render(
      createElement(CortexHistoryPanel, {
        wsUrl: 'ws://127.0.0.1:47187',
        agentId: 'cortex',
        document: DOCUMENTS[0],
        documents: DOCUMENTS,
        pendingSelection: { reviewId: 'review-1', sha: 'aaaaaaaaaaaaaaaa' },
        onExitHistoryMode: options?.onExitHistoryMode ?? vi.fn(),
        onArtifactClick: vi.fn(),
        onOpenSession: options?.onOpenSession,
        canOpenSession: options?.canOpenSession,
        onSelectDocument: options?.onSelectDocument,
        onOpenDiffViewer: options?.onOpenDiffViewer,
      }),
    )
  })
}

function buildFileLogPage(overrides?: Partial<GitFileLogResult>): GitFileLogResult {
  return {
    file: DOCUMENTS[0].gitPath,
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaa',
        shortSha: 'aaaaaaaa',
        message: 'Most recent change',
        author: 'Cortex',
        date: '2026-03-29T12:00:00.000Z',
        filesChanged: 2,
        metadata: {
          source: 'profile-memory-merge',
          reviewRunId: 'review-1',
          paths: [DOCUMENTS[0].gitPath, DOCUMENTS[1].gitPath],
          profileId: 'alpha',
        },
      },
      {
        sha: 'bbbbbbbbbbbbbbbb',
        shortSha: 'bbbbbbbb',
        message: 'Earlier change',
        author: 'Cortex',
        date: '2026-03-28T09:00:00.000Z',
        filesChanged: 1,
        metadata: {
          source: 'agent-edit-tool',
          paths: [DOCUMENTS[0].gitPath],
        },
      },
    ],
    stats: {
      totalEdits: 6,
      lastModifiedAt: '2026-03-29T12:00:00.000Z',
      editsToday: 3,
      editsThisWeek: 6,
    },
    hasMore: false,
    ...overrides,
  }
}

function buildReviewHistory(overrides?: Partial<CortexFileReviewHistoryResult>): CortexFileReviewHistoryResult {
  const latestRun = {
    reviewId: 'review-1',
    recordedAt: '2026-03-29T13:00:00.000Z',
    status: 'success' as const,
    changedFiles: [DOCUMENTS[0].gitPath, DOCUMENTS[1].gitPath],
    notes: ['Updated common knowledge'],
    blockers: [],
    watermarksAdvanced: true,
    trigger: 'scheduled' as const,
    scopeLabel: 'nightly review run',
    sessionAgentId: 'review-session-1',
    scheduleName: 'nightly-cortex',
    manifestPath: '/tmp/review-1.md',
    manifestExists: true,
  }

  return {
    file: DOCUMENTS[0].gitPath,
    runs: [latestRun],
    latestRun,
    ...overrides,
  }
}

function buildCommitDetail(overrides?: Partial<GitCommitDetail>): GitCommitDetail {
  return {
    sha: 'aaaaaaaaaaaaaaaa',
    message: 'Most recent change',
    author: 'Cortex',
    date: '2026-03-29T12:00:00.000Z',
    files: [
      { path: DOCUMENTS[0].gitPath, status: 'modified', additions: 2, deletions: 1 },
      { path: DOCUMENTS[1].gitPath, status: 'modified', additions: 3, deletions: 0 },
    ],
    metadata: {
      source: 'profile-memory-merge',
      reviewRunId: 'review-1',
      paths: [DOCUMENTS[0].gitPath, DOCUMENTS[1].gitPath],
      profileId: 'alpha',
    },
    ...overrides,
  }
}

describe('CortexHistoryPanel', () => {
  it('renders the history stack, activity summary, stats, and review actions', async () => {
    renderPanel({ canOpenSession: () => true })
    await flushPromises()

    expect(getByTestId(container, 'cortex-history-panel')).toBeTruthy()
    expect(getByTestId(container, 'cortex-history-activity-summary').textContent).toContain('3 edits today, 6 edits this week.')
    expect(getByTestId(container, 'cortex-history-activity-summary').textContent).toContain('nightly review run')

    const stats = getByTestId(container, 'cortex-file-history-stats')
    expect(stats.textContent).toContain('Last modified')
    expect(stats.textContent).toContain('Total edits')
    expect(stats.textContent).toContain('6')

    const card = getByTestId(container, 'cortex-last-review-run-card')
    expect(card.textContent).toContain('View manifest')
    expect(card.textContent).toContain('Open review session')
    expect(card.textContent).toContain('View changes')
    expect(card.textContent).toContain('Common Knowledge')
    expect(card.textContent).toContain('Reference Docs')
  })

  it('renders commit timeline rows and loads more commits', async () => {
    renderPanel()
    await flushPromises()

    const timeline = getByTestId(container, 'cortex-file-timeline')
    expect(timeline.textContent).toContain('Updated profile memory for alpha')
    expect(timeline.textContent).toContain('Memory merge')

    fireEvent.click(getByRole(container, 'button', { name: 'Load more' }))
    await flushPromises()

    expect(timeline.textContent).toContain('cccccccc')
  })

  it('supports arrow-key navigation and Escape to exit history mode', async () => {
    const onExitHistoryMode = vi.fn()
    renderPanel({ onExitHistoryMode })
    await flushPromises()

    const panel = getByTestId(container, 'cortex-history-panel')
    const timelineButtons = Array.from(
      container.querySelectorAll('[data-testid="cortex-file-timeline"] button[aria-pressed]'),
    ) as HTMLButtonElement[]
    expect(timelineButtons[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(timelineButtons[1]?.getAttribute('aria-pressed')).toBe('false')

    fireEvent.keyDown(panel, { key: 'ArrowDown' })
    await flushPromises()

    const updatedButtons = Array.from(
      container.querySelectorAll('[data-testid="cortex-file-timeline"] button[aria-pressed]'),
    ) as HTMLButtonElement[]
    expect(updatedButtons[0]?.getAttribute('aria-pressed')).toBe('false')
    expect(updatedButtons[1]?.getAttribute('aria-pressed')).toBe('true')

    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(onExitHistoryMode).toHaveBeenCalledTimes(1)
  })

  it('switches the diff into compare-with-current mode', async () => {
    renderPanel()
    await flushPromises()

    const diffPane = getByTestId(container, 'mock-diff-pane')
    expect(diffPane.getAttribute('data-old')).toBe('# Previous\nBefore')
    expect(diffPane.getAttribute('data-new')).toBe('# Previous\nAfter commit')

    fireEvent.click(getByRole(container, 'switch', { name: 'Compare with current' }))

    await waitFor(() => {
      expect(getByTestId(container, 'mock-diff-pane').getAttribute('data-old')).toBe('# Previous\nAfter commit')
      expect(getByTestId(container, 'mock-diff-pane').getAttribute('data-new')).toBe('# Current\nLatest content')
    })
  })

  it('lists sibling files and switches documents when clicked', async () => {
    const onSelectDocument = vi.fn()
    renderPanel({ onSelectDocument })
    await flushPromises()

    const siblingList = getByTestId(container, 'cortex-history-sibling-files')
    expect(siblingList.textContent).toContain('Changed together with')
    expect(siblingList.textContent).toContain('profiles/alpha/reference/guide.md')
    expect(siblingList.textContent).toContain('Reference Docs')

    fireEvent.click(getByRole(siblingList, 'button', { name: /profiles\/alpha\/reference\/guide.md/i }))
    expect(onSelectDocument).toHaveBeenCalledWith('profiles/alpha/reference/guide.md')
  })

  it('opens the full diff viewer with the current file and commit preselected', async () => {
    const onOpenDiffViewer = vi.fn()
    renderPanel({ onOpenDiffViewer })
    await flushPromises()

    fireEvent.click(getByTestId(container, 'cortex-open-full-viewer'))

    expect(onOpenDiffViewer).toHaveBeenCalledWith({
      initialRepoTarget: 'versioning',
      initialTab: 'history',
      initialSha: 'aaaaaaaaaaaaaaaa',
      initialFile: 'shared/knowledge/common.md',
      initialQuickFilter: 'shared-knowledge',
    })
  })

  it('degrades gracefully when the versioning repo is not initialized', async () => {
    historyState.fileLogByOffset.set(0, {
      data: buildFileLogPage({
        commits: [],
        stats: {
          totalEdits: 0,
          lastModifiedAt: null,
          editsToday: 0,
          editsThisWeek: 0,
        },
        hasMore: false,
        notInitialized: true,
      }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    })

    renderPanel()
    await flushPromises()

    expect(getByTestId(container, 'cortex-history-activity-summary').textContent).toContain('Versioning history is not available')
    expect(getByText(container, 'Initialize the versioning repo to unlock file-local history.')).toBeTruthy()
    expect((getByTestId(container, 'cortex-open-full-viewer') as HTMLButtonElement).disabled).toBe(true)
  })
})
