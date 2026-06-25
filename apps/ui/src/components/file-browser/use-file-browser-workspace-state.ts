import { useCallback, useMemo, useState } from 'react'
import type { FileBrowserWorktreeSelection } from '@/hooks/index-page/use-panel-state'
import type { FileEditorSessionKey } from './use-file-editor-coordinator'

export interface FileBrowserScopeKey {
  agentId: string
  worktreeId: string | null
}

export interface FileBrowserTab {
  id: string
  key: FileEditorSessionKey
  filePath: string
  sticky: boolean
  lastActivatedAt: number
}

export interface FileBrowserTreeStateSnapshot {
  filterText: string
  searchMode: boolean
  searchQuery: string
  treeScrollTop: number
  searchScrollTop: number
  treeState: Record<string, unknown> | null
}

export interface FileContentScrollSnapshot {
  kind: 'code' | 'editor' | 'markdown'
  scrollTop: number
  scrollLeft?: number
}

interface FileBrowserScopeState {
  activeTabId: string | null
  previewTabId: string | null
  tabs: FileBrowserTab[]
  treeSnapshot: FileBrowserTreeStateSnapshot | null
  contentScrollByTabId: Record<string, FileContentScrollSnapshot>
}

function scopeId(scope: FileBrowserScopeKey): string {
  return `${scope.agentId}\u0000${scope.worktreeId ?? ''}`
}

export function fileBrowserTabId(key: FileEditorSessionKey): string {
  return `${key.agentId}\u0000${key.worktreeId ?? ''}\u0000${key.filePath}`
}

function createTab(scope: FileBrowserScopeKey, filePath: string, sticky: boolean): FileBrowserTab {
  const key = { agentId: scope.agentId, worktreeId: scope.worktreeId, filePath }
  return {
    id: fileBrowserTabId(key),
    key,
    filePath,
    sticky,
    lastActivatedAt: Date.now(),
  }
}

function emptyScopeState(): FileBrowserScopeState {
  return { activeTabId: null, previewTabId: null, tabs: [], treeSnapshot: null, contentScrollByTabId: {} }
}

function doesDeleteAffectFile(deletePath: string, entryType: 'file' | 'directory', filePath: string): boolean {
  const normalizedDeletePath = deletePath.replace(/^\/+|\/+$/g, '')
  const normalizedFilePath = filePath.replace(/^\/+|\/+$/g, '')
  if (!normalizedDeletePath) return false
  if (entryType === 'file') return normalizedFilePath === normalizedDeletePath
  return normalizedFilePath === normalizedDeletePath || normalizedFilePath.startsWith(`${normalizedDeletePath}/`)
}

export function useFileBrowserWorkspaceState({
  activeAgentId,
  worktreeContext,
}: {
  activeAgentId: string | null
  worktreeContext: FileBrowserWorktreeSelection | null
}) {
  const [scopes, setScopes] = useState<Record<string, FileBrowserScopeState>>({})
  const activeScope = useMemo<FileBrowserScopeKey | null>(() => {
    if (!activeAgentId) return null
    return { agentId: activeAgentId, worktreeId: worktreeContext?.worktreeId ?? null }
  }, [activeAgentId, worktreeContext?.worktreeId])
  const activeScopeId = activeScope ? scopeId(activeScope) : null
  const activeState = activeScopeId ? (scopes[activeScopeId] ?? emptyScopeState()) : emptyScopeState()
  const activeTab = activeState.tabs.find((tab) => tab.id === activeState.activeTabId) ?? null

  const updateActiveScope = useCallback((updater: (previous: FileBrowserScopeState, scope: FileBrowserScopeKey) => FileBrowserScopeState) => {
    if (!activeScope) return
    setScopes((previousScopes) => {
      const id = scopeId(activeScope)
      return {
        ...previousScopes,
        [id]: updater(previousScopes[id] ?? emptyScopeState(), activeScope),
      }
    })
  }, [activeScope])

  const openPreviewFile = useCallback((filePath: string) => {
    updateActiveScope((previous, scope) => {
      const existing = previous.tabs.find((tab) => tab.filePath === filePath)
      if (existing) {
        return {
          ...previous,
          activeTabId: existing.id,
          tabs: previous.tabs.map((tab) => tab.id === existing.id ? { ...tab, lastActivatedAt: Date.now() } : tab),
        }
      }

      const nextTab = createTab(scope, filePath, false)
      const replaceId = previous.previewTabId
      const canReplace = replaceId && previous.tabs.some((tab) => tab.id === replaceId && !tab.sticky)
      const tabs = canReplace
        ? previous.tabs.map((tab) => tab.id === replaceId ? nextTab : tab)
        : [...previous.tabs, nextTab]
      return { ...previous, tabs, activeTabId: nextTab.id, previewTabId: nextTab.id }
    })
  }, [updateActiveScope])

  const openStickyFile = useCallback((filePath: string) => {
    updateActiveScope((previous, scope) => {
      const existing = previous.tabs.find((tab) => tab.filePath === filePath)
      if (existing) {
        return {
          ...previous,
          activeTabId: existing.id,
          previewTabId: previous.previewTabId === existing.id ? null : previous.previewTabId,
          tabs: previous.tabs.map((tab) => tab.id === existing.id ? { ...tab, sticky: true, lastActivatedAt: Date.now() } : tab),
        }
      }
      const nextTab = createTab(scope, filePath, true)
      return { ...previous, tabs: [...previous.tabs, nextTab], activeTabId: nextTab.id }
    })
  }, [updateActiveScope])

  const activateTab = useCallback((tabId: string) => {
    updateActiveScope((previous) => ({
      ...previous,
      activeTabId: previous.tabs.some((tab) => tab.id === tabId) ? tabId : previous.activeTabId,
      tabs: previous.tabs.map((tab) => tab.id === tabId ? { ...tab, lastActivatedAt: Date.now() } : tab),
    }))
  }, [updateActiveScope])

  const stickifyTab = useCallback((tabId: string) => {
    updateActiveScope((previous) => ({
      ...previous,
      previewTabId: previous.previewTabId === tabId ? null : previous.previewTabId,
      tabs: previous.tabs.map((tab) => tab.id === tabId ? { ...tab, sticky: true } : tab),
    }))
  }, [updateActiveScope])

  const closeTab = useCallback((tabId: string) => {
    updateActiveScope((previous) => {
      const index = previous.tabs.findIndex((tab) => tab.id === tabId)
      if (index < 0) return previous
      const tabs = previous.tabs.filter((tab) => tab.id !== tabId)
      const nextActiveTab = previous.activeTabId === tabId
        ? (tabs[index] ?? tabs[index - 1] ?? null)
        : (tabs.find((tab) => tab.id === previous.activeTabId) ?? null)
      return {
        ...previous,
        tabs,
        activeTabId: nextActiveTab?.id ?? null,
        previewTabId: previous.previewTabId === tabId ? null : previous.previewTabId,
        contentScrollByTabId: Object.fromEntries(
          Object.entries(previous.contentScrollByTabId).filter(([id]) => id !== tabId),
        ),
      }
    })
  }, [updateActiveScope])

  const closeActiveTab = useCallback(() => {
    if (activeState.activeTabId) closeTab(activeState.activeTabId)
  }, [activeState.activeTabId, closeTab])

  const removeTabsAffectedByDelete = useCallback((path: string, entryType: 'file' | 'directory') => {
    updateActiveScope((previous) => {
      const tabs = previous.tabs.filter((tab) => !doesDeleteAffectFile(path, entryType, tab.filePath))
      const activeTabId = tabs.some((tab) => tab.id === previous.activeTabId)
        ? previous.activeTabId
        : (tabs[0]?.id ?? null)
      return {
        ...previous,
        tabs,
        activeTabId,
        previewTabId: tabs.some((tab) => tab.id === previous.previewTabId) ? previous.previewTabId : null,
        contentScrollByTabId: Object.fromEntries(
          Object.entries(previous.contentScrollByTabId).filter(([id]) => tabs.some((tab) => tab.id === id)),
        ),
      }
    })
  }, [updateActiveScope])

  const updateTreeSnapshot = useCallback((snapshot: FileBrowserTreeStateSnapshot) => {
    updateActiveScope((previous) => {
      if (JSON.stringify(previous.treeSnapshot) === JSON.stringify(snapshot)) return previous
      return { ...previous, treeSnapshot: snapshot }
    })
  }, [updateActiveScope])

  const updateActiveContentScrollSnapshot = useCallback((snapshot: FileContentScrollSnapshot) => {
    updateActiveScope((previous) => {
      if (!previous.activeTabId) return previous
      const current = previous.contentScrollByTabId[previous.activeTabId]
      if (JSON.stringify(current) === JSON.stringify(snapshot)) return previous
      return {
        ...previous,
        contentScrollByTabId: {
          ...previous.contentScrollByTabId,
          [previous.activeTabId]: snapshot,
        },
      }
    })
  }, [updateActiveScope])

  return {
    activeScope,
    tabs: activeState.tabs,
    activeTabId: activeState.activeTabId,
    previewTabId: activeState.previewTabId,
    activeTab,
    activeFilePath: activeTab?.filePath ?? null,
    treeSnapshot: activeState.treeSnapshot,
    activeContentScrollSnapshot: activeState.activeTabId ? (activeState.contentScrollByTabId[activeState.activeTabId] ?? null) : null,
    updateTreeSnapshot,
    updateActiveContentScrollSnapshot,
    openPreviewFile,
    openStickyFile,
    activateTab,
    stickifyTab,
    closeTab,
    closeActiveTab,
    removeTabsAffectedByDelete,
  }
}
