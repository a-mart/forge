/** @vitest-environment jsdom */

import { fireEvent, getByText } from '@testing-library/dom'
import { createElement, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTree } from './FileTree'
import type { FileTreeStateSnapshot } from './FileTree'

const treeItem = {
  getItemData: () => ({ id: 'README.md', name: 'README.md', type: 'file' as const }),
  getId: () => 'README.md',
  isFolder: () => false,
  isExpanded: () => false,
  isFocused: () => false,
  isLoading: () => false,
  getItemMeta: () => ({ level: 1 }),
  getProps: () => ({}),
}

const treeMock = vi.hoisted(() => ({
  element: null as HTMLElement | null,
  setConfig: vi.fn(),
}))

vi.mock('@headless-tree/core', () => ({
  asyncDataLoaderFeature: {},
  hotkeysCoreFeature: {},
  searchFeature: {},
  selectionFeature: {},
  createTree: vi.fn(() => ({
    getState: () => ({}),
    setMounted: vi.fn(),
    rebuildTree: vi.fn(),
    setConfig: treeMock.setConfig,
    getItems: () => [treeItem],
    getContainerProps: (label: string) => ({ role: 'tree', 'aria-label': label }),
    registerElement: (element: HTMLElement | null) => {
      treeMock.element = element
    },
    getElement: () => treeMock.element,
    setSearch: vi.fn(),
    getDataRef: () => ({ current: { itemData: {}, childrenIds: {} } }),
    getItemInstance: vi.fn(),
  })),
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 28 })),
    measureElement: vi.fn(),
  }),
}))

vi.mock('./use-file-browser-queries', () => ({
  useFileSearch: () => ({ data: null, isLoading: false, error: null }),
}))

const baseSnapshot: FileTreeStateSnapshot = {
  filterText: '',
  searchMode: false,
  searchQuery: '',
  treeScrollTop: 120,
  searchScrollTop: 0,
  treeState: null,
}

let container: HTMLDivElement
let root: Root | null = null
let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame
let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame
let frameCallbacks: Array<FrameRequestCallback | null>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  treeMock.element = null
  treeMock.setConfig.mockClear()
  frameCallbacks = []
  originalRequestAnimationFrame = globalThis.requestAnimationFrame
  originalCancelAnimationFrame = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frameCallbacks.push(callback)
    return frameCallbacks.length
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((handle: number) => {
    frameCallbacks[handle - 1] = null
  }) as typeof cancelAnimationFrame
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  globalThis.requestAnimationFrame = originalRequestAnimationFrame
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  vi.clearAllMocks()
})

function renderTree(
  snapshot: FileTreeStateSnapshot = baseSnapshot,
  onTreeSnapshotChange = vi.fn(),
  props: Partial<ComponentProps<typeof FileTree>> = {},
) {
  root ??= createRoot(container)
  flushSync(() => {
    root?.render(createElement(FileTree, {
      wsUrl: 'ws://127.0.0.1:47187',
      agentId: 'session-a',
      cwd: '/repo',
      selectedFile: null,
      onSelectFile: vi.fn(),
      treeSnapshot: snapshot,
      onTreeSnapshotChange,
      fileCount: null,
      fileCountMethod: null,
      ...props,
    }))
  })
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  flushSync(() => {})
}

describe('FileTree create context menu', () => {
  it('opens an empty-space New File context menu for the workspace root', async () => {
    const onRequestCreateFile = vi.fn()
    renderTree(baseSnapshot, vi.fn(), { onRequestCreateFile })

    const scroller = container.querySelector('[aria-label="File tree"]') as HTMLDivElement | null
    expect(scroller).not.toBeNull()
    fireEvent.contextMenu(scroller!)
    await flushPromises()
    fireEvent.click(getByText(document.body, 'New File'))

    expect(onRequestCreateFile).toHaveBeenCalledWith('')
  })
})

describe('FileTree scroll restoration', () => {
  it('restores the saved tree scroll once instead of replaying live scroll snapshots', () => {
    const onTreeSnapshotChange = vi.fn()
    renderTree(baseSnapshot, onTreeSnapshotChange)

    const scroller = container.querySelector('[aria-label="File tree"]') as HTMLDivElement | null
    expect(scroller).not.toBeNull()
    expect(frameCallbacks).toHaveLength(1)
    expect(onTreeSnapshotChange).not.toHaveBeenCalledWith(expect.objectContaining({ treeScrollTop: 0 }))

    frameCallbacks[0]?.(0)
    expect(scroller?.scrollTop).toBe(120)

    scroller!.scrollTop = 240
    fireEvent.scroll(scroller!)
    expect(onTreeSnapshotChange).toHaveBeenLastCalledWith(expect.objectContaining({ treeScrollTop: 240 }))

    renderTree({ ...baseSnapshot, treeScrollTop: 240 }, onTreeSnapshotChange)

    expect(frameCallbacks).toHaveLength(1)
    expect(scroller?.scrollTop).toBe(240)
  })
})
