/** @vitest-environment jsdom */

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileBrowserPanel } from './FileBrowserPanel'

vi.mock('./use-file-browser-queries', () => ({
  useDirectoryListing: () => ({
    data: { cwd: '/repo', path: '', entries: [] },
    isLoading: false,
    error: null,
  }),
  useFileContent: () => ({
    data: { content: 'hello', size: 5 },
    isLoading: false,
    error: null,
  }),
}))

vi.mock('./FileContentViewer', () => ({
  FileContentViewer: () => createElement('div', { 'data-testid': 'file-content-viewer' }, 'file content'),
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
})
