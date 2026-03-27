/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole, getByText, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryView, type HistoryStatusInfo } from './HistoryView'

type RepoTarget = 'workspace' | 'versioning'

type GitLogEntry = {
  sha: string
  shortSha: string
  message: string
  author: string
  date: string
  filesChanged: number
  metadata?: {
    source?: 'agent-edit-tool' | 'reference-doc' | 'prompt-save'
    sources?: Array<'agent-edit-tool' | 'reference-doc' | 'prompt-save'>
    profileId?: string
    sessionId?: string
    paths?: string[]
  }
}

type GitFile = {
  path: string
  status: 'modified' | 'added'
  additions?: number
  deletions?: number
}

const { hookCalls, logPages, commitDetails } = vi.hoisted(() => ({
  hookCalls: {
    log: [] as Array<{ repoTarget: RepoTarget; offset: number }>,
    commitDetail: [] as Array<{ repoTarget: RepoTarget; sha: string | null }>,
    commitDiff: [] as Array<{ repoTarget: RepoTarget; sha: string | null; file: string | null }>,
  },
  logPages: {
    workspace: new Map<number, { commits: GitLogEntry[]; hasMore: boolean }>(),
    versioning: new Map<number, { commits: GitLogEntry[]; hasMore: boolean }>(),
  },
  commitDetails: {
    workspace: new Map<string, { sha: string; message: string; author: string; date: string; files: GitFile[] }>(),
    versioning: new Map<
      string,
      {
        sha: string
        message: string
        author: string
        date: string
        files: GitFile[]
        metadata?: GitLogEntry['metadata']
      }
    >(),
  },
}))

vi.mock('./useResizablePanel', () => ({
  useResizablePanel: () => ({
    width: 240,
    isDragging: false,
    handleRef: { current: null },
  }),
}))

vi.mock('./use-diff-queries', () => ({
  useGitLog: (
    _wsUrl: string,
    agentId: string | null,
    repoTarget: RepoTarget,
    _limit: number,
    offset: number,
  ) => {
    hookCalls.log.push({ repoTarget, offset })
    const page = logPages[repoTarget].get(offset) ?? { commits: [], hasMore: false }
    return {
      data: agentId ? page : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitCommitDetail: (_wsUrl: string, agentId: string | null, repoTarget: RepoTarget, sha: string | null) => {
    hookCalls.commitDetail.push({ repoTarget, sha })
    return {
      data: agentId && sha ? commitDetails[repoTarget].get(sha) ?? null : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitCommitDiff: (
    _wsUrl: string,
    agentId: string | null,
    repoTarget: RepoTarget,
    sha: string | null,
    file: string | null,
  ) => {
    hookCalls.commitDiff.push({ repoTarget, sha, file })
    return {
      data: agentId && sha && file ? { oldContent: `${sha}:${file}:old`, newContent: `${sha}:${file}:new` } : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
}))

vi.mock('./DiffPane', () => ({
  DiffPane: ({ fileName }: { fileName: string | null }) => createElement('div', { 'data-testid': 'diff-pane' }, fileName ?? 'no-file'),
}))

let container: HTMLDivElement
let root: Root | null = null
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  hookCalls.log.length = 0
  hookCalls.commitDetail.length = 0
  hookCalls.commitDiff.length = 0
  logPages.workspace.clear()
  logPages.versioning.clear()
  commitDetails.workspace.clear()
  commitDetails.versioning.clear()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
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
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: originalScrollIntoView,
  })
})

function renderHistoryView(props: { refreshToken?: number; onStatusChange?: (info: HistoryStatusInfo | null) => void }) {
  if (!root) {
    root = createRoot(container)
  }

  flushSync(() => {
    root?.render(
      createElement(HistoryView, {
        wsUrl: 'ws://localhost:47187',
        agentId: 'cortex--s1',
        repoTarget: 'versioning',
        refreshToken: props.refreshToken ?? 0,
        onStatusChange: props.onStatusChange,
      }),
    )
  })
}

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function click(element: HTMLElement): void {
  flushSync(() => {
    fireEvent.click(element)
  })
}

function commitEntry(
  sha: string,
  message: string,
  metadata?: GitLogEntry['metadata'],
): GitLogEntry {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    message,
    author: 'Cortex',
    date: '2026-03-05T12:00:00.000Z',
    filesChanged: metadata?.paths?.length ?? 1,
    metadata,
  }
}

function commitDetail(
  sha: string,
  message: string,
  files: GitFile[],
  metadata?: GitLogEntry['metadata'],
) {
  return {
    sha,
    message,
    author: 'Cortex',
    date: '2026-03-05T12:00:00.000Z',
    files,
    metadata,
  }
}

describe('HistoryView', () => {
  it('refreshes from page 0 after pagination so newer commits appear again', async () => {
    const olderCommit = commitEntry('older01', 'Older knowledge commit')
    const olderDetail = commitDetail('older01', 'Older knowledge commit', [
      { path: 'shared/knowledge/common.md', status: 'modified', additions: 1, deletions: 0 },
    ])
    const pagedCommit = commitEntry('paged02', 'Paged history commit')
    const pagedDetail = commitDetail('paged02', 'Paged history commit', [
      { path: 'profiles/cortex/reference/guide.md', status: 'modified', additions: 2, deletions: 0 },
    ])

    logPages.versioning.set(0, { commits: [olderCommit], hasMore: true })
    logPages.versioning.set(50, { commits: [pagedCommit], hasMore: false })
    commitDetails.versioning.set('older01', olderDetail)
    commitDetails.versioning.set('paged02', pagedDetail)

    renderHistoryView({ refreshToken: 0 })
    await flushEffects()

    click(getByRole(document.body, 'button', { name: 'Load more' }))

    await waitFor(() => {
      expect(hookCalls.log.some((call) => call.offset === 50)).toBe(true)
      expect(getByText(document.body, 'Paged history commit')).toBeTruthy()
    })

    const newestCommit = commitEntry('newhead3', 'Newest knowledge commit')
    const newestDetail = commitDetail('newhead3', 'Newest knowledge commit', [
      { path: 'shared/knowledge/common.md', status: 'modified', additions: 3, deletions: 0 },
    ])

    logPages.versioning.set(0, { commits: [newestCommit, olderCommit], hasMore: true })
    commitDetails.versioning.set('newhead3', newestDetail)

    renderHistoryView({ refreshToken: 1 })
    await flushEffects()

    await waitFor(() => {
      expect(hookCalls.log.at(-1)?.offset).toBe(0)
      const newestOption = getByText(document.body, 'Newest knowledge commit').closest('[role="option"]')
      expect(newestOption?.getAttribute('aria-selected')).toBe('true')
    })
  })

  it('keeps Load more available when a quick filter has no matches in loaded pages', async () => {
    const commonCommit = commitEntry('common01', 'Updated common knowledge', {
      source: 'agent-edit-tool',
      sources: ['agent-edit-tool'],
      profileId: 'cortex',
      sessionId: 'cortex--s1',
      paths: ['shared/knowledge/common.md'],
    })
    const promptCommit = commitEntry('prompt02', 'Saved prompt override', {
      source: 'prompt-save',
      sources: ['prompt-save'],
      profileId: 'cortex',
      sessionId: 'cortex--s2',
      paths: ['profiles/cortex/prompts/archetypes/review.md'],
    })

    logPages.versioning.set(0, { commits: [commonCommit], hasMore: true })
    logPages.versioning.set(50, { commits: [promptCommit], hasMore: false })
    commitDetails.versioning.set('common01', commitDetail('common01', 'Updated common knowledge', [
      { path: 'shared/knowledge/common.md', status: 'modified', additions: 1, deletions: 0 },
    ], commonCommit.metadata))
    commitDetails.versioning.set('prompt02', commitDetail('prompt02', 'Saved prompt override', [
      { path: 'profiles/cortex/prompts/archetypes/review.md', status: 'modified', additions: 4, deletions: 0 },
    ], promptCommit.metadata))

    renderHistoryView({ refreshToken: 0 })
    await flushEffects()

    click(getAllByRole(document.body, 'button', { name: 'Prompt overrides' })[0])
    await flushEffects()

    expect(getByText(document.body, 'No commits match this filter')).toBeTruthy()
    expect(getByRole(document.body, 'button', { name: 'Load more' })).toBeTruthy()

    click(getByRole(document.body, 'button', { name: 'Load more' }))
    await flushEffects()

    await waitFor(() => {
      expect(queryByText(document.body, 'No commits match this filter')).toBeNull()
      expect(getByText(document.body, 'Prompt override edited for cortex (session cortex--s2)')).toBeTruthy()
    })
  })

  it('reports filtered file counts in status updates when a knowledge quick filter is active', async () => {
    const mixedCommit = commitEntry('mixed01', 'Mixed knowledge commit', {
      source: 'prompt-save',
      sources: ['prompt-save'],
      profileId: 'cortex',
      sessionId: 'cortex--s2',
      paths: ['shared/knowledge/common.md', 'profiles/cortex/prompts/archetypes/review.md'],
    })

    logPages.versioning.set(0, { commits: [mixedCommit], hasMore: false })
    commitDetails.versioning.set('mixed01', commitDetail('mixed01', 'Mixed knowledge commit', [
      { path: 'shared/knowledge/common.md', status: 'modified', additions: 2, deletions: 1 },
      { path: 'profiles/cortex/prompts/archetypes/review.md', status: 'modified', additions: 5, deletions: 0 },
    ], mixedCommit.metadata))

    const onStatusChange = vi.fn()
    renderHistoryView({ onStatusChange })
    await flushEffects()

    await waitFor(() => {
      expect(onStatusChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filesChanged: 2,
          insertions: 7,
          deletions: 1,
        }),
      )
    })

    click(getAllByRole(document.body, 'button', { name: 'Prompt overrides' })[0])
    await flushEffects()

    await waitFor(() => {
      expect(onStatusChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filesChanged: 1,
          insertions: 5,
          deletions: 0,
        }),
      )
    })
  })
})
