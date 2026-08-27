/** @vitest-environment jsdom */

import { createElement, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileBrowserPanel } from './FileBrowserPanel'
import type { FileContentResult } from './use-file-browser-queries'
import type { FileEditSessionController } from './use-file-edit-sessions'
import { useFileEditSessions } from './use-file-edit-sessions'
import type { FileEditorSessionKey } from './use-file-editor-coordinator'

const capturedViewerProps: Array<Record<string, unknown>> = []

const cachedFileContent = {
  content: 'cached content',
  binary: false,
  size: 14,
  lines: 1,
  encoding: 'utf8' as const,
  version: { kind: 'sha256-stat-v1' as const, sha256: 'cached', size: 14, mtimeMs: 1 },
  editability: { editable: true, maxEditableBytes: 1024 },
}

const useFileContentMock = vi.fn((
  _wsUrl: string,
  _agentId: string | null,
  filePath: string | null,
  _worktreeId?: string | null,
  _refreshNonce?: number,
) => ({
  data: filePath ? cachedFileContent : null,
  isLoading: false,
  error: null,
}))

vi.mock('./use-file-browser-queries', () => ({
  useDirectoryListing: () => ({
    data: { cwd: '/repo', path: '', entries: [] },
    isLoading: false,
    error: null,
  }),
  useFileContent: (
    wsUrl: string,
    agentId: string | null,
    filePath: string | null,
    worktreeId?: string | null,
    refreshNonce?: number,
  ) => useFileContentMock(wsUrl, agentId, filePath, worktreeId, refreshNonce),
}))

vi.mock('./FileContentViewer', () => ({
  FileContentViewer: (props: Record<string, unknown>) => {
    capturedViewerProps.push(props)
    return createElement('div', { 'data-testid': 'file-content-viewer' }, 'file content')
  },
  useFileViewerInfo: () => ({
    languageDisplayName: 'TypeScript',
    lineCount: 1,
    fileSize: '5 B',
  }),
}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  capturedViewerProps.length = 0
  useFileContentMock.mockReturnValue({
    data: cachedFileContent,
    isLoading: false,
    error: null,
  })
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

function renderPanel(props: Partial<Parameters<typeof FileBrowserPanel>[0]> = {}) {
  root ??= createRoot(container)
  flushSync(() => {
    root?.render(createElement(FileBrowserPanel, {
      wsUrl: 'ws://127.0.0.1:47187',
      agentId: 'session-a',
      filePath: '/repo/src/file.ts',
      onClose: vi.fn(),
      onNavigateToDirectory: vi.fn(),
      ...props,
    }))
  })
}

function createEditSession(dirty = false): FileEditSessionController {
  return {
    state: {
      key: null,
      mode: 'edit',
      draft: dirty ? 'changed' : 'hello',
      baseContent: 'hello',
      baseVersion: null,
      dirty,
      focused: false,
      saveState: 'idle',
      error: null,
      conflict: null,
    },
    canEnterEditMode: true,
    enterEditMode: vi.fn(),
    updateDraft: vi.fn(),
    setFocused: vi.fn(),
    save: vi.fn(),
    reloadFromDisk: vi.fn(),
    dismissConflict: vi.fn(),
    revert: vi.fn(),
    discard: vi.fn(),
    getDirtySnapshot: vi.fn(),
  }
}

describe('FileBrowserPanel resize handle placement', () => {
  it('places the desktop inline resize handle on the right edge of the preview pane', () => {
    renderPanel({ desktopOnly: true, resizeHandlePlacement: 'right' })

    const panel = container.querySelector('[data-testid="file-content-viewer"]')?.closest('.flex.h-full')
    expect(panel).not.toBeNull()
    expect(panel?.className).toContain('border-r')
    expect(panel?.className).not.toContain('border-l')

    const firstChild = container.firstElementChild
    const secondChild = firstChild?.nextElementSibling
    expect(firstChild).toBe(panel)
    expect(secondChild?.className).toContain('cursor-col-resize')
  })

  it('keeps the default drawer resize handle on the left edge', () => {
    renderPanel()

    const firstChild = container.firstElementChild
    const secondChild = firstChild?.nextElementSibling
    expect(firstChild?.className).toContain('cursor-col-resize')
    expect(secondChild?.className).toContain('border-l')
  })

  it('shows a compact unsaved indicator in the panel header for dirty edits', () => {
    renderPanel({ editSession: createEditSession(true) })

    expect(container.textContent).toContain('Unsaved')
  })

  it('keeps mobile panels read-only even when inline editing is enabled globally', () => {
    renderPanel({
      mobileOnly: true,
      inlineEditingEnabled: true,
      editSession: createEditSession(true),
    })

    expect(capturedViewerProps.at(-1)?.inlineEditingEnabled).toBe(false)
  })

  it('passes inline editing only to the writable desktop panel instance', () => {
    renderPanel({
      desktopOnly: true,
      inlineEditingEnabled: true,
      editSession: createEditSession(false),
    })

    expect(capturedViewerProps.at(-1)?.inlineEditingEnabled).toBe(true)
  })

  it('reports cached synchronous content to onContentLoaded on mount and remount', () => {
    const onContentLoaded = vi.fn()
    const editorSessionKey = {
      agentId: 'session-a',
      worktreeId: null,
      filePath: 'src/file.ts',
    }

    renderPanel({ onContentLoaded, editorSessionKey })

    expect(onContentLoaded).toHaveBeenCalledWith(editorSessionKey, cachedFileContent)
    onContentLoaded.mockClear()

    flushSync(() => root?.unmount())
    root = null

    renderPanel({ onContentLoaded, editorSessionKey })

    expect(onContentLoaded).toHaveBeenCalledWith(editorSessionKey, cachedFileContent)
    expect(onContentLoaded).not.toHaveBeenCalledWith(editorSessionKey, null)
  })

  it('does not loop when panel content loading updates edit sessions with cached content', () => {
    const editorSessionKey: FileEditorSessionKey = {
      agentId: 'session-a',
      worktreeId: null,
      filePath: '/repo/src/file.ts',
    }
    const onContentLoadedObserved = vi.fn()

    function PanelWithEditSessions() {
      const sessions = useFileEditSessions({
        wsUrl: 'ws://127.0.0.1:47187',
        activeKey: editorSessionKey,
        editingEnabled: true,
      })
      const handleContentLoaded = useCallback((key: FileEditorSessionKey, content: FileContentResult | null) => {
        onContentLoadedObserved(key, content)
        sessions.handleContentLoaded(key, content)
      }, [sessions])

      return createElement(FileBrowserPanel, {
        wsUrl: 'ws://127.0.0.1:47187',
        agentId: 'session-a',
        filePath: '/repo/src/file.ts',
        onClose: vi.fn(),
        onNavigateToDirectory: vi.fn(),
        editorSessionKey,
        onContentLoaded: handleContentLoaded,
      })
    }

    root ??= createRoot(container)
    expect(() => {
      flushSync(() => root?.render(createElement(PanelWithEditSessions)))
    }).not.toThrow()

    expect(onContentLoadedObserved.mock.calls.length).toBeGreaterThan(0)
    expect(onContentLoadedObserved.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('does not fetch JSON content for PDF files', () => {
    useFileContentMock.mockClear()
    renderPanel({ filePath: 'docs/spec.pdf' })

    expect(useFileContentMock).toHaveBeenCalledWith(
      'ws://127.0.0.1:47187',
      'session-a',
      null,
      null,
      0,
    )
  })
})
