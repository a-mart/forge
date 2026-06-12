/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByText } from '@testing-library/dom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceControlBranchActions } from './SourceControlBranchActions'

const {
  fetchGitOriginMock,
  switchGitBranchMock,
  pullGitFfOnlyMock,
  invalidateGitCachesMock,
} = vi.hoisted(() => ({
  fetchGitOriginMock: vi.fn(),
  switchGitBranchMock: vi.fn(),
  pullGitFfOnlyMock: vi.fn(),
  invalidateGitCachesMock: vi.fn(),
}))

vi.mock('./use-diff-queries', () => ({
  fetchGitOrigin: fetchGitOriginMock,
  switchGitBranch: switchGitBranchMock,
  createGitBranch: vi.fn(),
  pullGitFfOnly: pullGitFfOnlyMock,
  invalidateGitCaches: invalidateGitCachesMock,
}))

vi.mock('@/components/file-browser/use-file-browser-queries', () => ({
  invalidateFileBrowserCaches: vi.fn(),
}))

const branchData = {
  branches: [
    { name: 'main', kind: 'current' as const, headSha: 'abc', ahead: 0, behind: 2 },
    { name: 'feature/demo', kind: 'local' as const, headSha: 'def' },
    { name: 'origin/main', kind: 'remote' as const, headSha: 'ghi' },
  ],
  remotes: ['origin'],
  currentBranch: 'main',
  currentHead: 'abc123',
  statusHash: 'status123',
  repoName: 'middleman',
  repoRoot: '/repo/middleman',
  repoKind: 'workspace' as const,
  repoLabel: 'Workspace',
  context: { repoTarget: 'workspace' as const },
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  fetchGitOriginMock.mockReset()
  switchGitBranchMock.mockReset()
  pullGitFfOnlyMock.mockReset()
  invalidateGitCachesMock.mockReset()
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
})

describe('SourceControlBranchActions', () => {
  it('renders fetch and pull controls for workspace repos', () => {
    renderActions({ isDirty: false })

    expect(getByText(container, 'Fetch origin')).toBeTruthy()
    expect(getByText(container, 'Pull FF only')).toBeTruthy()
  })

  it('disables pull when the worktree is dirty', () => {
    renderActions({ isDirty: true })

    const pullButton = getByRole(container, 'button', { name: /Pull FF only/i }) as HTMLButtonElement
    expect(pullButton.disabled).toBe(true)
  })

  it('opens a confirmation dialog before fast-forward pull', () => {
    renderActions({ isDirty: false })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Pull FF only' }))
    })

    expect(getByText(document.body, 'Fast-forward pull?')).toBeTruthy()
    expect(getByRole(document.body, 'button', { name: 'Pull fast-forward' })).toBeTruthy()
  })
})

function renderActions(options: { isDirty: boolean }) {
  root = createRoot(container)
  flushSync(() => {
    root!.render(
      createElement(SourceControlBranchActions, {
        wsUrl: 'ws://127.0.0.1:47187',
        agentId: 'agent-1',
        repoTarget: 'workspace',
        branchesQuery: {
          data: branchData,
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        },
        isDirty: options.isDirty,
        onMutationComplete: vi.fn(),
      }),
    )
  })
}
