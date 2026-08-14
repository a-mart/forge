/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole, getByTestId, getByText, queryByRole, queryByText, waitFor, within } from '@testing-library/dom'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePanelState } from '@/hooks/index-page/use-panel-state'
import { DiffViewerContent, DiffViewerDialog } from './DiffViewerDialog'
import { createRemoteUpdateAwarenessMutationTarget } from './remote-update-awareness-mutation'

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
  PULL_REQUESTS_QUERY_STATE,
  remoteApi,
} = vi.hoisted(() => ({
  invalidateGitCachesMock: vi.fn(),
  hookCalls: {
    status: [] as Array<{ agentId: string | null; repoTarget: string; worktreeId?: string | null }>,
    branches: [] as Array<{ agentId: string | null; repoTarget: string; worktreeId?: string | null }>,
    diff: [] as Array<{ agentId: string | null; repoTarget: string; file: string | null }>,
    log: [] as Array<{ agentId: string | null; repoTarget: string; limit: number; offset: number }>,
    worktrees: [] as Array<{ agentId: string | null; repoTarget: string; enabled?: boolean }>,
    pullRequests: [] as Array<{ agentId: string | null; repoTarget: string; worktreeId?: string | null; enabled?: boolean }>,
    commitDetail: [] as Array<{ agentId: string | null; repoTarget: string; sha: string | null }>,
    commitDiff: [] as Array<{ agentId: string | null; repoTarget: string; sha: string | null; file: string | null }>,
    refetches: [] as string[],
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
  PULL_REQUESTS_QUERY_STATE: {
    data: null as null | {
      open: Array<Record<string, unknown>>
      recentlyClosed: Array<Record<string, unknown>>
      currentBranchPullRequest: Record<string, unknown> | null
      providerStatus: { provider: 'github'; available: boolean; authenticated: boolean; remoteUrl?: string; message?: string }
      openLimit?: number
      openCountTruncated?: boolean
      repoName: string
      repoRoot: string
      repoKind: 'workspace'
      repoLabel: string
      context: { repoTarget: 'workspace'; worktreeId?: string }
      listError?: string
    },
    error: null as string | null,
  },
  remoteApi: {
    dismissRemoteUpdateAwarenessProjectUpdate: vi.fn(),
    fetchRemoteUpdateAwarenessIncoming: vi.fn(),
    refreshRemoteUpdateAwarenessProject: vi.fn(),
    updateRemoteUpdateAwarenessProjectOverride: vi.fn(),
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
      refetch: vi.fn(() => hookCalls.refetches.push(`status:${repoTarget}:${worktreeId ?? 'session'}`)),
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
      refetch: vi.fn(() => hookCalls.refetches.push(`branches:${repoTarget}:${worktreeId ?? 'session'}`)),
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
      refetch: vi.fn(() => hookCalls.refetches.push(`worktrees:${repoTarget}`)),
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
  useGitPullRequests: (
    _wsUrl: string,
    agentId: string | null,
    repoTarget: 'workspace' | 'versioning',
    worktreeId?: string | null,
    options?: { enabled?: boolean },
  ) => {
    const enabled = options?.enabled ?? !!agentId
    hookCalls.pullRequests.push({ agentId, repoTarget, worktreeId: worktreeId ?? null, enabled })
    return {
      data: enabled && agentId && repoTarget === 'workspace' ? PULL_REQUESTS_QUERY_STATE.data : null,
      isLoading: false,
      error: enabled ? PULL_REQUESTS_QUERY_STATE.error : null,
      refetch: vi.fn(() => hookCalls.refetches.push('pull-requests')),
    }
  },
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

vi.mock('@/components/settings/remote-update-awareness-api', () => remoteApi)

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
  PULL_REQUESTS_QUERY_STATE.data = null
  PULL_REQUESTS_QUERY_STATE.error = null
  Object.values(remoteApi).forEach((mock) => mock.mockReset())
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
    externalRefreshNonce?: number
    remoteUpdateSnapshot?: import('@forge/protocol').RemoteUpdateAwarenessProjectSnapshot | null
    onRemoteUpdateSnapshotChange?: (snapshot: import('@forge/protocol').RemoteUpdateAwarenessProjectSnapshot) => void
    initialRepoTarget?: 'workspace' | 'versioning'
    initialTab?: 'changes' | 'history' | 'incoming' | 'worktrees' | 'pull-requests'
    navigationRequest?: import('./DiffViewerDialog').DiffViewerNavigationRequest | null
    onRequestSourceControlMutation?: (
      mutation: 'switch-branch' | 'create-branch' | 'pull-ff-only' | 'push',
      target: { agentId: string; worktreeId: string | null },
      run: () => void,
    ) => void
  },
) {
  root ??= createRoot(container)

  flushSync(() => {
    root?.render(
      createElement('div', { className: 'diff-viewer flex h-full flex-col' },
        createElement(DiffViewerContent, {
          active: props.active ?? true,
          wsUrl: 'ws://localhost:47187',
          agentId: props.agentId ?? 'agent-1',
          isCortex: props.isCortex,
          onClose: vi.fn(),
          onRequestSourceControlMutation: props.onRequestSourceControlMutation,
          externalRefreshNonce: props.externalRefreshNonce,
          remoteUpdateSnapshot: props.remoteUpdateSnapshot,
          onRemoteUpdateSnapshotChange: props.onRemoteUpdateSnapshotChange,
          initialRepoTarget: props.initialRepoTarget,
          initialTab: props.initialTab,
          navigationRequest: props.navigationRequest,
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
    initialTab?: 'changes' | 'history' | 'incoming' | 'worktrees' | 'pull-requests'
    initialSha?: string | null
    initialFile?: string | null
    initialQuickFilter?: 'all' | 'shared-knowledge' | 'profile-memory' | 'reference-docs' | 'prompt-overrides'
    onBrowseWorktreeFiles?: ReturnType<typeof vi.fn>
    remoteUpdateSnapshot?: import('@forge/protocol').RemoteUpdateAwarenessProjectSnapshot | null
    onRemoteUpdateSnapshotChange?: (snapshot: import('@forge/protocol').RemoteUpdateAwarenessProjectSnapshot) => void
    navigationRequest?: import('./DiffViewerDialog').DiffViewerNavigationRequest | null
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
        remoteUpdateSnapshot: props.remoteUpdateSnapshot,
        onRemoteUpdateSnapshotChange: props.onRemoteUpdateSnapshotChange,
        navigationRequest: props.navigationRequest,
      }),
    )
  })
}

const remoteUpdateSnapshot = {
  projectId: 'project-1',
  override: 'inherit' as const,
  globalEnabled: true,
  effectiveEnabled: true,
  state: 'update_available' as const,
  lastObservedAt: null,
  failureCode: null,
  attentionRequired: true,
  dismissalTarget: { generation: 7 },
}

const incomingInspection = {
  projectId: 'project-1',
  remoteDisplayName: 'origin',
  defaultBranchDisplay: 'main',
  observedTipOid: null,
  generation: 7,
  observedAt: null,
  freshnessCheckedAt: null,
  staleAfter: null,
  state: 'update_available' as const,
  failureCode: null,
  attentionRequired: true,
  commits: { commitCount: 0, commitLimit: 20, hasMore: false, commits: [] },
  fileChanges: null,
}

function ContextSwitchHarness() {
  const [context, setContext] = useState({ agentId: 'workspace-agent', isCortex: false })
  const panelState = usePanelState({
    activeAgentId: context.agentId,
    activeAgentArchetypeId: context.isCortex ? 'cortex' : null,
    activeContextKey: `local:${context.agentId}:${context.isCortex ? 'cortex' : 'workspace'}`,
    enableKeyboardShortcuts: false,
  })

  return createElement(
    'div',
    null,
    createElement('button', {
      type: 'button',
      onClick: () => panelState.openDiffViewerDeepLink({
        initialRepoTarget: 'workspace',
        initialTab: 'incoming',
      }),
    }, 'Open Incoming'),
    createElement('button', {
      type: 'button',
      onClick: () => setContext({ agentId: 'cortex-agent', isCortex: true }),
    }, 'Switch to Cortex'),
    createElement(DiffViewerContent, {
      active: true,
      wsUrl: 'ws://127.0.0.1:47187',
      agentId: context.agentId,
      isCortex: context.isCortex,
      onClose: vi.fn(),
      remoteUpdateSnapshot: context.isCortex ? null : remoteUpdateSnapshot,
      initialRepoTarget: panelState.diffViewerInitialState?.initialRepoTarget,
      initialTab: panelState.diffViewerInitialState?.initialTab,
      navigationRequest: panelState.diffViewerNavigationRequest,
    }),
  )
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

function findOptionByText(text: string, listName?: string): HTMLElement {
  const root = listName ? getByRole(document.body, 'listbox', { name: listName }) : document.body
  const label = getByText(root, text)
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

  it('refreshes mounted Source Control status and branches when externalRefreshNonce changes', async () => {
    renderInlineContent({ isCortex: false, externalRefreshNonce: 0 })
    await flushEffects()
    hookCalls.refetches.length = 0
    invalidateGitCachesMock.mockClear()

    renderInlineContent({ isCortex: false, externalRefreshNonce: 1 })
    await waitFor(() => {
      expect(invalidateGitCachesMock).toHaveBeenCalledWith({ agentId: 'agent-1', repoTarget: 'workspace' })
    })

    expect(hookCalls.refetches).toContain('status:workspace:session')
    expect(hookCalls.refetches).toContain('branches:workspace:session')
  })

  it('honors a later, uniquely identified Incoming deep link while already open', async () => {
    remoteApi.fetchRemoteUpdateAwarenessIncoming.mockResolvedValue({ incoming: incomingInspection })
    renderInlineContent({
      isCortex: true,
      remoteUpdateSnapshot,
      navigationRequest: null,
    })
    await flushEffects()
    expect(hookCalls.status.at(-1)?.repoTarget).toBe('versioning')

    renderInlineContent({
      isCortex: true,
      remoteUpdateSnapshot,
      navigationRequest: {
        requestId: 1,
        initialRepoTarget: 'workspace',
        initialTab: 'incoming',
      },
    })

    await waitFor(() => expect(getByRole(document.body, 'heading', { name: 'Incoming' })).toBeTruthy())
    expect(hookCalls.status.at(-1)?.repoTarget).toBe('workspace')
    expect(getByRole(document.body, 'button', { name: 'Incoming' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('does not retain the History footer after switching to Incoming', async () => {
    remoteApi.fetchRemoteUpdateAwarenessIncoming.mockResolvedValue({ incoming: incomingInspection })
    renderInlineContent({
      isCortex: false,
      initialTab: 'history',
      remoteUpdateSnapshot,
    })
    await flushEffects()
    await waitFor(() => {
      const historyFooter = document.body.querySelector('[aria-live="polite"]')
      expect(historyFooter?.textContent).toContain('worksp1')
      expect(historyFooter?.textContent).toContain('Dev')
    })

    fireEvent.click(getByRole(document.body, 'button', { name: 'Incoming' }))
    await waitFor(() => expect(getByRole(document.body, 'heading', { name: 'Incoming' })).toBeTruthy())

    expect(queryByText(document.body, 'worksp1')).toBeNull()
    expect(queryByText(document.body, 'Dev')).toBeNull()
    expect(document.body.querySelector('[aria-live="polite"]')).toBeNull()
  })

  it('uses Cortex defaults after an open Incoming deep link crosses agent context', async () => {
    remoteApi.fetchRemoteUpdateAwarenessIncoming.mockResolvedValue({ incoming: incomingInspection })
    root = createRoot(container)
    act(() => root?.render(createElement(ContextSwitchHarness)))

    fireEvent.click(getByRole(document.body, 'button', { name: 'Open Incoming' }))
    await waitFor(() => expect(getByRole(document.body, 'heading', { name: 'Incoming' })).toBeTruthy())

    fireEvent.click(getByRole(document.body, 'button', { name: 'Switch to Cortex' }))
    await waitFor(() => {
      expect(getByRole(document.body, 'button', { name: 'Toggle History section' }).getAttribute('aria-expanded')).toBe('true')
      expect(getByRole(document.body, 'button', { name: 'Cortex Knowledge' }).getAttribute('aria-pressed')).toBe('true')
    })
    expect(queryByRole(document.body, 'heading', { name: 'Incoming' })).toBeNull()
    expect(document.body.textContent).not.toContain('Incoming changes are unavailable')
  })

  it('shows an explicit unavailable state instead of falling through to Pull Requests without a snapshot', async () => {
    renderInlineContent({ isCortex: false, initialTab: 'incoming', remoteUpdateSnapshot: null })
    await flushEffects()

    expect(getByRole(document.body, 'status').textContent).toContain('Incoming changes are unavailable')
    expect(document.body.textContent).not.toContain('Pull request list unavailable')
    expect(hookCalls.pullRequests.every((call) => call.enabled === false)).toBe(true)

    fireEvent.click(getByRole(document.body, 'button', { name: 'Return to Changes' }))
    await waitFor(() => expect(getByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy())
  })
})

describe('DiffViewerDialog', () => {
  it('passes remote snapshot data and mutations through the modal fallback', async () => {
    remoteApi.fetchRemoteUpdateAwarenessIncoming.mockResolvedValue({ incoming: incomingInspection })
    remoteApi.dismissRemoteUpdateAwarenessProjectUpdate.mockResolvedValue({
      snapshot: { ...remoteUpdateSnapshot, attentionRequired: false },
    })
    const onSnapshotChange = vi.fn()

    renderDialog({
      isCortex: false,
      initialRepoTarget: 'workspace',
      initialTab: 'incoming',
      remoteUpdateSnapshot,
      onRemoteUpdateSnapshotChange: onSnapshotChange,
      navigationRequest: {
        requestId: 1,
        initialRepoTarget: 'workspace',
        initialTab: 'incoming',
      },
    })
    await waitFor(() => expect(getByRole(document.body, 'heading', { name: 'Incoming' })).toBeTruthy())

    fireEvent.click(getByRole(document.body, 'button', { name: 'Dismiss' }))
    await waitFor(() => expect(onSnapshotChange).toHaveBeenCalledWith(
      {
        ...remoteUpdateSnapshot,
        attentionRequired: false,
      },
      createRemoteUpdateAwarenessMutationTarget(remoteUpdateSnapshot, 1),
    ))
  })

  it('defaults Cortex sessions to History + versioning and renders enhanced summaries with badges', async () => {
    renderDialog({ isCortex: true })
    await flushEffects()

    expect(getByRole(document.body, 'listbox', { name: 'Commit history' })).toBeTruthy()
    expect(getByRole(document.body, 'group', { name: 'Repository target' })).toBeTruthy()
    expect(queryByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
    expect(hookCalls.status.at(-1)?.repoTarget).toBe('versioning')
    expect(hookCalls.log.at(-1)?.repoTarget).toBe('versioning')
    expect(getByRole(document.body, 'button', { name: 'Cortex Knowledge' }).getAttribute('aria-pressed')).toBe('true')
    expect(getByRole(document.body, 'button', { name: 'Toggle History section' }).getAttribute('aria-expanded')).toBe('true')
    expect(getByText(document.body, 'Updated common knowledge for cortex (session cortex--s1)')).toBeTruthy()
    expect(getByText(document.body, 'Edit tool')).toBeTruthy()
    expect(document.body.textContent).toContain('Profile cortex')
    expect(document.body.textContent).toContain('Session cortex--s1')
  })

  it('defaults non-Cortex sessions to Changes + workspace and hides the selector', async () => {
    renderDialog({ isCortex: false })
    await flushEffects()

    expect(getByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
    expect(getByRole(document.body, 'listbox', { name: 'Commit history' })).toBeTruthy()
    expect(queryByRole(document.body, 'group', { name: 'Repository target' })).toBeNull()
    expect(hookCalls.status.at(-1)?.repoTarget).toBe('workspace')
    expect(getByRole(document.body, 'button', { name: 'Toggle Changes section' }).getAttribute('aria-expanded')).toBe('true')
    expect(getByTestId(document.body, 'source-control-explorer')).toBeTruthy()
    const sourceControlShortcuts = getByRole(document.body, 'navigation', { name: 'Source Control shortcuts' })
    expect(sourceControlShortcuts).toBeTruthy()
    expect(within(sourceControlShortcuts).queryByRole('button', { name: 'Changes' })).toBeNull()
    expect(within(sourceControlShortcuts).queryByRole('button', { name: 'History' })).toBeNull()
    expect(within(sourceControlShortcuts).getByRole('button', { name: 'Worktrees' }).getAttribute('aria-pressed')).toBe('false')
    expect(within(sourceControlShortcuts).getByRole('button', { name: 'Pull Requests' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(getByRole(document.body, 'button', { name: 'Toggle History section' }))
    await flushEffects()
    fireEvent.click(getByRole(document.body, 'button', { name: 'Toggle History section' }))
    await flushEffects()
    expect(getByRole(document.body, 'listbox', { name: 'Commit history' })).toBeTruthy()
    expect(getByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
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

  it('does not load or refresh pull requests for the badge before the Pull Requests tab has been visited', async () => {
    renderDialog({ isCortex: false })
    await flushEffects()

    expect(hookCalls.pullRequests.every((call) => call.enabled === false)).toBe(true)
    fireEvent.click(getByRole(document.body, 'button', { name: 'Refresh' }))
    await flushEffects()
    expect(hookCalls.refetches).not.toContain('pull-requests')
  })

  it('shows the known open pull request count on the shortcut after visiting Pull Requests without changing its accessible name', async () => {
    PULL_REQUESTS_QUERY_STATE.data = {
      open: [{ number: 1 }, { number: 2 }],
      recentlyClosed: [{ number: 3 }],
      currentBranchPullRequest: null,
      providerStatus: {
        provider: 'github',
        available: true,
        authenticated: true,
        remoteUrl: 'git@github.com:a-mart/forge.git',
      },
      repoName: 'middleman',
      repoRoot: '/repo/middleman',
      repoKind: 'workspace',
      repoLabel: 'Workspace',
      context: { repoTarget: 'workspace' },
    }

    renderDialog({ isCortex: false })
    await flushEffects()
    const sourceControlShortcutsBefore = getByRole(document.body, 'navigation', { name: 'Source Control shortcuts' })
    expect(within(sourceControlShortcutsBefore).queryByText('2')).toBeNull()

    fireEvent.click(getByRole(document.body, 'button', { name: 'Pull Requests' }))
    await flushEffects()

    const sourceControlShortcuts = getByRole(document.body, 'navigation', { name: 'Source Control shortcuts' })
    expect(within(sourceControlShortcuts).getByRole('button', { name: 'Pull Requests' })).toBeTruthy()
    expect(within(sourceControlShortcuts).getByText('2')).toBeTruthy()
  })

  it('renders a plus suffix when the pull request list reports a truncated open count', async () => {
    PULL_REQUESTS_QUERY_STATE.data = {
      open: [{ number: 1 }, { number: 2 }],
      recentlyClosed: [],
      currentBranchPullRequest: null,
      providerStatus: {
        provider: 'github',
        available: true,
        authenticated: true,
        remoteUrl: 'git@github.com:a-mart/forge.git',
      },
      openLimit: 2,
      openCountTruncated: true,
      repoName: 'middleman',
      repoRoot: '/repo/middleman',
      repoKind: 'workspace',
      repoLabel: 'Workspace',
      context: { repoTarget: 'workspace' },
    }

    renderDialog({ isCortex: false, initialTab: 'pull-requests' })
    await flushEffects()

    const sourceControlShortcuts = getByRole(document.body, 'navigation', { name: 'Source Control shortcuts' })
    expect(within(sourceControlShortcuts).getByText('2+')).toBeTruthy()
  })

  it('shows a muted zero pull request count only when the provider returned a known authenticated list', async () => {
    PULL_REQUESTS_QUERY_STATE.data = {
      open: [],
      recentlyClosed: [{ number: 3 }],
      currentBranchPullRequest: null,
      providerStatus: {
        provider: 'github',
        available: true,
        authenticated: true,
        remoteUrl: 'git@github.com:a-mart/forge.git',
      },
      repoName: 'middleman',
      repoRoot: '/repo/middleman',
      repoKind: 'workspace',
      repoLabel: 'Workspace',
      context: { repoTarget: 'workspace' },
    }

    renderDialog({ isCortex: false, initialTab: 'pull-requests' })
    await flushEffects()

    const sourceControlShortcuts = getByRole(document.body, 'navigation', { name: 'Source Control shortcuts' })
    expect(within(sourceControlShortcuts).getByText('0')).toBeTruthy()
  })

  it('hides the pull request count when the provider is unavailable', async () => {
    PULL_REQUESTS_QUERY_STATE.data = {
      open: [],
      recentlyClosed: [],
      currentBranchPullRequest: null,
      providerStatus: {
        provider: 'github',
        available: false,
        authenticated: false,
        remoteUrl: 'git@github.com:a-mart/forge.git',
        message: 'Install GitHub CLI (gh) and authenticate to view pull requests.',
      },
      repoName: 'middleman',
      repoRoot: '/repo/middleman',
      repoKind: 'workspace',
      repoLabel: 'Workspace',
      context: { repoTarget: 'workspace' },
    }

    renderDialog({ isCortex: false, initialTab: 'pull-requests' })
    await flushEffects()

    const sourceControlShortcuts = getByRole(document.body, 'navigation', { name: 'Source Control shortcuts' })
    expect(within(sourceControlShortcuts).queryByText('0')).toBeNull()
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

    expect(getByRole(document.body, 'button', { name: 'Toggle Changes section' }).getAttribute('aria-expanded')).toBe('true')
    expect(getByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
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
    expect(getByRole(document.body, 'button', { name: 'Pull' })).toBeTruthy()
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
      expect(findOptionByText('Workspace bootstrap', 'Commit history').getAttribute('aria-selected')).toBe('true')
      expect(findOptionByText('alpha.ts', 'Commit files').getAttribute('aria-selected')).toBe('true')
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

    expect(getByRole(document.body, 'button', { name: 'Toggle History section' }).getAttribute('aria-expanded')).toBe('true')
    expect(getByRole(document.body, 'button', { name: 'Cortex Knowledge' }).getAttribute('aria-pressed')).toBe('true')
    expect(getAllByRole(document.body, 'button', { name: 'Prompt overrides' })[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(findOptionByText('Prompt override edited for cortex (session cortex--s2)').getAttribute('aria-selected')).toBe('true')
    expect(findOptionByText('review.md').getAttribute('aria-selected')).toBe('true')
    expect(queryByText(document.body, 'Updated common knowledge for cortex (session cortex--s1)')).toBeNull()
  })

  it('filters commit rows and file rows with knowledge quick filters', async () => {
    renderDialog({ isCortex: true })
    await flushEffects()

    const history = getByRole(document.body, 'region', { name: 'History' })
    const promptFilter = getAllByRole(history, 'button', { name: 'Prompt overrides' })[0]
    click(promptFilter)
    await flushEffects()
    await flushEffects()

    expect(getByText(history, 'Prompt override edited for cortex (session cortex--s2)')).toBeTruthy()
    expect(queryByText(history, 'Updated common knowledge for cortex (session cortex--s1)')).toBeNull()
    expect(queryByText(history, 'Synced reference docs for cortex')).toBeNull()
    expect(findOptionByText('review.md', 'Commit files')).toBeTruthy()
    const commitFiles = getByRole(document.body, 'listbox', { name: 'Commit files' })
    expect(within(commitFiles).queryByText('common.md')).toBeNull()
    expect(within(commitFiles).queryByText('refine.md')).toBeNull()
  })
})
