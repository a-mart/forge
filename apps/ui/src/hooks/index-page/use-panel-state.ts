import { useCallback, useEffect, useState } from 'react'
import type { DashboardTab as CortexDashboardTab } from '@/components/chat/cortex/CortexDashboardPanel'
import type { DiffViewerInitialState } from '@/components/diff-viewer/DiffViewerDialog'
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
  enableKeyboardShortcuts?: boolean
}

export function usePanelState({
  activeAgentId,
  activeAgentArchetypeId,
  enableKeyboardShortcuts = true,
}: UsePanelStateOptions) {
  const [activeArtifact, setActiveArtifact] = useState<ArtifactReference | null>(null)
  const [isArtifactsPanelOpen, setIsArtifactsPanelOpen] = useState(false)
  const [artifactsPanelTab, setArtifactsPanelTab] = useState<ArtifactsPanelTab>('artifacts')
  const [cortexDashboardTab, setCortexDashboardTab] = useState<CortexDashboardTab>('knowledge')
  const [cortexDashboardTabRequest, setCortexDashboardTabRequest] = useState<{
    tab: CortexDashboardTab
    nonce: number
  } | null>(null)
  const [pendingCortexDashboardOpen, setPendingCortexDashboardOpen] = useState(false)
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isDiffViewerOpen, setIsDiffViewerOpen] = useState(false)
  const [diffViewerInitialState, setDiffViewerInitialState] =
    useState<DiffViewerInitialState | null>(null)
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false)
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
    setCortexDashboardTab('knowledge')
    setIsFileBrowserOpen(false)
    setIsMobileSidebarOpen(false)
  }, [activeAgentId])

  const closeFileBrowserForWorkspacePanel = useCallback(() => {
    setIsFileBrowserOpen(false)
  }, [])

  const closeWorkspacePanels = useCallback(() => {
    setIsArtifactsPanelOpen(false)
    closeFileBrowserForWorkspacePanel()
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
    setFileBrowserWorktreeContext(null)
    setIsFileBrowserOpen(true)
  }, [])

  const toggleFileBrowser = useCallback(() => {
    setIsFileBrowserOpen((previous) => {
      if (!previous) {
        setIsArtifactsPanelOpen(false)
        setFileBrowserWorktreeContext(null)
      }
      return !previous
    })
  }, [])

  const browseWorktreeFiles = useCallback((context: FileBrowserWorktreeSelection) => {
    setFileBrowserWorktreeContext(context)
    setIsArtifactsPanelOpen(false)
    setIsFileBrowserOpen(true)
  }, [])

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
    setDiffViewerInitialState(initialState)
    setIsDiffViewerOpen(true)
  }, [])

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
    diffViewerInitialState,
    openDiffViewer,
    isFileBrowserOpen,
    openFileBrowser,
    toggleFileBrowser,
    selectedFileBrowserFile,
    selectFileBrowserFile,
    openStickyFileBrowserFile,
    fileBrowserTabs: fileBrowserWorkspace.tabs,
    activeFileBrowserTabId: fileBrowserWorkspace.activeTabId,
    previewFileBrowserTabId: fileBrowserWorkspace.previewTabId,
    activateFileBrowserTab: fileBrowserWorkspace.activateTab,
    stickifyFileBrowserTab: fileBrowserWorkspace.stickifyTab,
    closeFileBrowserTab: fileBrowserWorkspace.closeTab,
    removeFileBrowserTabsAffectedByDelete: fileBrowserWorkspace.removeTabsAffectedByDelete,
    closeFileBrowserPanel,
    navigateFileBrowserToDirectory,
    fileBrowserWorktreeContext,
    browseWorktreeFiles,
    clearFileBrowserWorktreeContext,
  }
}
