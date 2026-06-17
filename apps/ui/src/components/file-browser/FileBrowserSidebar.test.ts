/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole, getByText, queryByLabelText, queryByRole, queryByText } from '@testing-library/dom'
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
  FileTree: vi.fn((props: { onRequestDelete?: (path: string, entryType: 'file' | 'directory') => void }) => {
    fileTreeMock.renderCount += 1
    return createElement('div', { 'data-testid': 'file-tree' },
      'file tree',
      props.onRequestDelete
        ? createElement('button', {
            type: 'button',
            onClick: () => props.onRequestDelete?.('src', 'directory'),
          }, 'Request delete folder')
        : null,
    )
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

describe('FileBrowserSidebar delete confirmation', () => {
  it('keeps the delete dialog open and shows backend errors after a failed delete', async () => {
    const onDeleteEntry = vi.fn().mockRejectedValue(new Error('HTTP 404: route not loaded'))
    renderSidebar({ onDeleteEntry })

    flushSync(() => fireEvent.click(getByText(container, 'Request delete folder')))
    expect(getByText(document.body, 'Delete folder')).toBeTruthy()
    expect(document.body.textContent).toContain('folder and its contents')

    fireEvent.click(getByRole(document.body, 'button', { name: 'Delete permanently', hidden: true }))
    await flushPromises()

    expect(onDeleteEntry).toHaveBeenCalledWith('src', 'directory')
    expect(getByRole(document.body, 'alert', { hidden: true }).textContent).toContain('HTTP 404: route not loaded')
    expect(getByRole(document.body, 'button', { name: 'Delete permanently', hidden: true })).toBeTruthy()
    expect(getByRole(document.body, 'button', { name: 'Cancel', hidden: true })).toBeTruthy()
  })

  it('closes the delete dialog after a successful delete and supports retry after failure', async () => {
    const onDeleteEntry = vi
      .fn()
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce(true)
    renderSidebar({ onDeleteEntry })

    flushSync(() => fireEvent.click(getByText(container, 'Request delete folder')))
    fireEvent.click(getByRole(document.body, 'button', { name: 'Delete permanently', hidden: true }))
    await flushPromises()

    expect(getByRole(document.body, 'alert', { hidden: true }).textContent).toContain('Permission denied')

    fireEvent.click(getByRole(document.body, 'button', { name: 'Delete permanently', hidden: true }))
    await flushPromises()

    expect(onDeleteEntry).toHaveBeenCalledTimes(2)
    expect(queryByRole(document.body, 'alertdialog', { hidden: true })).toBeNull()
  })

  it('leaves the delete dialog open without an error when dirty guard cancels deletion', async () => {
    const onDeleteEntry = vi.fn().mockResolvedValue(false)
    renderSidebar({ onDeleteEntry })

    flushSync(() => fireEvent.click(getByText(container, 'Request delete folder')))
    fireEvent.click(getByRole(document.body, 'button', { name: 'Delete permanently', hidden: true }))
    await flushPromises()

    expect(queryByRole(document.body, 'alert', { hidden: true })).toBeNull()
    expect(getByRole(document.body, 'alertdialog', { hidden: true })).toBeTruthy()
    expect((getByRole(document.body, 'button', { name: 'Delete permanently', hidden: true }) as HTMLButtonElement).disabled).toBe(false)
    expect((getByRole(document.body, 'button', { name: 'Cancel', hidden: true }) as HTMLButtonElement).disabled).toBe(false)
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
