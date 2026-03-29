/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByTestId, waitFor } from '@testing-library/dom'
import { createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitDiffResult, GitLogEntry } from '@forge/protocol'
import { CortexVersionDiffDialog } from './CortexVersionDiffDialog'
import { buildVersionNumber } from './history-format'

const diffState = vi.hoisted(() => ({
  commitDiffBySha: new Map<string, { data: GitDiffResult | null; isLoading: boolean; error: string | null; refetch: ReturnType<typeof vi.fn> }>(),
}))

vi.mock('@/components/diff-viewer/use-diff-queries', () => ({
  useGitCommitDiff: (_wsUrl: string, _agentId: string | null, _repoTarget: string, sha: string | null) =>
    diffState.commitDiffBySha.get(sha ?? '') ?? {
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    },
}))

vi.mock('@/components/diff-viewer/DiffPane', () => ({
  DiffPane: ({ oldContent, newContent, fileName }: { oldContent: string | null; newContent: string | null; fileName: string | null }) =>
    createElement('div', {
      'data-testid': 'mock-version-diff-pane',
      'data-old': oldContent ?? '',
      'data-new': newContent ?? '',
      'data-file-name': fileName ?? '',
    }),
}))

let container: HTMLDivElement
let root: Root | null = null
const originalFetch = globalThis.fetch
const fetchSpyState = { writeBodies: [] as Array<{ path: string; content: string; versioningSource?: string }> }

const INITIAL_COMMITS: GitLogEntry[] = [
  {
    sha: 'aaaaaaaaaaaaaaaa',
    shortSha: 'aaaaaaaa',
    message: 'Current version',
    author: 'Cortex',
    date: '2026-03-29T12:00:00.000Z',
    filesChanged: 1,
    metadata: {
      source: 'profile-memory-merge',
      reviewRunId: 'review-1',
      paths: ['shared/knowledge/common.md'],
      sessionId: 'cortex--s96',
    },
  },
  {
    sha: 'bbbbbbbbbbbbbbbb',
    shortSha: 'bbbbbbbb',
    message: 'Earlier version',
    author: 'Cortex',
    date: '2026-03-29T10:00:00.000Z',
    filesChanged: 1,
    metadata: {
      source: 'profile-memory-merge',
      reviewRunId: 'review-0',
      paths: ['shared/knowledge/common.md'],
      sessionId: 'cortex--s95',
    },
  },
  {
    sha: 'cccccccccccccccc',
    shortSha: 'cccccccc',
    message: 'Older version',
    author: 'Cortex',
    date: '2026-03-28T15:00:00.000Z',
    filesChanged: 1,
    metadata: {
      source: 'reconcile',
      paths: ['shared/knowledge/common.md'],
    },
  },
]

const OLDER_COMMIT: GitLogEntry = {
  sha: 'dddddddddddddddd',
  shortSha: 'dddddddd',
  message: 'Oldest version',
  author: 'Cortex',
  date: '2026-03-27T15:00:00.000Z',
  filesChanged: 1,
  metadata: {
    source: 'agent-edit-tool',
    paths: ['shared/knowledge/common.md'],
  },
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-29T15:00:00.000Z'))

  container = document.createElement('div')
  document.body.appendChild(container)
  Element.prototype.scrollIntoView ??= vi.fn()
  globalThis.ResizeObserver ??= class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver

  fetchSpyState.writeBodies = []
  diffState.commitDiffBySha.clear()
  diffState.commitDiffBySha.set('aaaaaaaaaaaaaaaa', {
    data: { oldContent: '# Before\nv20\n', newContent: '# Restored\nv21\n' },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })
  diffState.commitDiffBySha.set('bbbbbbbbbbbbbbbb', {
    data: { oldContent: '# Before\nv19\n', newContent: '# Restored\nv20\n' },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })
  diffState.commitDiffBySha.set('cccccccccccccccc', {
    data: { oldContent: '# Before\nv18\n', newContent: '# Restored\nv19\n' },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })
  diffState.commitDiffBySha.set('dddddddddddddddd', {
    data: { oldContent: '# Before\nv17\n', newContent: '# Restored\nv18\n' },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    if (url.endsWith('/api/read-file') && method === 'POST') {
      return {
        ok: true,
        json: async () => ({ path: '/data/shared/knowledge/common.md', content: '# Current\nLive version\n' }),
      } as Response
    }

    if (url.endsWith('/api/write-file') && method === 'POST') {
      fetchSpyState.writeBodies.push(JSON.parse(String(init?.body ?? '{}')) as { path: string; content: string; versioningSource?: string })
      return { ok: true, json: async () => ({ success: true }) } as Response
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
  document.body.innerHTML = ''
  container.remove()
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await vi.runAllTimersAsync()
  flushSync(() => {})
}

function mount(node: ReturnType<typeof createElement>) {
  if (!root) {
    root = createRoot(container)
  }

  flushSync(() => {
    root?.render(node)
  })
}

function TestHarness({
  onOpenChange,
  onRestoreSuccess,
}: {
  onOpenChange?: (open: boolean) => void
  onRestoreSuccess?: () => void
}) {
  const [commits, setCommits] = useState(INITIAL_COMMITS)
  const [selectedSha, setSelectedSha] = useState(INITIAL_COMMITS[0]?.sha ?? null)
  const selectedIndex = selectedSha ? commits.findIndex((commit) => commit.sha === selectedSha) : -1
  const selectedCommit = selectedIndex >= 0 ? commits[selectedIndex] ?? null : null
  const totalEdits = 21
  const selectedVersionNumber = selectedIndex >= 0 ? buildVersionNumber(selectedIndex, totalEdits, commits.length) : null
  const comparisonVersionNumber = selectedVersionNumber && selectedVersionNumber > 1 ? selectedVersionNumber - 1 : null

  return createElement(CortexVersionDiffDialog, {
    open: true,
    wsUrl: 'ws://127.0.0.1:47187',
    agentId: 'cortex',
    absolutePath: '/data/shared/knowledge/common.md',
    gitPath: 'shared/knowledge/common.md',
    documentLabel: 'Common Knowledge',
    commits,
    totalEdits,
    selectedCommit,
    selectedVersionNumber,
    comparisonVersionNumber,
    currentVersionNumber: 21,
    hasMoreVersions: commits.length < 4,
    isLoadingVersions: false,
    isLoadingMoreVersions: false,
    onSelectCommit: setSelectedSha,
    onLoadMoreVersions: () => setCommits((previous) => (previous.some((commit) => commit.sha === OLDER_COMMIT.sha) ? previous : [...previous, OLDER_COMMIT])),
    onOpenChange: onOpenChange ?? vi.fn(),
    onRestoreSuccess: onRestoreSuccess ?? vi.fn(),
  })
}

function renderDialog(options?: {
  onOpenChange?: (open: boolean) => void
  onRestoreSuccess?: () => void
}) {
  mount(createElement(TestHarness, options ?? {}))
}

describe('CortexVersionDiffDialog', () => {
  it('shows the commit diff by default', async () => {
    renderDialog()
    await flushPromises()

    expect(getByTestId(document.body, 'cortex-version-diff-dialog').textContent).toContain('Current (v21) compared to v20')
    const diffPane = getByTestId(document.body, 'mock-version-diff-pane')
    expect(diffPane.getAttribute('data-old')).toBe('# Before\nv20\n')
    expect(diffPane.getAttribute('data-new')).toBe('# Restored\nv21\n')
  })

  it('renders a version sidebar inside the modal', async () => {
    renderDialog()
    await flushPromises()

    const sidebar = getByTestId(document.body, 'cortex-version-diff-sidebar')
    expect(sidebar.textContent).toContain('v21')
    expect(sidebar.textContent).toContain('3h ago')
    expect(sidebar.textContent).toContain('session cortex--s96')
    expect(sidebar.textContent).toContain('Load more versions')
  })

  it('switches the diff when a different version is clicked in the sidebar', async () => {
    renderDialog()
    await flushPromises()

    fireEvent.click(getByRole(getByTestId(document.body, 'cortex-version-diff-sidebar'), 'option', { name: /v20, 5h ago, session cortex--s95, by cortex/i }))

    await waitFor(() => {
      expect(getByTestId(document.body, 'cortex-version-diff-dialog').textContent).toContain('v20 compared to v19')
      expect(getByTestId(document.body, 'mock-version-diff-pane').getAttribute('data-old')).toBe('# Before\nv19\n')
      expect(getByTestId(document.body, 'mock-version-diff-pane').getAttribute('data-new')).toBe('# Restored\nv20\n')
    })
  })

  it('highlights the currently viewed version in the sidebar', async () => {
    renderDialog()
    await flushPromises()

    const selectedOption = getByTestId(document.body, 'cortex-version-option-aaaaaaaaaaaaaaaa')
    const otherOption = getByTestId(document.body, 'cortex-version-option-bbbbbbbbbbbbbbbb')
    expect(selectedOption.getAttribute('aria-selected')).toBe('true')
    expect(otherOption.getAttribute('aria-selected')).toBe('false')

    fireEvent.click(otherOption)
    await flushPromises()

    expect(selectedOption.getAttribute('aria-selected')).toBe('false')
    expect(otherOption.getAttribute('aria-selected')).toBe('true')
  })

  it('loads more versions in the modal sidebar', async () => {
    renderDialog()
    await flushPromises()

    const sidebar = getByTestId(document.body, 'cortex-version-diff-sidebar')
    expect(sidebar.textContent).not.toContain('v18')

    fireEvent.click(getByRole(sidebar, 'button', { name: 'Load more versions' }))
    await flushPromises()

    expect(sidebar.textContent).toContain('v18')
    expect(sidebar.textContent).toContain('edit tool')
  })

  it('switches to compare with current content', async () => {
    renderDialog()
    await flushPromises()

    fireEvent.click(getByRole(document.body, 'switch', { name: 'Compare with current' }))

    await waitFor(() => {
      expect(getByTestId(document.body, 'mock-version-diff-pane').getAttribute('data-old')).toBe('# Restored\nv21\n')
      expect(getByTestId(document.body, 'mock-version-diff-pane').getAttribute('data-new')).toBe('# Current\nLive version\n')
    })
  })

  it('restores the selected version from the modal', async () => {
    const onOpenChange = vi.fn()
    const onRestoreSuccess = vi.fn()
    renderDialog({ onOpenChange, onRestoreSuccess })
    await flushPromises()

    fireEvent.click(getByTestId(document.body, 'cortex-version-diff-restore'))

    await waitFor(() => {
      expect(fetchSpyState.writeBodies).toHaveLength(1)
      expect(onRestoreSuccess).toHaveBeenCalledTimes(1)
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    expect(fetchSpyState.writeBodies[0]).toEqual({
      path: '/data/shared/knowledge/common.md',
      content: '# Restored\nv21\n',
      versioningSource: 'api-write-file-restore',
    })
  })
})
