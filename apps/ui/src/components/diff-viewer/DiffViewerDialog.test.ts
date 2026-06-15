/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole, getByText, queryByRole, queryByText, waitFor, within } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffViewerContent, DiffViewerDialog } from './DiffViewerDialog'

const {
  invalidateGitCachesMock,
  hookCalls,
  STATUS_BY_TARGET,
  LOG_BY_TARGET,
  COMMIT_DETAILS,
  WORKTREES_BY_TARGET,
  WORKTREE_ERROR_BY_TARGET,
  WORKTREE_NOT_INITIALIZED_BY_TARGET,
  BRANCHES_BY_TARGET,
} = vi.hoisted(() => ({
  invalidateGitCachesMock: vi.fn(),
  hookCalls: {
    status: [] as Array<{ agentId: string | null; repoTarget: string; worktreeId?: string | null }>,
    branches: [] as Array<{ agentId: string | null; repoTarget: string; worktreeId?: string | null }>,
    diff: [] as Array<{ agentId: string | null; repoTarget: string; file: string | null }>,
    log: [] as Array<{ agentId: string | null; repoTarget: string; limit: number; offset: number }>,
    worktrees: [] as Array<{ agentId: string | null; repoTarget: string; enabled?: boolean }>,
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
  WORKTREES_BY_TARGET: {
    workspace: [
      {
        id: 'workspace-main',
        path: '/repo/middleman',
        repoRoot: '/repo/middleman',
        branch: 'main',
        headSha: 'abcdef1234567890',
        isMainWorktree: true,
        isCurrentContext: true,
        dirty: true,
        dirtySummary: { filesChanged: 2, insertions: 11, deletions: 1 },
        activeAgents: [
          { agentId: 'agent-1', displayName: 'Builder', role: 'manager' as const, status: 'idle' },
        ],
      },
      {
        id: 'feature-linked',
        path: '/repo/middleman-feature',
        repoRoot: '/repo/middleman-feature',
        branch: 'feature/demo',
        headSha: '1234567890abcdef',
        isMainWorktree: false,
        isCurrentContext: false,
        locked: true,
        prunable: false,
        dirty: false,
        dirtySummary: { filesChanged: 0, insertions: 0, deletions: 0 },
        activeAgents: [],
      },
    ],
    versioning: [
      {
        id: 'versioning-main',
        path: '/data/forge',
        repoRoot: '/data/forge',
        branch: 'main',
        headSha: 'fedcba9876543210',
        isMainWorktree: true,
        isCurrentContext: true,
        dirty: true,
        dirtySummary: { filesChanged: 2, insertions: 6, deletions: 3 },
        activeAgents: [],
      },
    ],
  },
  WORKTREE_ERROR_BY_TARGET: {
    workspace: null as string | null,
    versioning: null as string | null,
  },
  WORKTREE_NOT_INITIALIZED_BY_TARGET: {
    workspace: false,
    versioning: false,
  },
  BRANCHES_BY_TARGET: {
    workspace: {
      branches: [
        { name: 'main', kind: 'current' as const, headSha: 'abcdef1234567890abcdef1234567890abcdef12', ahead: 0, behind: 0 },
        { name: 'feature/demo', kind: 'local' as const, headSha: '1234567890abcdef1234567890abcdef12345678' },
      ],
      remotes: ['origin'],
      currentBranch: 'main',
      currentHead: 'abcdef1234567890abcdef1234567890abcdef12',
      statusHash: 'abc123statushash',
    },
    versioning: {
      branches: [],
      remotes: [],
      currentBranch: 'main',
      currentHead: null,
      statusHash: null,
    },
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
  useGitStatus: (
    _wsUrl: string,
    agentId: string | null,
    repoTarget: 'workspace' | 'versioning',
    worktreeId?: string | null,
  ) => {
    hookCalls.status.push({ agentId, repoTarget, worktreeId: worktreeId ?? null })
    return {
      data: agentId ? STATUS_BY_TARGET[repoTarget] : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitBranches: (
    _wsUrl: string,
    agentId: string | null,
    repoTarget: 'workspace' | 'versioning',
    worktreeId?: string | null,
  ) => {
    hookCalls.branches.push({ agentId, repoTarget, worktreeId: worktreeId ?? null })
    const status = STATUS_BY_TARGET[repoTarget]
    const branches = BRANCHES_BY_TARGET[repoTarget]
    return {
      data: agentId
        ? {
            ...branches,
            repoName: status.repoName,
            repoRoot: status.repoRoot,
            repoKind: status.repoKind,
            repoLabel: status.repoLabel,
            context: { repoTarget, worktreeId: worktreeId ?? undefined },
          }
        : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitWorktrees: (
    _wsUrl: string,
    agentId: string | null,
    repoTarget: 'workspace' | 'versioning',
    options?: { enabled?: boolean },
  ) => {
    const enabled = options?.enabled ?? !!agentId
    hookCalls.worktrees.push({ agentId, repoTarget, enabled })
    if (!enabled) {
      return {
        data: null,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      }
    }
    const status = STATUS_BY_TARGET[repoTarget]
    const error = WORKTREE_ERROR_BY_TARGET[repoTarget]
    const notInitialized = WORKTREE_NOT_INITIALIZED_BY_TARGET[repoTarget]
    return {
      data: agentId && !error
        ? {
            repoName: status.repoName,
            repoRoot: status.repoRoot,
            repoKind: status.repoKind,
            repoLabel: status.repoLabel,
            context: { repoTarget },
            worktrees: notInitialized ? [] : WORKTREES_BY_TARGET[repoTarget],
            notInitialized,
          }
        : null,
      isLoading: false,
      error,
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
  useGitPullRequests: () => ({
    data: null,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useGitPullRequestDetail: () => ({
    data: null,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  mergeGitPullRequest: vi.fn(),
  invalidateGitCaches: invalidateGitCachesMock,
  fetchGitOrigin: vi.fn(),
  switchGitBranch: vi.fn(),
  createGitBranch: vi.fn(),
  pullGitFfOnly: vi.fn(),
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
  WORKTREE_ERROR_BY_TARGET.workspace = null
  WORKTREE_ERROR_BY_TARGET.versioning = null
  WORKTREE_NOT_INITIALIZED_BY_TARGET.workspace = false
  WORKTREE_NOT_INITIALIZED_BY_TARGET.versioning = false
  WORKTREES_BY_TARGET.workspace.splice(0, WORKTREES_BY_TARGET.workspace.length,
    {
      id: 'workspace-main',
      path: '/repo/middleman',
      repoRoot: '/repo/middleman',
      branch: 'main',
      headSha: 'abcdef1234567890',
      isMainWorktree: true,
      isCurrentContext: true,
      dirty: true,
      dirtySummary: { filesChanged: 2, insertions: 11, deletions: 1 },
      activeAgents: [
        { agentId: 'agent-1', displayName: 'Builder', role: 'manager' as const, status: 'idle' },
      ],
    },
    {
      id: 'feature-linked',
      path: '/repo/middleman-feature',
      repoRoot: '/repo/middleman-feature',
      branch: 'feature/demo',
      headSha: '1234567890abcdef',
      isMainWorktree: false,
      isCurrentContext: false,
      locked: true,
      prunable: false,
      dirty: false,
      dirtySummary: { filesChanged: 0, insertions: 0, deletions: 0 },
      activeAgents: [],
    },
  )
  WORKTREES_BY_TARGET.versioning.splice(0, WORKTREES_BY_TARGET.versioning.length,
    {
      id: 'versioning-main',
      path: '/data/forge',
      repoRoot: '/data/forge',
      branch: 'main',
      headSha: 'fedcba9876543210',
      isMainWorktree: true,
      isCurrentContext: true,
      dirty: true,
      dirtySummary: { filesChanged: 2, insertions: 6, deletions: 3 },
      activeAgents: [],
    },
  )
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

function renderInlineContent(
  props: {
    active?: boolean
    isCortex: boolean
    agentId?: string | null
  },
) {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement('div', { className: 'diff-viewer flex h-full flex-col' },
        createElement(DiffViewerContent, {
          active: props.active ?? true,
          wsUrl: 'ws://localhost:47187',
          agentId: props.agentId ?? 'agent-1',
          isCortex: props.isCortex,
          onClose: vi.fn(),
        }),
      ),
    )
  })
}

function renderInlineContentWithBrowse(
  props: {
    active?: boolean
    isCortex: boolean
    agentId?: string | null
    onBrowseWorktreeFiles: ReturnType<typeof vi.fn>
  },
) {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement('div', { className: 'diff-viewer flex h-full flex-col' },
        createElement(DiffViewerContent, {
          active: props.active ?? true,
          wsUrl: 'ws://localhost:47187',
          agentId: props.agentId ?? 'agent-1',
          isCortex: props.isCortex,
          onClose: vi.fn(),
          onBrowseWorktreeFiles: props.onBrowseWorktreeFiles,
        }),
      ),
    )
  })
}

function renderDialog(
  props: {
    isCortex: boolean
    agentId?: string | null
    open?: boolean
    initialRepoTarget?: 'workspace' | 'versioning'
    initialTab?: 'changes' | 'history' | 'worktrees' | 'pull-requests'
    initialSha?: string | null
    initialFile?: string | null
    initialQuickFilter?: 'all' | 'shared-knowledge' | 'profile-memory' | 'reference-docs' | 'prompt-overrides'
    onBrowseWorktreeFiles?: ReturnType<typeof vi.fn>
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
        onBrowseWorktreeFiles: props.onBrowseWorktreeFiles,
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

describe('DiffViewerContent', () => {
  it('renders the reusable changes surface without a dialog overlay', async () => {
    renderInlineContent({ isCortex: false })
    await flushEffects()

    expect(queryByRole(document.body, 'dialog')).toBeNull()
    expect(document.body.querySelector('[data-radix-dialog-overlay]')).toBeNull()
    expect(getByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
    expect(hookCalls.status.at(-1)?.repoTarget).toBe('workspace')
  })
})

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
    expect(getByRole(document.body, 'group', { name: 'Repository activity' })).toBeTruthy()
    const sourceControlSections = getByRole(document.body, 'group', { name: 'Source Control sections' })
    expect(sourceControlSections).toBeTruthy()
    expect(within(sourceControlSections).queryByRole('button', { name: 'Changes' })).toBeNull()
    expect(within(sourceControlSections).queryByRole('button', { name: 'History' })).toBeNull()
    fireEvent.click(getByRole(document.body, 'button', { name: 'History' }))
    await flushEffects()
    expect(getByRole(document.body, 'listbox', { name: 'Commit history' })).toBeTruthy()
    expect(hookCalls.worktrees.filter((call) => call.enabled !== false)).toHaveLength(0)
  })

  it('loads worktree inventory only when the Worktrees tab is active', async () => {
    renderDialog({ isCortex: false })
    await flushEffects()
    expect(hookCalls.worktrees.every((call) => call.enabled === false)).toBe(true)

    fireEvent.click(getByRole(document.body, 'button', { name: 'Worktrees' }))
    await flushEffects()
    expect(hookCalls.worktrees.some((call) => call.enabled !== false)).toBe(true)
  })

  it('keeps Changes and History reachable from Pull Requests without a blank activity pane', async () => {
    renderDialog({ isCortex: false, initialTab: 'pull-requests' })
    await flushEffects()

    expect(getByRole(document.body, 'button', { name: 'Pull Requests' }).getAttribute('aria-pressed')).toBe('true')
    expect(queryByRole(document.body, 'group', { name: 'Repository activity' })).toBeNull()
    expect(getByRole(document.body, 'group', { name: 'Repository activity shortcuts' })).toBeTruthy()
    expect(getByText(document.body, 'GitHub pull requests unavailable')).toBeTruthy()

    fireEvent.click(getByRole(document.body, 'button', { name: 'History' }))
    await flushEffects()
    expect(getByRole(document.body, 'listbox', { name: 'Commit history' })).toBeTruthy()

    fireEvent.click(getByRole(document.body, 'button', { name: 'Pull Requests' }))
    await flushEffects()
    fireEvent.click(getByRole(document.body, 'button', { name: 'Changes' }))
    await flushEffects()
    expect(getByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
  })

  it('renders the read-only Worktrees tab with compact activity navigation and worktree state', async () => {
    renderDialog({ isCortex: false, initialTab: 'worktrees' })
    await flushEffects()

    expect(getByRole(document.body, 'button', { name: 'Worktrees' }).getAttribute('aria-pressed')).toBe('true')
    expect(queryByRole(document.body, 'group', { name: 'Repository activity' })).toBeNull()
    expect(getByRole(document.body, 'group', { name: 'Repository activity shortcuts' })).toBeTruthy()
    expect(getByText(document.body, 'Read-only inventory and browsing. Selecting a worktree updates Source Control and Files context only; chat session CWD stays unchanged.')).toBeTruthy()
    expect(getByText(document.body, '/repo/middleman')).toBeTruthy()
    expect(getByText(document.body, '/repo/middleman-feature')).toBeTruthy()
    expect(getByText(document.body, 'Session CWD')).toBeTruthy()
    expect(getByText(document.body, 'Main')).toBeTruthy()
    expect(getByText(document.body, '2 files +11 -1')).toBeTruthy()
    expect(getByText(document.body, '1 attached')).toBeTruthy()
    expect(getByText(document.body, '1 mgr · 0 wkr')).toBeTruthy()
    expect(queryByText(document.body, 'Builder · manager · idle')).toBeNull()
    expect(getByText(document.body, 'Locked')).toBeTruthy()
    const browseButtons = getAllByRole(document.body, 'button', { name: 'Browse files' })
    expect(browseButtons).toHaveLength(2)
    expect(browseButtons.every((button) => !button.hasAttribute('disabled'))).toBe(true)

    fireEvent.click(getByRole(document.body, 'button', { name: 'History' }))
    await flushEffects()
    expect(getByRole(document.body, 'listbox', { name: 'Commit history' })).toBeTruthy()
  })

  it('invokes browse callback for a worktree', async () => {
    const onBrowseWorktreeFiles = vi.fn()
    renderInlineContentWithBrowse({ isCortex: false, onBrowseWorktreeFiles })
    await flushEffects()

    fireEvent.click(getByRole(document.body, 'button', { name: 'Worktrees' }))
    await flushEffects()
    fireEvent.click(getAllByRole(document.body, 'button', { name: 'Browse files' })[1])

    expect(onBrowseWorktreeFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'feature-linked',
        path: '/repo/middleman-feature',
      }),
    )
  })

  it('invokes modal browse callback for a worktree', async () => {
    const onBrowseWorktreeFiles = vi.fn()
    renderDialog({ isCortex: false, initialTab: 'worktrees', onBrowseWorktreeFiles })
    await flushEffects()

    fireEvent.click(getAllByRole(document.body, 'button', { name: 'Browse files' })[1])

    expect(onBrowseWorktreeFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'feature-linked',
        path: '/repo/middleman-feature',
      }),
    )
  })

  it('selects alternate worktree context for Changes and passes worktreeId to status hook', async () => {
    renderInlineContent({ isCortex: false })
    await flushEffects()

    fireEvent.click(getByRole(document.body, 'button', { name: 'Worktrees' }))
    await flushEffects()
    fireEvent.click(getAllByRole(document.body, 'button', { name: 'Open Source Control' })[1])
    await flushEffects()

    expect(getByRole(document.body, 'button', { name: 'Changes' }).getAttribute('aria-pressed')).toBe('true')
    expect(hookCalls.status.at(-1)?.worktreeId).toBe('feature-linked')
  })

  it('keeps Changes reachable from the Worktrees empty state', async () => {
    WORKTREES_BY_TARGET.workspace.splice(0, WORKTREES_BY_TARGET.workspace.length)
    renderDialog({ isCortex: false, initialTab: 'worktrees' })
    await flushEffects()

    expect(getByText(document.body, 'No worktrees were reported for this repository.')).toBeTruthy()
    fireEvent.click(getByRole(document.body, 'button', { name: 'Changes' }))
    await flushEffects()
    expect(getByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
  })

  it('keeps History reachable from the Worktrees error state without leaving read-only mode', async () => {
    WORKTREE_ERROR_BY_TARGET.workspace = 'worktree inventory unavailable'
    renderDialog({ isCortex: false, initialTab: 'worktrees' })
    await flushEffects()

    expect(getByText(document.body, 'Failed to load worktrees: worktree inventory unavailable')).toBeTruthy()
    expect(getByRole(document.body, 'button', { name: 'Fetch origin' })).toBeTruthy()
    expect(getByRole(document.body, 'button', { name: 'Pull FF only' })).toBeTruthy()
    fireEvent.click(getByRole(document.body, 'button', { name: 'History' }))
    await flushEffects()
    expect(getByRole(document.body, 'listbox', { name: 'Commit history' })).toBeTruthy()
  })

  it('keeps Changes reachable from the Worktrees not-initialized state', async () => {
    WORKTREE_NOT_INITIALIZED_BY_TARGET.workspace = true
    renderDialog({ isCortex: false, initialTab: 'worktrees' })
    await flushEffects()

    expect(getByText(document.body, 'This workspace is not a Git repository.')).toBeTruthy()
    fireEvent.click(getByRole(document.body, 'button', { name: 'Changes' }))
    await flushEffects()
    expect(getByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
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
