/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByText, queryByLabelText, queryByText } from '@testing-library/dom'
import { createElement, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileBrowserSidebar } from './FileBrowserSidebar'

const fileBrowserQueriesMock = vi.hoisted(() => ({
  seedProjectResources: vi.fn(),
  invalidateFileBrowserCaches: vi.fn(),
  rootListRefetch: vi.fn(),
  fileCountRefetch: vi.fn(),
  projectResourcesRefetch: vi.fn(),
  projectResourcesSnapshot: {
    generatedAt: '2026-05-19T00:00:00.000Z',
    profileId: 'profile-a',
    sessionAgentId: 'session-a',
    cwdRealpath: '/repo',
    detectedGitRoot: '/repo',
    defaultForgeDir: '/repo/.forge',
    source: 'git-root',
    trust: { state: 'not_applicable' },
    signature: 'sig',
    scaffold: { targetDir: '/repo/.forge', canSeed: true, missing: ['.forge/README.md'] },
    resources: {
      skills: { exists: false, count: 0, items: [] },
      specialists: { exists: false, count: 0, items: [] },
      reference: { exists: false, count: 0, items: [] },
      forgeExtensions: { exists: false, count: 0, items: [] },
      piExtensions: { exists: false, count: 0, items: [] },
      piSettings: { exists: false, count: 0, items: [] },
    },
    executableSurfaces: [],
  },
}))

vi.mock('./use-file-browser-queries', () => ({
  useDirectoryListing: () => ({
    data: { cwd: '/repo', path: '', entries: [], isGitRepo: true, repoName: 'repo', branch: 'main' },
    isLoading: false,
    error: null,
    refetch: fileBrowserQueriesMock.rootListRefetch,
  }),
  useFileCount: () => ({
    data: { count: 0, method: 'git' },
    isLoading: false,
    error: null,
    refetch: fileBrowserQueriesMock.fileCountRefetch,
  }),
  useProjectResourcesSnapshot: () => ({
    data: fileBrowserQueriesMock.projectResourcesSnapshot,
    isLoading: false,
    error: null,
    refetch: fileBrowserQueriesMock.projectResourcesRefetch,
  }),
  seedProjectResources: (...args: unknown[]) => fileBrowserQueriesMock.seedProjectResources(...args),
  invalidateFileBrowserCaches: () => fileBrowserQueriesMock.invalidateFileBrowserCaches(),
}))

const fileTreeMock = vi.hoisted(() => ({
  renderCount: 0,
  FileTree: vi.fn(() => {
    fileTreeMock.renderCount += 1
    return createElement('div', { 'data-testid': 'file-tree' }, 'file tree')
  }),
}))

vi.mock('./FileTree', () => ({
  FileTree: fileTreeMock.FileTree,
}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  fileTreeMock.renderCount = 0
  fileTreeMock.FileTree.mockClear()
  fileBrowserQueriesMock.projectResourcesSnapshot = {
    ...fileBrowserQueriesMock.projectResourcesSnapshot,
    profileId: 'profile-a',
    sessionAgentId: 'session-a',
    scaffold: { targetDir: '/repo/.forge', canSeed: true, missing: ['.forge/README.md'] },
  }
  fileBrowserQueriesMock.seedProjectResources.mockResolvedValue({ success: true, snapshot: fileBrowserQueriesMock.projectResourcesSnapshot })
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.clearAllMocks()
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

function renderSidebar(props: Partial<ComponentProps<typeof FileBrowserSidebar>> = {}) {
  root ??= createRoot(container)
  flushSync(() => {
    root?.render(createElement(FileBrowserSidebar, {
      wsUrl: 'ws://127.0.0.1:47187',
      agentId: 'session-a',
      isOpen: true,
      onClose: vi.fn(),
      onSelectFile: vi.fn(),
      selectedFile: null,
      projectResourceProfileId: 'profile-a',
      projectResourceSessionAgentId: 'session-a',
      ...props,
    }))
  })
}

describe('FileBrowserSidebar layout placement', () => {
  it('places the resize handle after the file tree pane for left workspace layout', () => {
    renderSidebar({ desktopPlacement: 'left', desktopOnly: true })

    const firstChild = container.firstElementChild
    const secondChild = firstChild?.nextElementSibling

    expect(firstChild?.getAttribute('aria-label')).toBe('File browser')
    expect(secondChild?.className).toContain('cursor-col-resize')
    expect(firstChild?.className).toContain('md:border-r')
    expect(firstChild?.className).toContain('max-md:hidden')
  })
})

describe('FileBrowserSidebar project resource scaffold action', () => {
  it('shows the seed action when scaffold entries are missing and reports success', async () => {
    renderSidebar()

    const button = getByLabelText(container, 'Create .forge project resources')
    fireEvent.click(button)
    await flushPromises()

    expect(fileBrowserQueriesMock.seedProjectResources).toHaveBeenCalledWith('ws://127.0.0.1:47187', {
      profileId: 'profile-a',
      sessionAgentId: 'session-a',
    })
    expect(getByText(container, 'Created .forge project resources.')).toBeTruthy()
  })

  it('hides the seed action when scaffold is complete', () => {
    fileBrowserQueriesMock.projectResourcesSnapshot = {
      ...fileBrowserQueriesMock.projectResourcesSnapshot,
      scaffold: { targetDir: '/repo/.forge', canSeed: true, missing: [] },
    }

    renderSidebar()

    expect(queryByLabelText(container, 'Create .forge project resources')).toBeNull()
  })

  it('clears seed status when project resource context changes', async () => {
    renderSidebar()
    fireEvent.click(getByLabelText(container, 'Create .forge project resources'))
    await flushPromises()
    expect(getByText(container, 'Created .forge project resources.')).toBeTruthy()

    renderSidebar({ agentId: 'session-b', projectResourceSessionAgentId: 'session-b' })
    await flushPromises()

    expect(queryByText(container, 'Created .forge project resources.')).toBeNull()
  })
})

describe('FileBrowserSidebar worktree context', () => {
  it('shows linked worktree banner when worktree context is selected', () => {
    renderSidebar({
      worktreeContext: {
        worktreeId: 'feature-linked',
        worktreePath: '/repo/middleman-feature',
        branch: 'feature/worktree-test',
        repoRoot: '/repo/middleman',
      },
    })

    expect(getByText(container, 'Browsing linked worktree')).toBeTruthy()
    expect(getByText(container, '/repo/middleman-feature')).toBeTruthy()
  })

  it('calls clear handler when switching back to session context', () => {
    const onClearWorktreeContext = vi.fn()
    renderSidebar({
      selectedFile: 'linked-only.txt',
      worktreeContext: {
        worktreeId: 'feature-linked',
        worktreePath: '/repo/middleman-feature',
        branch: 'feature/worktree-test',
        repoRoot: '/repo/middleman',
      },
      onClearWorktreeContext,
    })

    fireEvent.click(getByText(container, 'Use session'))
    expect(onClearWorktreeContext).toHaveBeenCalledTimes(1)
  })

  it('remounts the file tree when agent or worktree context changes', () => {
    renderSidebar({
      worktreeContext: {
        worktreeId: 'feature-linked',
        worktreePath: '/repo/middleman-feature',
        branch: 'feature/worktree-test',
        repoRoot: '/repo/middleman',
      },
    })
    expect(fileTreeMock.renderCount).toBe(1)

    renderSidebar({
      worktreeContext: {
        worktreeId: 'feature-other',
        worktreePath: '/repo/middleman-other',
        branch: 'feature/other',
        repoRoot: '/repo/middleman',
      },
    })
    expect(fileTreeMock.renderCount).toBe(2)

    renderSidebar({ agentId: 'session-b' })
    expect(fileTreeMock.renderCount).toBe(3)
  })
})
