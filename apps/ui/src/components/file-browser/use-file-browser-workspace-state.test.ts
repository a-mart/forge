/** @vitest-environment jsdom */

import { createElement, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useFileBrowserWorkspaceState } from './use-file-browser-workspace-state'
import type { FileBrowserWorktreeSelection } from '@/hooks/index-page/use-panel-state'

let container: HTMLDivElement
let root: Root | null = null
const captured: {
  current: {
    state: ReturnType<typeof useFileBrowserWorkspaceState>
    setWorktreeContext: (context: FileBrowserWorktreeSelection | null) => void
  } | null
} = { current: null }

function Harness() {
  const [worktreeContext, setWorktreeContext] = useState<FileBrowserWorktreeSelection | null>(null)
  const state = useFileBrowserWorkspaceState({ activeAgentId: 'agent-1', worktreeContext })
  useEffect(() => {
    captured.current = { state, setWorktreeContext }
  }, [state])
  return null
}

function render() {
  act(() => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  captured.current = null
  container.remove()
})

describe('useFileBrowserWorkspaceState', () => {
  it('replaces one clean preview tab on single-click opens', () => {
    render()

    act(() => captured.current!.state.openPreviewFile('src/A.ts'))
    expect(captured.current!.state.tabs).toHaveLength(1)
    expect(captured.current!.state.activeFilePath).toBe('src/A.ts')
    expect(captured.current!.state.previewTabId).toBe(captured.current!.state.activeTabId)

    act(() => captured.current!.state.openPreviewFile('src/B.ts'))
    expect(captured.current!.state.tabs).toHaveLength(1)
    expect(captured.current!.state.activeFilePath).toBe('src/B.ts')
    expect(captured.current!.state.tabs[0].sticky).toBe(false)
  })

  it('keeps sticky tabs and uses a separate preview tab', () => {
    render()

    act(() => captured.current!.state.openStickyFile('src/A.ts'))
    act(() => captured.current!.state.openPreviewFile('src/B.ts'))

    expect(captured.current!.state.tabs.map((tab) => tab.filePath)).toEqual(['src/A.ts', 'src/B.ts'])
    expect(captured.current!.state.tabs[0].sticky).toBe(true)
    expect(captured.current!.state.tabs[1].sticky).toBe(false)
    expect(captured.current!.state.activeFilePath).toBe('src/B.ts')
  })

  it('stickifies an existing preview tab', () => {
    render()

    act(() => captured.current!.state.openPreviewFile('src/A.ts'))
    const tabId = captured.current!.state.activeTabId!
    act(() => captured.current!.state.stickifyTab(tabId))

    expect(captured.current!.state.tabs[0].sticky).toBe(true)
    expect(captured.current!.state.previewTabId).toBeNull()
  })

  it('activates the nearest neighbor when closing the active tab', () => {
    render()

    act(() => captured.current!.state.openStickyFile('src/A.ts'))
    act(() => captured.current!.state.openStickyFile('src/B.ts'))
    const firstTabId = captured.current!.state.tabs[0].id
    const secondTabId = captured.current!.state.tabs[1].id

    act(() => captured.current!.state.activateTab(firstTabId))
    act(() => captured.current!.state.closeTab(firstTabId))

    expect(captured.current!.state.activeTabId).toBe(secondTabId)
    expect(captured.current!.state.activeFilePath).toBe('src/B.ts')
  })

  it('keeps session and worktree scopes separate in memory', () => {
    render()

    act(() => captured.current!.state.openStickyFile('src/session.ts'))
    act(() => captured.current!.setWorktreeContext({
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt',
      branch: 'feature/x',
      repoRoot: '/repo/main',
    }))
    expect(captured.current!.state.activeFilePath).toBeNull()

    act(() => captured.current!.state.openStickyFile('src/worktree.ts'))
    expect(captured.current!.state.activeFilePath).toBe('src/worktree.ts')

    act(() => captured.current!.setWorktreeContext(null))
    expect(captured.current!.state.activeFilePath).toBe('src/session.ts')
  })

  it('removes tabs affected by file or directory delete', () => {
    render()

    act(() => captured.current!.state.openStickyFile('src/A.ts'))
    act(() => captured.current!.state.openStickyFile('src/nested/B.ts'))
    act(() => captured.current!.state.openStickyFile('other/C.ts'))

    act(() => captured.current!.state.removeTabsAffectedByDelete('src', 'directory'))

    expect(captured.current!.state.tabs.map((tab) => tab.filePath)).toEqual(['other/C.ts'])
    expect(captured.current!.state.activeFilePath).toBe('other/C.ts')
  })
})
