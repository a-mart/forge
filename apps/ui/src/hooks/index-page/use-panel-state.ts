import { useCallback, useEffect, useState } from 'react'
import type { DashboardTab as CortexDashboardTab } from '@/components/chat/cortex/CortexDashboardPanel'
import type { DiffViewerInitialState } from '@/components/diff-viewer/DiffViewerDialog'
import type { ArtifactReference } from '@/lib/artifacts'

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
    setIsFileBrowserOpen(false)
    setSelectedFileBrowserFile(null)
    setIsMobileSidebarOpen(false)
  }, [activeAgentId])

  useEffect(() => {
    if (!pendingCortexDashboardOpen || activeAgentArchetypeId !== 'cortex') {
      return
    }

    setIsArtifactsPanelOpen(true)
    setPendingCortexDashboardOpen(false)
  }, [activeAgentArchetypeId, pendingCortexDashboardOpen])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        setIsDiffViewerOpen((previous) => !previous)
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const toggleArtifactsPanel = useCallback(() => {
    setIsArtifactsPanelOpen((previous) => {
      if (!previous) {
        setIsFileBrowserOpen(false)
        setSelectedFileBrowserFile(null)
      }
      return !previous
    })
  }, [])

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
      const target = e.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
      ) {
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

  const requestCortexDashboardTab = useCallback((tab: CortexDashboardTab) => {
    setPendingCortexDashboardOpen(true)
    setCortexDashboardTabRequest({ tab, nonce: Date.now() })
  }, [])

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
    toggleArtifactsPanel,
    cortexDashboardTabRequest,
    requestCortexDashboardTab,
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
