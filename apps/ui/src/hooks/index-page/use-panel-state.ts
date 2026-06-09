import { useCallback, useEffect, useState } from 'react'
import type { DashboardTab as CortexDashboardTab } from '@/components/chat/cortex/CortexDashboardPanel'
import type { DiffViewerInitialState } from '@/components/diff-viewer/DiffViewerDialog'
import type { ArtifactReference } from '@/lib/artifacts'

export type ArtifactsPanelTab = 'artifacts' | 'schedules'

function shouldIgnoreKeyboardShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

interface UsePanelStateOptions {
  activeAgentId: string | null
  activeAgentArchetypeId?: string | null
}

export function usePanelState({
  activeAgentId,
  activeAgentArchetypeId,
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
  const [selectedFileBrowserFile, setSelectedFileBrowserFile] = useState<string | null>(null)

  useEffect(() => {
    setActiveArtifact(null)
    setIsArtifactsPanelOpen(false)
    setArtifactsPanelTab('artifacts')
    setCortexDashboardTab('knowledge')
    setIsFileBrowserOpen(false)
    setSelectedFileBrowserFile(null)
    setIsMobileSidebarOpen(false)
  }, [activeAgentId])

  const closeFileBrowserForWorkspacePanel = useCallback(() => {
    setIsFileBrowserOpen(false)
    setSelectedFileBrowserFile(null)
  }, [])

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
      if (shouldIgnoreKeyboardShortcutTarget(e.target)) {
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        setIsDiffViewerOpen((previous) => !previous)
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

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

  const toggleFileBrowser = useCallback(() => {
    setIsFileBrowserOpen((previous) => {
      if (!previous) {
        setIsArtifactsPanelOpen(false)
      } else {
        setSelectedFileBrowserFile(null)
      }
      return !previous
    })
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnoreKeyboardShortcutTarget(e.target)) {
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        e.preventDefault()
        toggleFileBrowser()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleFileBrowser])

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
    setSelectedFileBrowserFile(path)
  }, [])

  const closeFileBrowserPanel = useCallback(() => {
    setSelectedFileBrowserFile(null)
  }, [])

  const navigateFileBrowserToDirectory = useCallback((_dirPath: string) => {
    setSelectedFileBrowserFile(null)
  }, [])

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
    toggleFileBrowser,
    selectedFileBrowserFile,
    selectFileBrowserFile,
    closeFileBrowserPanel,
    navigateFileBrowserToDirectory,
  }
}
