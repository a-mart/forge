/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByTestId, queryByTestId, waitFor } from '@testing-library/dom'
import { createElement, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CortexDocumentEntry,
  CortexFileReviewHistoryResult,
  GitFileLogResult,
  GitFileSectionProvenanceResult,
} from '@forge/protocol'
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
  sectionProvenance: null as {
    data: GitFileSectionProvenanceResult | null
    isLoading: boolean
    error: string | null
    refetch: ReturnType<typeof vi.fn>
  } | null,
  commitDetail: {
    data: {
      sha: 'abcdef1234567890',
      message: 'Knowledge update',
      author: 'Cortex',
      date: '2026-03-29T12:00:00.000Z',
      files: [{ path: 'shared/knowledge/common.md', status: 'modified', additions: 1, deletions: 1 }],
      metadata: {
        source: 'profile-memory-merge',
        reviewRunId: 'review-1',
        paths: ['shared/knowledge/common.md'],
      },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  },
  commitDiff: {
    data: {
      oldContent: '# Before\nBody\n',
      newContent: '# After\nBody\n',
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  },
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
  useGitFileSectionProvenance: () =>
    historyState.sectionProvenance ?? {
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    },
}))

vi.mock('../MarkdownMessage', () => ({
  MarkdownMessage: ({
    content,
    renderHeadingAdornment,
  }: {
    content: string
    renderHeadingAdornment?: (heading: { level: 1 | 2 | 3 | 4; text: string; index: number }) => ReactNode
  }) => {
    const counts = new Map<string, number>()
    const headingNodes = content
      .split(/\r?\n/)
      .map((line) => /^(#{1,4})\s+(.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => {
        const level = match[1].length as 1 | 2 | 3 | 4
        const text = match[2].trim()
        const key = `${level}:${text}`
        const index = counts.get(key) ?? 0
        counts.set(key, index + 1)
        return createElement(
          'div',
          { key: `${key}:${index}`, 'data-heading-level': String(level) },
          createElement('span', null, text),
          renderHeadingAdornment ? renderHeadingAdornment({ level, text, index }) : null,
        )
      })

    return createElement(
      Fragment,
      null,
      createElement('div', { 'data-testid': 'markdown-message' }, content),
      createElement('div', { 'data-testid': 'markdown-headings' }, headingNodes),
    )
  },
}))

vi.mock('@/components/diff-viewer/use-diff-queries', () => ({
  useGitCommitDetail: () => historyState.commitDetail,
  useGitCommitDiff: () => historyState.commitDiff,
}))

vi.mock('@/components/diff-viewer/DiffPane', () => ({
  DiffPane: ({ oldContent, newContent }: { oldContent: string | null; newContent: string | null }) =>
    createElement('div', { 'data-testid': 'mock-diff-pane', 'data-old': oldContent ?? '', 'data-new': newContent ?? '' }),
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
  globalThis.ResizeObserver ??= class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver
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
  historyState.sectionProvenance = {
    data: buildSectionProvenanceResult(),
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
        json: async () => ({
          path: body.path ?? DOCUMENT.absolutePath,
          content: '# Common Knowledge\n\n## Workflow Preferences\nBody\n',
        }),
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

function buildSectionProvenanceResult(overrides?: Partial<GitFileSectionProvenanceResult>): GitFileSectionProvenanceResult {
  return {
    file: DOCUMENT.gitPath,
    sections: [
      {
        heading: 'Common Knowledge',
        level: 1,
        lineStart: 1,
        lineEnd: 2,
        lastModifiedSha: 'abcdef1234567890',
        lastModifiedAt: '2026-03-29T12:00:00.000Z',
        lastModifiedSummary: 'Knowledge update',
        reviewRunId: null,
      },
      {
        heading: 'Workflow Preferences',
        level: 2,
        lineStart: 3,
        lineEnd: 5,
        lastModifiedSha: 'abcdef1234567890',
        lastModifiedAt: '2026-03-29T12:00:00.000Z',
        lastModifiedSummary: 'Knowledge update',
        reviewRunId: 'review-1',
      },
    ],
    ...overrides,
  }
}

describe('KnowledgeFileViewer', () => {
  it('toggles from content mode into the history layout', async () => {
    renderViewer()
    await flushPromises()

    expect(getByTestId(container, 'markdown-message')).toBeTruthy()
    fireEvent.click(getByTestId(container, 'cortex-history-toggle'))
    await flushPromises()

    expect(getByTestId(container, 'cortex-history-panel')).toBeTruthy()
    expect(queryByTestId(container, 'markdown-message')).toBeNull()
  })

  it('renders the metadata strip from file-log stats', async () => {
    renderViewer()
    await flushPromises()

    const metaStrip = getByTestId(container, 'cortex-document-meta-strip')
    expect(metaStrip.textContent).toContain('Modified')
    expect(metaStrip.textContent).toContain('5 edits')
    expect(metaStrip.textContent).toContain('active today')
  })

  it('renders section provenance badges for markdown headings in content mode', async () => {
    renderViewer()
    await flushPromises()

    const badge = getByTestId(container, 'cortex-section-provenance-workflow-preferences')
    expect(badge.textContent).toContain('Mar')
    expect(badge.textContent).toContain('review-1')
  })

  it('shows the recent change banner only when the latest review touched the current file', async () => {
    renderViewer({ canOpenSession: () => false })
    await flushPromises()

    const banner = getByTestId(container, 'cortex-recent-change-banner')
    expect(banner.textContent).toContain('Latest Cortex review touched this file.')

    const openRunButton = getByRole(container, 'button', { name: /open run/i }) as HTMLButtonElement
    expect(openRunButton.disabled).toBe(true)

    fireEvent.click(getByRole(container, 'button', { name: 'View changes' }))
    await flushPromises()

    expect(getByTestId(container, 'cortex-history-panel')).toBeTruthy()
    expect(queryByTestId(container, 'cortex-file-history-stats')).toBeNull()
    expect(getByTestId(container, 'cortex-file-timeline').textContent).toContain('Version history')
    expect(container.querySelector('[data-testid="cortex-document-viewer-shell"]')?.getAttribute('data-mode')).toBe('history')

    historyState.reviewHistory = {
      data: buildReviewHistoryResult({
        latestRun: {
          reviewId: 'review-2',
          recordedAt: '2026-03-29T14:00:00.000Z',
          status: 'success',
          changedFiles: ['profiles/alpha/memory.md'],
          notes: [],
          blockers: [],
          watermarksAdvanced: true,
          manifestExists: false,
        },
        runs: [],
      }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }

    flushSync(() => {
      root?.unmount()
    })
    root = null

    renderViewer({ canOpenSession: () => false })
    await flushPromises()

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
    historyState.sectionProvenance = {
      data: buildSectionProvenanceResult({ sections: [] }),
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
