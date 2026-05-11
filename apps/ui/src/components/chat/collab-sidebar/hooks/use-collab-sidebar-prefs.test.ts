/** @vitest-environment jsdom */

import { createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useCollabSidebarPrefs } from './use-collab-sidebar-prefs'

const STORAGE_KEY_PREFIX = 'forge:collab:v1:collapsed-categories:'

// ---------------------------------------------------------------------------
// localStorage mock (matches project convention)
// ---------------------------------------------------------------------------

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => { store[key] = value },
    removeItem: (key: string): void => { delete store[key] },
    clear: (): void => { store = {} },
    get length(): number { return Object.keys(store).length },
    key: (index: number): string | null => Object.keys(store)[index] ?? null,
  }
})()

Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let container: HTMLDivElement
let root: Root | null = null

const captured: {
  current: {
    collapsedCategoryIds: Set<string>
    toggleCategoryCollapsed: (categoryId: string) => void
  } | null
} = { current: null }

function TestComponent({ workspaceIds }: { workspaceIds: readonly string[] }) {
  const result = useCollabSidebarPrefs(workspaceIds)

  useEffect(() => {
    captured.current = result
  })

  return createElement('div', null, `collapsed=${[...result.collapsedCategoryIds].sort().join(',')}`)
}

function renderHook(workspaceIds: readonly string[]) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(TestComponent, { workspaceIds }))
  })
}

function rerenderHook(workspaceIds: readonly string[]) {
  // Use `act` (not just flushSync) so that nested effect-triggered re-renders
  // (idsKey change → setState → re-render) are fully flushed.
  act(() => {
    root?.render(createElement(TestComponent, { workspaceIds }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  captured.current = null
  localStorageMock.clear()
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
    root = null
  }
  container.remove()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useCollabSidebarPrefs — single workspace', () => {
  it('returns empty set when no persisted state exists', () => {
    renderHook(['ws-1'])
    expect(captured.current?.collapsedCategoryIds.size).toBe(0)
  })

  it('reads persisted collapsed categories on mount', () => {
    localStorageMock.setItem(`${STORAGE_KEY_PREFIX}ws-1`, JSON.stringify(['cat-a', 'cat-b']))
    renderHook(['ws-1'])
    expect(captured.current?.collapsedCategoryIds).toEqual(new Set(['cat-a', 'cat-b']))
  })

  it('toggles a category into collapsed state', () => {
    renderHook(['ws-1'])

    flushSync(() => {
      captured.current?.toggleCategoryCollapsed('cat-a')
    })
    expect(captured.current?.collapsedCategoryIds.has('cat-a')).toBe(true)
  })

  it('toggles a category out of collapsed state', () => {
    localStorageMock.setItem(`${STORAGE_KEY_PREFIX}ws-1`, JSON.stringify(['cat-a']))
    renderHook(['ws-1'])

    flushSync(() => {
      captured.current?.toggleCategoryCollapsed('cat-a')
    })
    expect(captured.current?.collapsedCategoryIds.has('cat-a')).toBe(false)
  })

  it('persists changes to localStorage', () => {
    renderHook(['ws-1'])

    flushSync(() => {
      captured.current?.toggleCategoryCollapsed('cat-x')
    })

    const stored = JSON.parse(localStorageMock.getItem(`${STORAGE_KEY_PREFIX}ws-1`) ?? '[]') as string[]
    expect(stored).toContain('cat-x')
  })
})

describe('useCollabSidebarPrefs — multi-workspace', () => {
  it('merges collapsed categories from multiple workspace keys', () => {
    localStorageMock.setItem(`${STORAGE_KEY_PREFIX}ws-1`, JSON.stringify(['cat-a']))
    localStorageMock.setItem(`${STORAGE_KEY_PREFIX}ws-2`, JSON.stringify(['cat-b']))

    renderHook(['ws-1', 'ws-2'])
    expect(captured.current?.collapsedCategoryIds).toEqual(new Set(['cat-a', 'cat-b']))
  })

  it('persists to all workspace keys on toggle', () => {
    renderHook(['ws-1', 'ws-2'])

    flushSync(() => {
      captured.current?.toggleCategoryCollapsed('cat-new')
    })

    const stored1 = JSON.parse(localStorageMock.getItem(`${STORAGE_KEY_PREFIX}ws-1`) ?? '[]') as string[]
    const stored2 = JSON.parse(localStorageMock.getItem(`${STORAGE_KEY_PREFIX}ws-2`) ?? '[]') as string[]
    expect(stored1).toContain('cat-new')
    expect(stored2).toContain('cat-new')
  })

  it('re-reads when workspace IDs change', () => {
    localStorageMock.setItem(`${STORAGE_KEY_PREFIX}ws-1`, JSON.stringify(['cat-a']))
    localStorageMock.setItem(`${STORAGE_KEY_PREFIX}ws-3`, JSON.stringify(['cat-c']))

    renderHook(['ws-1'])
    expect(captured.current?.collapsedCategoryIds).toEqual(new Set(['cat-a']))

    // Switch to include ws-3
    rerenderHook(['ws-1', 'ws-3'])
    expect(captured.current?.collapsedCategoryIds).toEqual(new Set(['cat-a', 'cat-c']))
  })

  it('handles empty workspace ID array', () => {
    renderHook([])
    expect(captured.current?.collapsedCategoryIds.size).toBe(0)
  })

  it('handles malformed localStorage gracefully', () => {
    localStorageMock.setItem(`${STORAGE_KEY_PREFIX}ws-1`, 'not-json')
    localStorageMock.setItem(`${STORAGE_KEY_PREFIX}ws-2`, JSON.stringify(['cat-ok']))

    renderHook(['ws-1', 'ws-2'])
    expect(captured.current?.collapsedCategoryIds).toEqual(new Set(['cat-ok']))
  })

  it('filters non-string values from persisted data', () => {
    localStorageMock.setItem(`${STORAGE_KEY_PREFIX}ws-1`, JSON.stringify(['cat-a', 42, null, 'cat-b']))
    renderHook(['ws-1'])
    expect(captured.current?.collapsedCategoryIds).toEqual(new Set(['cat-a', 'cat-b']))
  })
})
