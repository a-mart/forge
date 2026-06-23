/** @vitest-environment jsdom */

import { fireEvent, getAllByText, getByRole, getByText, getByTitle } from '@testing-library/dom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PullRequestsTab } from './PullRequestsTab'
import type { GitPullRequestsQueryResult } from './use-diff-queries'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-23T12:00:00Z'))
  const storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
      removeItem: (key: string) => {
        storage.delete(key)
      },
      clear: () => storage.clear(),
    },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  root = null
  container?.remove()
  window.localStorage.clear()
  vi.restoreAllMocks()
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
    expect(getByText(container, 'Current')).toBeTruthy()
    expect(getAllByText(container, /Enhanced Source Control workspace/).length).toBeGreaterThan(0)
    expect(getByRole(container, 'link', { name: /Open in browser/i })).toBeTruthy()
  })

  it('labels recently closed row timestamps by merged or closed time and sorts by close time', () => {
    renderTab({
      data: {
        ...readyPullRequestsData(),
        recentlyClosed: [
          {
            number: 421,
            title: 'Closed without merge',
            state: 'closed',
            author: 'reviewer',
            createdAt: '2026-06-01T10:00:00Z',
            updatedAt: '2026-06-22T11:00:00Z',
            closedAt: '2026-06-18T12:00:00Z',
            headRef: 'fix/closed-pr',
            baseRef: 'main',
            isDraft: false,
            isCurrentBranch: false,
            providerUrl: 'https://github.com/a-mart/forge/pull/421',
          },
          {
            number: 417,
            title: 'Merged three weeks ago despite later updates',
            state: 'merged',
            author: 'backend-specialist',
            createdAt: '2026-05-31T10:00:00Z',
            updatedAt: '2026-06-23T11:00:00Z',
            closedAt: '2026-06-02T10:00:00Z',
            mergedAt: '2026-06-02T10:00:00Z',
            headRef: 'fix/merged-pr',
            baseRef: 'main',
            isDraft: false,
            isCurrentBranch: false,
            providerUrl: 'https://github.com/a-mart/forge/pull/417',
          },
        ],
      },
    })

    expect(getByText(container, 'closed 5d ago')).toBeTruthy()
    expect(getByText(container, 'merged 21d ago')).toBeTruthy()
    expect(() => getByText(container, '1h ago')).toThrow()

    const pullRequestButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Pull request #"]'))
    expect(pullRequestButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Pull request #428: Enhanced Source Control workspace',
      'Pull request #421: Closed without merge',
      'Pull request #417: Merged three weeks ago despite later updates',
    ])
  })

  it('renders a dense resizable pull request list column by default', () => {
    renderTab({
      data: readyPullRequestsData(),
      currentBranch: 'feature/git-source-control-workspace',
    })

    const resizeHandle = getByRole(container, 'separator', { name: /resize pull request list/i })
    expect(resizeHandle.previousElementSibling).toBeInstanceOf(HTMLElement)
    expect((resizeHandle.previousElementSibling as HTMLElement).style.width).toBe('460px')
    expect(getByRole(container, 'button', { name: /Pull request #428/i }).className).toContain('border-b')
  })

  it('uses the new pull request list storage key so old narrow persisted widths do not override the wider default', () => {
    window.localStorage.setItem('forge-diff-pull-requests-list-width', '340')

    renderTab({
      data: readyPullRequestsData(),
      currentBranch: 'feature/git-source-control-workspace',
    })

    const resizeHandle = getByRole(container, 'separator', { name: /resize pull request list/i })
    expect(resizeHandle.previousElementSibling).toBeInstanceOf(HTMLElement)
    expect((resizeHandle.previousElementSibling as HTMLElement).style.width).toBe('460px')
  })

  it('allows resizing the pull request list wider for real row content', async () => {
    renderTab({
      data: readyPullRequestsData(),
      currentBranch: 'feature/git-source-control-workspace',
    })

    const resizeHandle = getByRole(container, 'separator', { name: /resize pull request list/i })
    const listPane = resizeHandle.previousElementSibling as HTMLElement

    fireEvent.mouseDown(resizeHandle, { clientX: 0 })
    await waitForResizableDragListeners()
    fireEvent.mouseMove(document, { clientX: 1_000 })
    fireEvent.mouseUp(document)
    await waitForResizableDragListeners()

    expect(listPane.style.width).toBe('720px')
    expect(window.localStorage.getItem('forge-diff-pull-requests-list-width-v2')).toBe('720')
  })

  it('keeps long pull request titles and branch refs in compact truncation affordances', () => {
    const longTitle = 'Improve the pull request list card layout with a very long title that should not widen the list pane'
    const longHeadRef = 'feature/source-control/pull-request-list-card-overflow-with-extremely-long-branch-name'
    const longBaseRef = 'release/2026-06-long-lived-stabilization-branch'

    renderTab({
      data: {
        ...readyPullRequestsData(),
        open: [
          {
            ...readyPullRequestsData().open[0],
            title: longTitle,
            headRef: longHeadRef,
            baseRef: longBaseRef,
            checkStatus: 'pending',
          },
        ],
      },
    })

    expect(getByTitle(container, longTitle)).toBeTruthy()
    expect(getByTitle(container, `${longHeadRef} → ${longBaseRef}`)).toBeTruthy()
    expect(getByText(container, 'Pending')).toBeTruthy()
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

async function waitForResizableDragListeners() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function readyPullRequestsData(): NonNullable<GitPullRequestsQueryResult['data']> {
  return {
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
    recentlyClosed: [],
    currentBranchPullRequest: null,
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
  }
}

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
