/** @vitest-environment jsdom */

import type { GitWorktreeSummary } from '@forge/protocol'
import { createElement, useCallback, useState } from 'react'
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileBrowserSidebar } from '@/components/file-browser/FileBrowserSidebar'
import { usePanelState } from '@/hooks/index-page/use-panel-state'

vi.mock('@/components/file-browser/use-file-browser-queries', () => ({
  useDirectoryListing: () => ({
    data: { cwd: '/repo/middleman-feature', path: '', entries: [], isGitRepo: true, repoName: 'middleman', branch: 'feature/worktree-test' },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useFileCount: () => ({
    data: { count: 0, method: 'git' },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useProjectResourcesSnapshot: () => ({
    data: null,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  seedProjectResources: vi.fn(),
  invalidateFileBrowserCaches: vi.fn(),
}))

vi.mock('@/components/file-browser/FileTree', () => ({
  FileTree: () => createElement('div', { 'data-testid': 'file-tree' }, 'file tree'),
}))

const linkedWorktree: GitWorktreeSummary = {
  id: 'feature-linked',
  path: '/repo/middleman-feature',
  branch: 'feature/worktree-test',
  repoRoot: '/repo/middleman',
  headSha: 'abc123',
  isMainWorktree: false,
  isCurrentContext: false,
  dirty: false,
  dirtySummary: { filesChanged: 0, insertions: 0, deletions: 0 },
  activeAgents: [],
}

type HarnessState = {
  isDiffViewerOpen: boolean
  diffViewerPresentation: 'inline' | 'modal'
  isInlineDiffViewerOpen: boolean
  showFileBrowserSidebar: boolean
  fileBrowserWorktreeContext: ReturnType<typeof usePanelState>['fileBrowserWorktreeContext']
  isFileBrowserOpen: boolean
}

const capturedRef: { current: HarnessState | null } = { current: null }

function BrowseFlowHarness(props: { presentation: 'inline' | 'modal' }) {
  const panelState = usePanelState({ activeAgentId: 'agent-1' })
  const [isDiffViewerOpen, setIsDiffViewerOpen] = useState(true)
  const [diffViewerPresentation] = useState(props.presentation)

  const handleBrowseWorktreeFromSourceControl = useCallback(
    (worktree: GitWorktreeSummary) => {
      panelState.browseWorktreeFiles({
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        branch: worktree.branch,
        repoRoot: worktree.repoRoot,
      })
      setIsDiffViewerOpen(false)
    },
    [panelState],
  )

  const isInlineDiffViewerOpen = isDiffViewerOpen && diffViewerPresentation === 'inline'
  const showFileBrowserSidebar = !isInlineDiffViewerOpen

  capturedRef.current = {
    isDiffViewerOpen,
    diffViewerPresentation,
    isInlineDiffViewerOpen,
    showFileBrowserSidebar,
    fileBrowserWorktreeContext: panelState.fileBrowserWorktreeContext,
    isFileBrowserOpen: panelState.isFileBrowserOpen,
  }

  return createElement(
    'div',
    null,
    isInlineDiffViewerOpen
      ? createElement(
          'button',
          { type: 'button', onClick: () => handleBrowseWorktreeFromSourceControl(linkedWorktree) },
          'Browse linked worktree inline',
        )
      : null,
    diffViewerPresentation === 'modal' && isDiffViewerOpen
      ? createElement(
          'button',
          { type: 'button', onClick: () => handleBrowseWorktreeFromSourceControl(linkedWorktree) },
          'Browse linked worktree modal',
        )
      : null,
    showFileBrowserSidebar && panelState.isFileBrowserOpen
      ? createElement(FileBrowserSidebar, {
          wsUrl: 'ws://127.0.0.1:47187',
          agentId: 'agent-1',
          isOpen: true,
          onClose: panelState.toggleFileBrowser,
          onSelectFile: panelState.selectFileBrowserFile,
          selectedFile: panelState.selectedFileBrowserFile,
          worktreeContext: panelState.fileBrowserWorktreeContext,
          onClearWorktreeContext: panelState.clearFileBrowserWorktreeContext,
        })
      : null,
  )
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  capturedRef.current = null
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  capturedRef.current = null
  container.remove()
})

function renderHarness(presentation: 'inline' | 'modal') {
  act(() => {
    root = createRoot(container)
    root.render(createElement(BrowseFlowHarness, { presentation }))
  })
}

describe('BuilderSurface worktree browse integration', () => {
  it('closes inline Source Control and shows linked worktree file browser after browse', () => {
    renderHarness('inline')

    expect(capturedRef.current?.isInlineDiffViewerOpen).toBe(true)
    expect(capturedRef.current?.showFileBrowserSidebar).toBe(false)

    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(capturedRef.current?.isDiffViewerOpen).toBe(false)
    expect(capturedRef.current?.isInlineDiffViewerOpen).toBe(false)
    expect(capturedRef.current?.showFileBrowserSidebar).toBe(true)
    expect(capturedRef.current?.isFileBrowserOpen).toBe(true)
    expect(capturedRef.current?.fileBrowserWorktreeContext).toEqual({
      worktreeId: 'feature-linked',
      worktreePath: '/repo/middleman-feature',
      branch: 'feature/worktree-test',
      repoRoot: '/repo/middleman',
    })
    expect(container.textContent).toContain('Browsing linked worktree')
  })

  it('closes modal Source Control and shows linked worktree file browser after browse', () => {
    renderHarness('modal')

    expect(capturedRef.current?.isDiffViewerOpen).toBe(true)
    expect(capturedRef.current?.showFileBrowserSidebar).toBe(true)
    expect(container.textContent ?? '').not.toContain('Browsing linked worktree')

    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(capturedRef.current?.isDiffViewerOpen).toBe(false)
    expect(capturedRef.current?.isFileBrowserOpen).toBe(true)
    expect(capturedRef.current?.fileBrowserWorktreeContext?.worktreeId).toBe('feature-linked')
    expect(container.textContent).toContain('Browsing linked worktree')
  })
})
