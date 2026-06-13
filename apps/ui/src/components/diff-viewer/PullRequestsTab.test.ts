/** @vitest-environment jsdom */

import { getAllByText, getByRole, getByText } from '@testing-library/dom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PullRequestsTab } from './PullRequestsTab'
import type { GitPullRequestsQueryResult } from './use-diff-queries'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
})

describe('PullRequestsTab', () => {
  it('shows setup guidance when provider is unavailable', () => {
    renderTab({
      data: {
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
        repoName: 'forge',
        repoRoot: '/repo/forge',
        repoKind: 'workspace',
        repoLabel: 'Workspace',
        context: { repoTarget: 'workspace' },
      },
    })

    expect(getByText(container, /GitHub pull requests unavailable/i)).toBeTruthy()
    expect(getByText(container, /Install GitHub CLI/i)).toBeTruthy()
  })

  it('renders open and recently closed groups with current branch highlight', () => {
    renderTab({
      data: {
        open: [
          {
            number: 428,
            title: 'Enhanced Source Control workspace',
            state: 'open',
            author: 'adam',
            createdAt: '2026-06-10T10:00:00Z',
            updatedAt: '2026-06-12T09:00:00Z',
            headRef: 'feature/git-source-control-workspace',
            baseRef: 'main',
            isDraft: false,
            isCurrentBranch: true,
            checkStatus: 'success',
            providerUrl: 'https://github.com/a-mart/forge/pull/428',
          },
        ],
        recentlyClosed: [
          {
            number: 417,
            title: 'Archive recency cleanup',
            state: 'merged',
            author: 'backend-specialist',
            createdAt: '2026-06-01T10:00:00Z',
            updatedAt: '2026-06-02T10:00:00Z',
            mergedAt: '2026-06-02T10:00:00Z',
            headRef: 'fix/archive-recency',
            baseRef: 'main',
            isDraft: false,
            isCurrentBranch: false,
            checkStatus: 'success',
            providerUrl: 'https://github.com/a-mart/forge/pull/417',
          },
        ],
        currentBranchPullRequest: {
          number: 428,
          title: 'Enhanced Source Control workspace',
          state: 'open',
          author: 'adam',
          createdAt: '2026-06-10T10:00:00Z',
          updatedAt: '2026-06-12T09:00:00Z',
          headRef: 'feature/git-source-control-workspace',
          baseRef: 'main',
          isDraft: false,
          isCurrentBranch: true,
          providerUrl: 'https://github.com/a-mart/forge/pull/428',
        },
        providerStatus: {
          provider: 'github',
          available: true,
          authenticated: true,
          remoteUrl: 'git@github.com:a-mart/forge.git',
        },
        repoName: 'forge',
        repoRoot: '/repo/forge',
        repoKind: 'workspace',
        repoLabel: 'Workspace',
        context: { repoTarget: 'workspace' },
      },
      currentBranch: 'feature/git-source-control-workspace',
    })

    expect(getByText(container, 'Open')).toBeTruthy()
    expect(getByText(container, 'Recently closed')).toBeTruthy()
    expect(getByText(container, 'Current branch PR')).toBeTruthy()
    expect(getAllByText(container, /Enhanced Source Control workspace/).length).toBeGreaterThan(0)
    expect(getByRole(container, 'link', { name: /Open in browser/i })).toBeTruthy()
  })

  it('shows empty state when provider is ready but no pull requests exist', () => {
    renderTab({
      data: {
        open: [],
        recentlyClosed: [],
        currentBranchPullRequest: null,
        listError: null,
        providerStatus: {
          provider: 'github',
          available: true,
          authenticated: true,
          remoteUrl: 'git@github.com:a-mart/forge.git',
        },
        repoName: 'forge',
        repoRoot: '/repo/forge',
        repoKind: 'workspace',
        repoLabel: 'Workspace',
        context: { repoTarget: 'workspace' },
      },
    })

    expect(getByText(container, /No pull requests found/i)).toBeTruthy()
  })

  it('shows list failure guidance instead of empty state when gh list fails', () => {
    renderTab({
      data: {
        open: [],
        recentlyClosed: [],
        currentBranchPullRequest: null,
        listError: {
          code: 'rate_limit',
          message: 'GitHub rate limit reached. Try again later.',
        },
        providerStatus: {
          provider: 'github',
          available: true,
          authenticated: true,
          remoteUrl: 'git@github.com:a-mart/forge.git',
        },
        repoName: 'forge',
        repoRoot: '/repo/forge',
        repoKind: 'workspace',
        repoLabel: 'Workspace',
        context: { repoTarget: 'workspace' },
      },
    })

    expect(getByText(container, /Could not load pull requests/i)).toBeTruthy()
    expect(getByText(container, /GitHub rate limit reached/i)).toBeTruthy()
    expect(() => getByText(container, /No pull requests found/i)).toThrow()
  })

  it('shows query error state', () => {
    renderTab({
      error: 'GitHub pull request request failed.',
    })

    expect(getByText(container, /GitHub pull request request failed/i)).toBeTruthy()
  })
})

function renderTab(options: {
  data?: GitPullRequestsQueryResult['data']
  error?: string | null
  currentBranch?: string | null
}) {
  const query: GitPullRequestsQueryResult = {
    data: options.data ?? null,
    isLoading: false,
    error: options.error ?? null,
    refetch: async () => undefined,
  }

  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(PullRequestsTab, {
        wsUrl: 'ws://127.0.0.1:47187',
        agentId: 'alpha--s1',
        repoTarget: 'workspace',
        currentBranch: options.currentBranch ?? 'main',
        pullRequestsQuery: query,
      }),
    )
  })
}
