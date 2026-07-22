import { useCallback, useEffect, useRef, useState } from 'react'
import type { DashboardTab as CortexDashboardTab } from '@/components/chat/cortex/CortexDashboardPanel'
import type {
  DiffViewerInitialState,
  DiffViewerNavigationRequest,
} from '@/components/diff-viewer/DiffViewerDialog'
import { useFileBrowserWorkspaceState } from '@/components/file-browser/use-file-browser-workspace-state'
import { invalidateFileBrowserCaches } from '@/components/file-browser/use-file-browser-queries'
import type { ArtifactReference } from '@/lib/artifacts'

export type ArtifactsPanelTab = 'artifacts' | 'schedules'

function shouldIgnoreKeyboardShortcutTarget(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    return false
  }

  if (target.closest('.cm-editor') || target.closest('.cm-content')) {
    return true
  }

  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

export interface FileBrowserWorktreeSelection {
  worktreeId: string
  worktreePath: string
  branch: string | null
  repoRoot: string
}

interface UsePanelStateOptions {
  activeAgentId: string | null
  activeAgentArchetypeId?: string | null
  /** Distinguishes agent/session contexts that may reuse the same agent id across origins or projects. */
  activeContextKey?: string
  enableKeyboardShortcuts?: boolean
}

export function usePanelState({
  activeAgentId,
  activeAgentArchetypeId,
  activeContextKey = `${activeAgentId ?? 'none'}:${activeAgentArchetypeId ?? 'default'}`,
  enableKeyboardShortcuts = true,
}: UsePanelStateOptions) {
  const [activeArtifact, setActiveArtifact] = useState<ArtifactReference | null>(null)
  const [isArtifactsPanelOpen, setIsArtifactsPanelOpen] = useState(false)
  const [artifactsPanelTab, setArtifactsPanelTab] = useState<ArtifactsPanelTab>('artifacts')
  const [cortexDashboardTab, setCortexDashboardTab] = useState<CortexDashboardTab>('index')
  const [cortexDashboardTabRequest, setCortexDashboardTabRequest] = useState<{
    tab: CortexDashboardTab
    nonce: number
  } | null>(null)
  const [pendingCortexDashboardOpen, setPendingCortexDashboardOpen] = useState(false)
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isDiffViewerOpen, setIsDiffViewerOpen] = useState(false)
  const [diffViewerInitialState, setDiffViewerInitialState] =
    useState<DiffViewerInitialState | null>(null)
  const [diffViewerNavigationRequest, setDiffViewerNavigationRequest] =
    useState<DiffViewerNavigationRequest | null>(null)
  const diffViewerInitialStateContextRef = useRef(activeContextKey)
  const diffViewerNavigationContextRef = useRef(activeContextKey)
  const diffViewerNavigationRequestIdRef = useRef(0)
  const scopedDiffViewerInitialState =
    diffViewerInitialStateContextRef.current === activeContextKey ? diffViewerInitialState : null
  const scopedDiffViewerNavigationRequest =
    diffViewerNavigationContextRef.current === activeContextKey ? diffViewerNavigationRequest : null
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false)
  const [isBrowserOpen, setIsBrowserOpen] = useState(false)
  const [fileBrowserWorktreeContext, setFileBrowserWorktreeContext] =
    useState<FileBrowserWorktreeSelection | null>(null)
  const fileBrowserWorkspace = useFileBrowserWorkspaceState({
    activeAgentId,
    worktreeContext: fileBrowserWorktreeContext,
  })
  const selectedFileBrowserFile = fileBrowserWorkspace.activeFilePath

  useEffect(() => {
    setActiveArtifact(null)
    setIsArtifactsPanelOpen(false)
    setArtifactsPanelTab('artifacts')
    setCortexDashboardTab('index')
    setIsFileBrowserOpen(false)
    setIsBrowserOpen(false)
    setIsMobileSidebarOpen(false)
  }, [activeAgentId])

  useEffect(() => {
    if (diffViewerInitialStateContextRef.current !== activeContextKey) {
      diffViewerInitialStateContextRef.current = activeContextKey
      setDiffViewerInitialState(null)
    }
    if (diffViewerNavigationContextRef.current !== activeContextKey) {
      diffViewerNavigationContextRef.current = activeContextKey
      setDiffViewerNavigationRequest(null)
    }
  }, [activeContextKey])

  const closeFileBrowserForWorkspacePanel = useCallback(() => {
    setIsFileBrowserOpen(false)
  }, [])

  const closeWorkspacePanels = useCallback(() => {
    setIsArtifactsPanelOpen(false)
    closeFileBrowserForWorkspacePanel()
    setIsBrowserOpen(false)
  }, [closeFileBrowserForWorkspacePanel])

  useEffect(() => {
    if (!pendingCortexDashboardOpen || activeAgentArchetypeId !== 'cortex') {
      return
    }

    closeFileBrowserForWorkspacePanel()
    setIsArtifactsPanelOpen(true)
    setPendingCortexDashboardOpen(false)
  }, [activeAgentArchetypeId, closeFileBrowserForWorkspacePanel, pendingCortexDashboardOpen])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnoreKeyboardShortcutTarget(e)) {
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        setIsDiffViewerOpen((previous) => !previous)
      }
    }

    if (!enableKeyboardShortcuts) {
      return undefined
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enableKeyboardShortcuts])

  const openArtifactsPanel = useCallback(
    (tab: ArtifactsPanelTab = 'artifacts') => {
      closeFileBrowserForWorkspacePanel()
      setIsBrowserOpen(false)
      setArtifactsPanelTab(tab)
      setIsArtifactsPanelOpen(true)
    },
    [closeFileBrowserForWorkspacePanel],
  )

  const toggleArtifactsPanel = useCallback(
    (tab?: ArtifactsPanelTab) => {
      if (isArtifactsPanelOpen) {
        if (tab === undefined || artifactsPanelTab === tab) {
          setIsArtifactsPanelOpen(false)
          return
        }
      }
      openArtifactsPanel(tab ?? 'artifacts')
    },
    [artifactsPanelTab, isArtifactsPanelOpen, openArtifactsPanel],
  )

  const openFileBrowser = useCallback(() => {
    setIsArtifactsPanelOpen(false)
    setIsBrowserOpen(false)
    setFileBrowserWorktreeContext(null)
    setIsFileBrowserOpen(true)
  }, [])

  const toggleFileBrowser = useCallback(() => {
    setIsFileBrowserOpen((previous) => {
      if (!previous) {
        setIsArtifactsPanelOpen(false)
        setIsBrowserOpen(false)
        setFileBrowserWorktreeContext(null)
      }
      return !previous
    })
  }, [])

  const browseWorktreeFiles = useCallback((context: FileBrowserWorktreeSelection) => {
    setFileBrowserWorktreeContext(context)
    setIsArtifactsPanelOpen(false)
    setIsBrowserOpen(false)
    setIsFileBrowserOpen(true)
  }, [])

  const openBrowser = useCallback(() => {
    setIsArtifactsPanelOpen(false)
    closeFileBrowserForWorkspacePanel()
    setIsBrowserOpen(true)
  }, [closeFileBrowserForWorkspacePanel])

  const toggleBrowser = useCallback(() => {
    setIsBrowserOpen((previous) => {
      if (!previous) {
        setIsArtifactsPanelOpen(false)
        closeFileBrowserForWorkspacePanel()
      }
      return !previous
    })
  }, [closeFileBrowserForWorkspacePanel])

  const clearFileBrowserWorktreeContext = useCallback(() => {
    setFileBrowserWorktreeContext(null)
    invalidateFileBrowserCaches()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnoreKeyboardShortcutTarget(e)) {
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        e.preventDefault()
        toggleFileBrowser()
      }
    }

    if (!enableKeyboardShortcuts) {
      return undefined
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enableKeyboardShortcuts, toggleFileBrowser])

  const requestCortexDashboardTab = useCallback(
    (tab: CortexDashboardTab) => {
      closeFileBrowserForWorkspacePanel()
      setPendingCortexDashboardOpen(true)
      setCortexDashboardTab(tab)
      setCortexDashboardTabRequest({ tab, nonce: Date.now() })
    },
    [closeFileBrowserForWorkspacePanel],
  )

  const handleCortexDashboardTabChange = useCallback((tab: CortexDashboardTab) => {
    setCortexDashboardTab(tab)
  }, [])

  const toggleCortexDashboardTab = useCallback(
    (tab: CortexDashboardTab) => {
      if (isArtifactsPanelOpen && cortexDashboardTab === tab) {
        setIsArtifactsPanelOpen(false)
        return
      }
      requestCortexDashboardTab(tab)
    },
    [cortexDashboardTab, isArtifactsPanelOpen, requestCortexDashboardTab],
  )

  const openDiffViewer = useCallback((initialState: DiffViewerInitialState | null = null) => {
    diffViewerInitialStateContextRef.current = activeContextKey
    diffViewerNavigationContextRef.current = activeContextKey
    setDiffViewerInitialState(initialState)
    setDiffViewerNavigationRequest(null)
    setIsDiffViewerOpen(true)
  }, [activeContextKey])

  const openDiffViewerDeepLink = useCallback((initialState: DiffViewerInitialState) => {
    const requestId = diffViewerNavigationRequestIdRef.current + 1
    diffViewerNavigationRequestIdRef.current = requestId
    diffViewerInitialStateContextRef.current = activeContextKey
    diffViewerNavigationContextRef.current = activeContextKey
    setDiffViewerInitialState(initialState)
    setDiffViewerNavigationRequest({ requestId, ...initialState })
    setIsDiffViewerOpen(true)
  }, [activeContextKey])

  const selectFileBrowserFile = useCallback((path: string) => {
    fileBrowserWorkspace.openPreviewFile(path)
  }, [fileBrowserWorkspace])

  const openStickyFileBrowserFile = useCallback((path: string) => {
    fileBrowserWorkspace.openStickyFile(path)
  }, [fileBrowserWorkspace])

  const closeFileBrowserPanel = useCallback(() => {
    fileBrowserWorkspace.closeActiveTab()
  }, [fileBrowserWorkspace])

  const navigateFileBrowserToDirectory = useCallback((_dirPath: string) => {
    fileBrowserWorkspace.closeActiveTab()
  }, [fileBrowserWorkspace])

  const openArtifact = useCallback((artifact: ArtifactReference) => {
    setActiveArtifact(artifact)
  }, [])

  const closeArtifact = useCallback(() => {
    setActiveArtifact(null)
  }, [])

  return {
    activeArtifact,
    openArtifact,
    closeArtifact,
    isArtifactsPanelOpen,
    setIsArtifactsPanelOpen,
    artifactsPanelTab,
    setArtifactsPanelTab,
    openArtifactsPanel,
    toggleArtifactsPanel,
    closeWorkspacePanels,
    cortexDashboardTab,
    cortexDashboardTabRequest,
    requestCortexDashboardTab,
    toggleCortexDashboardTab,
    handleCortexDashboardTabChange,
    isMobileSidebarOpen,
    setIsMobileSidebarOpen,
    isDiffViewerOpen,
    setIsDiffViewerOpen,
    diffViewerInitialState: scopedDiffViewerInitialState,
    diffViewerNavigationRequest: scopedDiffViewerNavigationRequest,
    openDiffViewer,
    openDiffViewerDeepLink,
    isFileBrowserOpen,
    isBrowserOpen,
    openBrowser,
    toggleBrowser,
    openFileBrowser,
    toggleFileBrowser,
    selectedFileBrowserFile,
    selectFileBrowserFile,
    openStickyFileBrowserFile,
    fileBrowserTabs: fileBrowserWorkspace.tabs,
    allFileBrowserTabs: fileBrowserWorkspace.allTabs,
    activeFileBrowserTabId: fileBrowserWorkspace.activeTabId,
    previewFileBrowserTabId: fileBrowserWorkspace.previewTabId,
    activateFileBrowserTab: fileBrowserWorkspace.activateTab,
    stickifyFileBrowserTab: fileBrowserWorkspace.stickifyTab,
    closeFileBrowserTab: fileBrowserWorkspace.closeTab,
    fileBrowserTreeSnapshot: fileBrowserWorkspace.treeSnapshot,
    activeFileBrowserContentScrollSnapshot: fileBrowserWorkspace.activeContentScrollSnapshot,
    updateFileBrowserTreeSnapshot: fileBrowserWorkspace.updateTreeSnapshot,
    updateActiveFileBrowserContentScrollSnapshot: fileBrowserWorkspace.updateActiveContentScrollSnapshot,
    removeFileBrowserTabsAffectedByDelete: fileBrowserWorkspace.removeTabsAffectedByDelete,
    renameFileBrowserTabsAffectedByRename: fileBrowserWorkspace.renameTabsAffectedByRename,
    closeFileBrowserPanel,
    navigateFileBrowserToDirectory,
    fileBrowserWorktreeContext,
    browseWorktreeFiles,
    clearFileBrowserWorktreeContext,
  }
}
