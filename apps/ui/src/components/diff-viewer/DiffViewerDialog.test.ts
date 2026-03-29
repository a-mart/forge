/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole, getByText, queryByRole, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffViewerDialog } from './DiffViewerDialog'

const { invalidateGitCachesMock, hookCalls, STATUS_BY_TARGET, LOG_BY_TARGET, COMMIT_DETAILS } = vi.hoisted(() => ({
  invalidateGitCachesMock: vi.fn(),
  hookCalls: {
    status: [] as Array<{ agentId: string | null; repoTarget: string }>,
    diff: [] as Array<{ agentId: string | null; repoTarget: string; file: string | null }>,
    log: [] as Array<{ agentId: string | null; repoTarget: string; limit: number; offset: number }>,
    commitDetail: [] as Array<{ agentId: string | null; repoTarget: string; sha: string | null }>,
    commitDiff: [] as Array<{ agentId: string | null; repoTarget: string; sha: string | null; file: string | null }>,
  },
  STATUS_BY_TARGET: {
    workspace: {
      repoName: 'middleman',
      repoRoot: '/repo/middleman',
      repoKind: 'workspace' as const,
      repoLabel: 'Workspace',
      branch: 'main',
      files: [
        { path: 'src/alpha.ts', status: 'modified' as const, additions: 3, deletions: 1 },
        { path: 'src/beta.ts', status: 'added' as const, additions: 8, deletions: 0 },
      ],
      summary: { filesChanged: 2, insertions: 11, deletions: 1 },
    },
    versioning: {
      repoName: 'forge-data',
      repoRoot: '/data/forge',
      repoKind: 'versioning' as const,
      repoLabel: 'Cortex Knowledge',
      branch: 'main',
      files: [
        { path: 'shared/knowledge/common.md', status: 'modified' as const, additions: 2, deletions: 1 },
        { path: 'profiles/cortex/memory.md', status: 'modified' as const, additions: 4, deletions: 2 },
      ],
      summary: { filesChanged: 2, insertions: 6, deletions: 3 },
    },
  },
  LOG_BY_TARGET: {
    workspace: [
      {
        sha: 'workspace-1',
        shortSha: 'worksp1',
        message: 'Workspace bootstrap',
        author: 'Dev',
        date: '2026-03-01T12:00:00.000Z',
        filesChanged: 2,
      },
      {
        sha: 'workspace-2',
        shortSha: 'worksp2',
        message: 'Workspace followup',
        author: 'Dev',
        date: '2026-03-02T12:00:00.000Z',
        filesChanged: 1,
      },
    ],
    versioning: [
      {
        sha: 'versioning-1',
        shortSha: 'versio1',
        message: 'Knowledge bootstrap',
        author: 'Cortex',
        date: '2026-03-03T12:00:00.000Z',
        filesChanged: 1,
        metadata: {
          source: 'agent-edit-tool' as const,
          sources: ['agent-edit-tool' as const],
          profileId: 'cortex',
          sessionId: 'cortex--s1',
          paths: ['shared/knowledge/common.md'],
        },
      },
      {
        sha: 'versioning-2',
        shortSha: 'versio2',
        message: 'Knowledge refine',
        author: 'Cortex',
        date: '2026-03-04T12:00:00.000Z',
        filesChanged: 1,
        metadata: {
          source: 'reference-doc' as const,
          sources: ['reference-doc' as const],
          profileId: 'cortex',
          paths: ['profiles/cortex/reference/refine.md'],
        },
      },
      {
        sha: 'versioning-3',
        shortSha: 'versio3',
        message: 'Prompt refine',
        author: 'Cortex',
        date: '2026-03-05T12:00:00.000Z',
        filesChanged: 1,
        metadata: {
          source: 'prompt-save' as const,
          sources: ['prompt-save' as const],
          profileId: 'cortex',
          sessionId: 'cortex--s2',
          paths: ['profiles/cortex/prompts/archetypes/review.md'],
        },
      },
    ],
  },
  COMMIT_DETAILS: {
    workspace: {
      'workspace-1': {
        sha: 'workspace-1',
        message: 'Workspace bootstrap',
        author: 'Dev',
        date: '2026-03-01T12:00:00.000Z',
        files: [
          { path: 'src/alpha.ts', status: 'modified' as const, additions: 3, deletions: 1 },
          { path: 'src/beta.ts', status: 'added' as const, additions: 8, deletions: 0 },
        ],
      },
      'workspace-2': {
        sha: 'workspace-2',
        message: 'Workspace followup',
        author: 'Dev',
        date: '2026-03-02T12:00:00.000Z',
        files: [{ path: 'src/gamma.ts', status: 'modified' as const, additions: 5, deletions: 2 }],
      },
    },
    versioning: {
      'versioning-1': {
        sha: 'versioning-1',
        message: 'Knowledge bootstrap',
        author: 'Cortex',
        date: '2026-03-03T12:00:00.000Z',
        metadata: {
          source: 'agent-edit-tool' as const,
          sources: ['agent-edit-tool' as const],
          profileId: 'cortex',
          sessionId: 'cortex--s1',
          paths: ['shared/knowledge/common.md'],
        },
        files: [
          { path: 'shared/knowledge/common.md', status: 'modified' as const, additions: 2, deletions: 1 },
        ],
      },
      'versioning-2': {
        sha: 'versioning-2',
        message: 'Knowledge refine',
        author: 'Cortex',
        date: '2026-03-04T12:00:00.000Z',
        metadata: {
          source: 'reference-doc' as const,
          sources: ['reference-doc' as const],
          profileId: 'cortex',
          paths: ['profiles/cortex/reference/refine.md'],
        },
        files: [
          {
            path: 'profiles/cortex/reference/refine.md',
            status: 'modified' as const,
            additions: 7,
            deletions: 1,
          },
        ],
      },
      'versioning-3': {
        sha: 'versioning-3',
        message: 'Prompt refine',
        author: 'Cortex',
        date: '2026-03-05T12:00:00.000Z',
        metadata: {
          source: 'prompt-save' as const,
          sources: ['prompt-save' as const],
          profileId: 'cortex',
          sessionId: 'cortex--s2',
          paths: ['profiles/cortex/prompts/archetypes/review.md'],
        },
        files: [
          {
            path: 'profiles/cortex/prompts/archetypes/review.md',
            status: 'modified' as const,
            additions: 3,
            deletions: 0,
          },
        ],
      },
    },
  },
}))

vi.mock('./use-diff-queries', () => ({
  useGitStatus: (_wsUrl: string, agentId: string | null, repoTarget: 'workspace' | 'versioning') => {
    hookCalls.status.push({ agentId, repoTarget })
    return {
      data: agentId ? STATUS_BY_TARGET[repoTarget] : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitDiff: (_wsUrl: string, agentId: string | null, repoTarget: 'workspace' | 'versioning', file: string | null) => {
    hookCalls.diff.push({ agentId, repoTarget, file })
    return {
      data: file
        ? {
            oldContent: `${repoTarget}:${file}:old`,
            newContent: `${repoTarget}:${file}:new`,
          }
        : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitLog: (
    _wsUrl: string,
    agentId: string | null,
    repoTarget: 'workspace' | 'versioning',
    limit: number,
    offset: number,
  ) => {
    hookCalls.log.push({ agentId, repoTarget, limit, offset })
    return {
      data: agentId
        ? {
            commits: offset === 0 ? LOG_BY_TARGET[repoTarget] : [],
            hasMore: false,
          }
        : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitCommitDetail: (
    _wsUrl: string,
    agentId: string | null,
    repoTarget: 'workspace' | 'versioning',
    sha: string | null,
  ) => {
    hookCalls.commitDetail.push({ agentId, repoTarget, sha })
    return {
      data: sha ? COMMIT_DETAILS[repoTarget][sha as keyof (typeof COMMIT_DETAILS)[typeof repoTarget]] ?? null : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitCommitDiff: (
    _wsUrl: string,
    agentId: string | null,
    repoTarget: 'workspace' | 'versioning',
    sha: string | null,
    file: string | null,
  ) => {
    hookCalls.commitDiff.push({ agentId, repoTarget, sha, file })
    return {
      data: sha && file
        ? {
            oldContent: `${repoTarget}:${sha}:${file}:old`,
            newContent: `${repoTarget}:${sha}:${file}:new`,
          }
        : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  invalidateGitCaches: invalidateGitCachesMock,
}))

vi.mock('./DiffPane', () => ({
  DiffPane: ({ fileName }: { fileName: string | null }) =>
    createElement('div', { 'data-testid': 'diff-pane' }, fileName ?? 'no-file'),
}))

let container: HTMLDivElement
let root: Root | null = null
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  for (const callList of Object.values(hookCalls)) {
    callList.length = 0
  }
  invalidateGitCachesMock.mockReset()
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

function renderDialog(
  props: {
    isCortex: boolean
    agentId?: string | null
    open?: boolean
    initialRepoTarget?: 'workspace' | 'versioning'
    initialTab?: 'changes' | 'history'
    initialSha?: string | null
    initialFile?: string | null
    initialQuickFilter?: 'all' | 'shared-knowledge' | 'profile-memory' | 'reference-docs' | 'prompt-overrides'
  },
) {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(DiffViewerDialog, {
        open: props.open ?? true,
        onOpenChange: vi.fn(),
        wsUrl: 'ws://localhost:47187',
        agentId: props.agentId ?? 'agent-1',
        isCortex: props.isCortex,
        initialRepoTarget: props.initialRepoTarget,
        initialTab: props.initialTab,
        initialSha: props.initialSha,
        initialFile: props.initialFile,
        initialQuickFilter: props.initialQuickFilter,
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

function findOptionByText(text: string): HTMLElement {
  const label = getByText(document.body, text)
  const option = label.closest('[role="option"]')
  expect(option).toBeTruthy()
  return option as HTMLElement
}

describe('DiffViewerDialog', () => {
  it('defaults Cortex sessions to History + versioning and renders enhanced summaries with badges', async () => {
    renderDialog({ isCortex: true })
    await flushEffects()

    expect(getByRole(document.body, 'listbox', { name: 'Commit history' })).toBeTruthy()
    expect(getByRole(document.body, 'group', { name: 'Repository target' })).toBeTruthy()
    expect(queryByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
    expect(hookCalls.status.at(-1)?.repoTarget).toBe('versioning')
    expect(hookCalls.log.at(-1)?.repoTarget).toBe('versioning')
    expect(getByRole(document.body, 'button', { name: 'Cortex Knowledge' }).getAttribute('aria-pressed')).toBe('true')
    expect(getByRole(document.body, 'button', { name: 'History' }).getAttribute('aria-pressed')).toBe('true')
    expect(getByText(document.body, 'Updated common knowledge for cortex (session cortex--s1)')).toBeTruthy()
    expect(getByText(document.body, 'Edit tool')).toBeTruthy()
    expect(document.body.textContent).toContain('Profile cortex')
    expect(document.body.textContent).toContain('Session cortex--s1')
  })

  it('defaults non-Cortex sessions to Changes + workspace and hides the selector', async () => {
    renderDialog({ isCortex: false })
    await flushEffects()

    expect(getByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
    expect(queryByRole(document.body, 'listbox', { name: 'Commit history' })).toBeNull()
    expect(queryByRole(document.body, 'group', { name: 'Repository target' })).toBeNull()
    expect(hookCalls.status.at(-1)?.repoTarget).toBe('workspace')
    expect(getByRole(document.body, 'button', { name: 'Changes' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('changes repo-target hook params and resets history selection state when the selector changes', async () => {
    renderDialog({ isCortex: true })
    await flushEffects()

    click(findOptionByText('Synced reference docs for cortex'))
    await flushEffects()
    expect(findOptionByText('Synced reference docs for cortex').getAttribute('aria-selected')).toBe('true')

    click(findOptionByText('refine.md'))
    await flushEffects()
    expect(findOptionByText('refine.md').getAttribute('aria-selected')).toBe('true')

    click(getByRole(document.body, 'button', { name: 'Workspace' }))
    await flushEffects()

    await waitFor(() => {
      expect(hookCalls.status.at(-1)?.repoTarget).toBe('workspace')
      expect(hookCalls.log.at(-1)?.repoTarget).toBe('workspace')
      expect(hookCalls.commitDetail.at(-1)?.repoTarget).toBe('workspace')
      expect(hookCalls.commitDiff.at(-1)?.repoTarget).toBe('workspace')
      expect(findOptionByText('Workspace bootstrap').getAttribute('aria-selected')).toBe('true')
      expect(findOptionByText('alpha.ts').getAttribute('aria-selected')).toBe('true')
      expect(queryByRole(document.body, 'button', { name: 'Cortex Knowledge' })?.getAttribute('aria-pressed')).toBe('false')
      expect(getByRole(document.body, 'button', { name: 'Workspace' }).getAttribute('aria-pressed')).toBe('true')
    })
  })

  it('applies deep-link initial repo target, tab, sha, file, and quick filter', async () => {
    renderDialog({
      isCortex: true,
      initialRepoTarget: 'versioning',
      initialTab: 'history',
      initialSha: 'versioning-3',
      initialFile: 'profiles/cortex/prompts/archetypes/review.md',
      initialQuickFilter: 'prompt-overrides',
    })
    await flushEffects()
    await flushEffects()

    expect(getByRole(document.body, 'button', { name: 'History' }).getAttribute('aria-pressed')).toBe('true')
    expect(getByRole(document.body, 'button', { name: 'Cortex Knowledge' }).getAttribute('aria-pressed')).toBe('true')
    expect(getAllByRole(document.body, 'button', { name: 'Prompt overrides' })[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(findOptionByText('Prompt override edited for cortex (session cortex--s2)').getAttribute('aria-selected')).toBe('true')
    expect(findOptionByText('review.md').getAttribute('aria-selected')).toBe('true')
    expect(queryByText(document.body, 'Updated common knowledge for cortex (session cortex--s1)')).toBeNull()
  })

  it('filters commit rows and file rows with knowledge quick filters', async () => {
    renderDialog({ isCortex: true })
    await flushEffects()

    const promptFilter = getAllByRole(document.body, 'button', { name: 'Prompt overrides' })[0]
    click(promptFilter)
    await flushEffects()
    await flushEffects()

    expect(getByText(document.body, 'Prompt override edited for cortex (session cortex--s2)')).toBeTruthy()
    expect(queryByText(document.body, 'Updated common knowledge for cortex (session cortex--s1)')).toBeNull()
    expect(queryByText(document.body, 'Synced reference docs for cortex')).toBeNull()
    expect(getByText(document.body, 'review.md')).toBeTruthy()
    expect(queryByText(document.body, 'common.md')).toBeNull()
    expect(queryByText(document.body, 'refine.md')).toBeNull()
  })
})
