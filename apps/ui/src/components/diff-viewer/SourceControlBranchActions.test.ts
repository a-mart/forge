/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByText, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceControlBranchActions } from './SourceControlBranchActions'
import {
  markOriginFetchCompleted,
  resetSourceControlAutoFetchFreshnessForTests,
  SOURCE_CONTROL_AUTO_FETCH_FRESHNESS_MS,
} from './source-control-auto-fetch'

const {
  fetchGitOriginMock,
  fetchMutationPreflightMock,
  switchGitBranchMock,
  pullGitFfOnlyMock,
  invalidateGitCachesMock,
} = vi.hoisted(() => ({
  fetchGitOriginMock: vi.fn(),
  fetchMutationPreflightMock: vi.fn(),
  switchGitBranchMock: vi.fn(),
  pullGitFfOnlyMock: vi.fn(),
  invalidateGitCachesMock: vi.fn(),
}))

vi.mock('./use-diff-queries', () => ({
  fetchGitOrigin: fetchGitOriginMock,
  fetchMutationPreflight: fetchMutationPreflightMock,
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
  fetchMutationPreflightMock.mockReset()
  switchGitBranchMock.mockReset()
  pullGitFfOnlyMock.mockReset()
  invalidateGitCachesMock.mockReset()
  fetchMutationPreflightMock.mockResolvedValue({ issues: [], allowed: true })
  resetSourceControlAutoFetchFreshnessForTests()
  fetchGitOriginMock.mockResolvedValue({ success: true, warnings: [], errors: [] })
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

  it('runs Source Control mutation guard before opening pull confirmation', () => {
    const runRef: { current: (() => void) | null } = { current: null }
    const onRequestMutation = vi.fn((_mutation, _target, run) => {
      runRef.current = run
    })
    renderActions({ isDirty: false, worktreeId: 'feature-linked', onRequestMutation })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Pull FF only' }))
    })

    expect(onRequestMutation).toHaveBeenCalledWith(
      'pull-ff-only',
      { agentId: 'agent-1', worktreeId: 'feature-linked' },
      expect.any(Function),
    )
    expect(document.body.textContent ?? '').not.toContain('Fast-forward pull?')

    flushSync(() => {
      runRef.current?.()
    })

    expect(getByText(document.body, 'Fast-forward pull?')).toBeTruthy()
  })

  it('runs Source Control mutation guard before opening switch and create confirmations', () => {
    const guarded: Array<{ mutation: string; run: () => void }> = []
    const onRequestMutation = vi.fn((mutation, _target, run) => {
      guarded.push({ mutation, run })
    })
    renderActions({ isDirty: false, onRequestMutation })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: /main/i }))
    })
    flushSync(() => {
      fireEvent.click(getByText(document.body, 'feature/demo'))
    })

    expect(onRequestMutation).toHaveBeenCalledWith(
      'switch-branch',
      { agentId: 'agent-1', worktreeId: null },
      expect.any(Function),
    )
    expect(document.body.textContent ?? '').not.toContain('Switch to feature/demo?')

    flushSync(() => {
      guarded[0]?.run()
    })
    expect(getByText(document.body, 'Switch to feature/demo?')).toBeTruthy()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Cancel' }))
    })
    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: /main/i }))
    })
    const input = getByRole(document.body, 'textbox') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'feature/new' } })
      fireEvent.click(getByRole(document.body, 'button', { name: 'Create branch' }))
    })

    expect(onRequestMutation).toHaveBeenLastCalledWith(
      'create-branch',
      { agentId: 'agent-1', worktreeId: null },
      expect.any(Function),
    )
  })

  it('shows idle attached-session warnings from mutation preflight', async () => {
    fetchMutationPreflightMock.mockResolvedValue({
      allowed: true,
      issues: [
        {
          code: 'idle_agents_attached',
          message: 'Idle sessions are attached to this worktree (Builder).',
          severity: 'warn',
        },
      ],
      currentBranch: 'main',
      currentHead: 'abc123',
      statusHash: 'status123',
    })

    renderActions({ isDirty: false })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Pull FF only' }))
    })

    await vi.waitFor(() => {
      expect(getByText(document.body, 'Idle sessions are attached to this worktree (Builder).')).toBeTruthy()
    })
  })

  it('summarizes huge idle attached-session warnings from mutation preflight', async () => {
    const sessionNames = Array.from({ length: 312 }, (_, index) => `Session ${index + 1}`)
    const hugeWarning = `Idle sessions are attached to this worktree (${sessionNames.join(', ')}).`
    fetchMutationPreflightMock.mockResolvedValue({
      allowed: true,
      issues: [
        {
          code: 'idle_agents_attached',
          message: hugeWarning,
          severity: 'warn',
        },
      ],
      currentBranch: 'main',
      currentHead: 'abc123',
      statusHash: 'status123',
    })

    renderActions({ isDirty: false })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Pull FF only' }))
    })

    await vi.waitFor(() => {
      expect(getByText(document.body, '312 idle sessions are attached to this worktree.')).toBeTruthy()
    })

    expect(queryByText(document.body, hugeWarning)).toBeNull()
    expect(getByRole(document.body, 'button', { name: 'Cancel' })).toBeTruthy()
    expect(getByRole(document.body, 'button', { name: 'Pull fast-forward' })).toBeTruthy()
  })

  it('shows blocking mutation-preflight issues inside the confirmation dialog', async () => {
    fetchMutationPreflightMock.mockResolvedValue({
      allowed: false,
      issues: [
        {
          code: 'ignored_untracked_would_be_overwritten',
          message: 'Fast-forward pull from "origin/main" would overwrite ignored local files: "ignored.txt".',
          severity: 'block',
        },
      ],
      currentBranch: 'main',
      currentHead: 'abc123',
      statusHash: 'status123',
    })

    renderActions({ isDirty: false })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Pull FF only' }))
    })

    await vi.waitFor(() => {
      expect(getByText(document.body, 'Fast-forward pull from "origin/main" would overwrite ignored local files: "ignored.txt".')).toBeTruthy()
    })

    expect((getByRole(document.body, 'button', { name: 'Pull fast-forward' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('auto-fetches origin when Source Control becomes active and fetch history is stale', async () => {
    renderActions({ isDirty: false, sourceControlActive: true })

    await vi.waitFor(() => {
      expect(fetchGitOriginMock).toHaveBeenCalledTimes(1)
    })

    expect(fetchGitOriginMock).toHaveBeenCalledWith('ws://127.0.0.1:47187', {
      agentId: 'agent-1',
      repoTarget: 'workspace',
      worktreeId: undefined,
      remote: 'origin',
      expectedHead: 'abc123',
      expectedStatusHash: 'status123',
    })
  })

  it('does not auto-fetch again inside the freshness window', async () => {
    markOriginFetchCompleted('agent-1:workspace:session:origin', Date.now())

    renderActions({ isDirty: false, sourceControlActive: true })
    await Promise.resolve()

    expect(fetchGitOriginMock).not.toHaveBeenCalled()
  })

  it('does not auto-fetch when Source Control is inactive', async () => {
    renderActions({ isDirty: false, sourceControlActive: false })
    await Promise.resolve()

    expect(fetchGitOriginMock).not.toHaveBeenCalled()
  })

  it('does not auto-fetch for repos without origin configured', async () => {
    renderActions({
      isDirty: false,
      sourceControlActive: true,
      branchData: {
        ...branchData,
        remotes: [],
      },
    })
    await Promise.resolve()

    expect(fetchGitOriginMock).not.toHaveBeenCalled()
  })

  it('manual fetch still works and refreshes freshness state', async () => {
    renderActions({ isDirty: false, sourceControlActive: true })
    await vi.waitFor(() => {
      expect(fetchGitOriginMock).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      const fetchButton = getByRole(container, 'button', { name: 'Fetch origin' }) as HTMLButtonElement
      expect(fetchButton.disabled).toBe(false)
    })
    fetchGitOriginMock.mockClear()

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Fetch origin' }))
    })

    await vi.waitFor(() => {
      expect(fetchGitOriginMock).toHaveBeenCalledTimes(1)
    })

    fetchGitOriginMock.mockClear()
    unmountActions()
    renderActions({ isDirty: false, sourceControlActive: false })
    await Promise.resolve()
    unmountActions()
    renderActions({ isDirty: false, sourceControlActive: true })
    await Promise.resolve()

    expect(fetchGitOriginMock).not.toHaveBeenCalled()
  })

  it('does not render auto-fetch backend errors in the header', async () => {
    fetchGitOriginMock.mockResolvedValue({
      success: false,
      errors: ['Active agents are attached to this worktree.'],
      warnings: [],
    })

    renderActions({ isDirty: false, sourceControlActive: true })

    await vi.waitFor(() => {
      expect(fetchGitOriginMock).toHaveBeenCalledTimes(1)
    })

    expect(container.textContent ?? '').not.toContain('Active agents are attached to this worktree.')
  })

  it('renders manual fetch backend errors in the header', async () => {
    fetchGitOriginMock.mockResolvedValue({
      success: false,
      errors: ['Active agents are attached to this worktree.'],
      warnings: [],
    })

    renderActions({ isDirty: false, sourceControlActive: false })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Fetch origin' }))
    })

    await vi.waitFor(() => {
      expect(getByText(container, 'Active agents are attached to this worktree.')).toBeTruthy()
    })
  })

  it('auto-fetches again after the freshness window expires', async () => {
    const key = 'agent-1:workspace:session:origin'
    const startedAt = 50_000
    vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    markOriginFetchCompleted(key, startedAt)
    vi.spyOn(Date, 'now').mockReturnValue(startedAt + SOURCE_CONTROL_AUTO_FETCH_FRESHNESS_MS)

    renderActions({ isDirty: false, sourceControlActive: true })

    await vi.waitFor(() => {
      expect(fetchGitOriginMock).toHaveBeenCalledTimes(1)
    })

    vi.mocked(Date.now).mockRestore()
  })

  it('passes worktreeId and expected guards in mutation requests', async () => {
    pullGitFfOnlyMock.mockResolvedValue({
      success: true,
      warnings: ['Idle sessions are attached to this worktree (Builder).'],
      errors: [],
    })

    renderActions({ isDirty: false, worktreeId: 'feature-linked' })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Pull FF only' }))
    })

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Pull fast-forward' }))
    })

    await vi.waitFor(() => {
      expect(pullGitFfOnlyMock).toHaveBeenCalledWith('ws://127.0.0.1:47187', {
        agentId: 'agent-1',
        repoTarget: 'workspace',
        worktreeId: 'feature-linked',
        expectedHead: 'abc123',
        expectedStatusHash: 'status123',
        remote: 'origin',
      })
    })
  })
})

function unmountActions(): void {
  root?.unmount()
  root = null
}

function renderActions(options: {
  isDirty: boolean
  worktreeId?: string
  sourceControlActive?: boolean
  branchData?: typeof branchData
  onRequestMutation?: (
    mutation: 'switch-branch' | 'create-branch' | 'pull-ff-only',
    target: { agentId: string; worktreeId: string | null },
    run: () => void,
  ) => void
}) {
  root = createRoot(container)
  flushSync(() => {
    root!.render(
      createElement(SourceControlBranchActions, {
        wsUrl: 'ws://127.0.0.1:47187',
        agentId: 'agent-1',
        repoTarget: 'workspace',
        worktreeId: options.worktreeId,
        branchesQuery: {
          data: options.branchData ?? branchData,
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        },
        isDirty: options.isDirty,
        sourceControlActive: options.sourceControlActive ?? false,
        onMutationComplete: vi.fn(),
        onRequestMutation: options.onRequestMutation,
      }),
    )
  })
}
