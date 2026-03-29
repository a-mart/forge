import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { BookOpen, ClipboardList, Clock3, StickyNote, X } from 'lucide-react'
import type { CortexDocumentEntry } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { ArtifactReference } from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import { HelpTrigger } from '@/components/help/HelpTrigger'
import type { DiffViewerInitialState } from '@/components/diff-viewer/DiffViewerDialog'
import { SchedulesPanel } from '../SchedulesPanel'
import { CortexDocumentSelector } from './CortexDocumentSelector'
import { KnowledgeFileViewer } from './KnowledgeFileViewer'
import { ReviewStatusPanel } from './ReviewStatusPanel'

interface CortexDashboardPanelProps {
  wsUrl: string
  managerId: string
  isOpen: boolean
  onClose: () => void
  onArtifactClick: (artifact: ArtifactReference) => void
  onOpenSession: (agentId: string) => void
  onOpenDiffViewer?: (initialState: DiffViewerInitialState) => void
  requestedTab?: { tab: DashboardTab; nonce: number } | null
}

interface CortexScanResponse {
  documents?: CortexDocumentEntry[]
}

export type DashboardTab = 'knowledge' | 'notes' | 'review' | 'schedules'

const PANEL_WIDTH_KEY = 'cortex-panel-width'
const DEFAULT_WIDTH = 420
const MIN_WIDTH = 300
const MAX_WIDTH = 700

function loadPersistedWidth(): number {
  try {
    const stored = localStorage.getItem(PANEL_WIDTH_KEY)
    if (stored) {
      const value = Number.parseInt(stored, 10)
      if (Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH) {
        return value
      }
    }
  } catch {
    // Ignore storage errors
  }
  return DEFAULT_WIDTH
}

function persistWidth(width: number): void {
  try {
    localStorage.setItem(PANEL_WIDTH_KEY, String(width))
  } catch {
    // Ignore storage errors
  }
}

function isDashboardTab(value: string): value is DashboardTab {
  return value === 'knowledge' || value === 'notes' || value === 'review' || value === 'schedules'
}

export function CortexDashboardPanel({
  wsUrl,
  managerId,
  isOpen,
  onClose,
  onArtifactClick,
  onOpenSession,
  onOpenDiffViewer,
  requestedTab,
}: CortexDashboardPanelProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>('knowledge')
  const [panelWidth, setPanelWidth] = useState(loadPersistedWidth)
  const [documents, setDocuments] = useState<CortexDocumentEntry[]>([])
  const [pathsLoaded, setPathsLoaded] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedKnowledgeDocumentId, setSelectedKnowledgeDocumentId] = useState<string>('')
  const isDraggingRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const knowledgeDocuments = useMemo(
    () => documents.filter((document) => document.group !== 'notes'),
    [documents],
  )
  const notesDocument = useMemo(
    () => documents.find((document) => document.group === 'notes') ?? null,
    [documents],
  )
  const selectedKnowledgeDocument = useMemo(
    () => knowledgeDocuments.find((document) => document.id === selectedKnowledgeDocumentId) ?? null,
    [knowledgeDocuments, selectedKnowledgeDocumentId],
  )

  useEffect(() => {
    if (requestedTab) {
      setActiveTab(requestedTab.tab)
    }
  }, [requestedTab])

  useEffect(() => {
    if (!knowledgeDocuments.length) {
      if (selectedKnowledgeDocumentId) {
        setSelectedKnowledgeDocumentId('')
      }
      return
    }

    if (knowledgeDocuments.some((document) => document.id === selectedKnowledgeDocumentId)) {
      return
    }

    const fallbackDocument =
      knowledgeDocuments.find((document) => document.group === 'commonKnowledge') ?? knowledgeDocuments[0]
    if (fallbackDocument) {
      setSelectedKnowledgeDocumentId(fallbackDocument.id)
    }
  }, [knowledgeDocuments, selectedKnowledgeDocumentId])

  useEffect(() => {
    if (!isOpen) return

    const abortController = new AbortController()
    const endpoint = resolveApiEndpoint(wsUrl, '/api/cortex/scan')

    void fetch(endpoint, { signal: abortController.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status}`)
        return response.json() as Promise<CortexScanResponse>
      })
      .then((payload) => {
        if (abortController.signal.aborted) return
        setDocuments(Array.isArray(payload.documents) ? payload.documents : [])
        setPathsLoaded(true)
      })
      .catch(() => {
        if (abortController.signal.aborted) return
        setDocuments([])
        setPathsLoaded(true)
      })

    return () => {
      abortController.abort()
    }
  }, [wsUrl, isOpen])

  useEffect(() => {
    if (isOpen) {
      setRefreshKey((prev) => prev + 1)
    }
  }, [isOpen, activeTab])

  const handleSelectDocument = useCallback(
    (documentId: string) => {
      const nextDocument = documents.find((entry) => entry.id === documentId)
      if (!nextDocument) {
        return
      }

      if (nextDocument.group === 'notes') {
        setActiveTab('notes')
        return
      }

      setSelectedKnowledgeDocumentId(nextDocument.id)
      setActiveTab('knowledge')
    },
    [documents],
  )

  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      isDraggingRef.current = true

      const startX = event.clientX
      const startWidth = panelWidth

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDraggingRef.current) return
        const diff = startX - moveEvent.clientX
        const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + diff))
        setPanelWidth(newWidth)
      }

      const handleMouseUp = () => {
        isDraggingRef.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        const panel = panelRef.current
        if (panel) {
          const computedWidth = panel.getBoundingClientRect().width
          persistWidth(Math.round(computedWidth))
        }
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [panelWidth],
  )

  return (
    <div
      ref={panelRef}
      className={cn(
        'relative flex h-full shrink-0 flex-col border-l border-border/80 bg-card/50',
        'transition-[width,opacity] duration-200 ease-out',
        isOpen
          ? 'max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-l-0 md:w-[var(--cortex-panel-width)] md:opacity-100'
          : 'w-0 opacity-0 overflow-hidden max-md:hidden',
        isOpen && 'opacity-100',
      )}
      style={isOpen ? ({ '--cortex-panel-width': `${panelWidth}px` } as CSSProperties) : undefined}
      aria-label="Cortex Dashboard"
      aria-hidden={!isOpen}
    >
      <div
        className="absolute left-0 top-0 z-10 hidden h-full w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 md:block"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
      />

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (isDashboardTab(value)) {
            setActiveTab(value)
          }
        }}
        className="flex h-full flex-col gap-0"
      >
        <div className="flex h-[62px] shrink-0 items-center gap-2 px-3">
          <TabsList className="h-7 w-full bg-muted/60 p-0.5">
            <TabsTrigger value="knowledge" className="h-6 gap-1 rounded-sm px-2 text-[11px] font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              <BookOpen className="size-3" />
              Knowledge
            </TabsTrigger>
            <TabsTrigger value="notes" className="h-6 gap-1 rounded-sm px-2 text-[11px] font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              <StickyNote className="size-3" />
              Notes
            </TabsTrigger>
            <TabsTrigger value="review" className="h-6 gap-1 rounded-sm px-2 text-[11px] font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              <ClipboardList className="size-3" />
              Review
            </TabsTrigger>
            <TabsTrigger value="schedules" className="h-6 gap-1 rounded-sm px-2 text-[11px] font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              <Clock3 className="size-3" />
              Cron
            </TabsTrigger>
          </TabsList>

          <HelpTrigger contextKey="cortex.dashboard" size="sm" className="h-7 w-7" />

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
            onClick={onClose}
            aria-label="Close dashboard panel"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <TabsContent value="knowledge" className="mt-0 min-h-0 flex-1">
          {pathsLoaded ? (
            <div className="flex h-full flex-col">
              <div className="shrink-0 border-b border-border/60 px-3 py-2">
                <CortexDocumentSelector
                  documents={knowledgeDocuments}
                  value={selectedKnowledgeDocument?.id ?? ''}
                  onValueChange={setSelectedKnowledgeDocumentId}
                />
              </div>
              <div className="min-h-0 flex-1">
                <KnowledgeFileViewer
                  key={`knowledge-${selectedKnowledgeDocument?.id ?? 'none'}-${refreshKey}`}
                  wsUrl={wsUrl}
                  documents={documents}
                  agentId={managerId}
                  document={selectedKnowledgeDocument}
                  onArtifactClick={onArtifactClick}
                  onOpenSession={onOpenSession}
                  onSelectDocument={handleSelectDocument}
                  onOpenDiffViewer={onOpenDiffViewer}
                />
              </div>
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="notes" className="mt-0 min-h-0 flex-1">
          {pathsLoaded ? (
            <KnowledgeFileViewer
              key={`notes-${notesDocument?.id ?? 'none'}-${refreshKey}`}
              wsUrl={wsUrl}
              documents={documents}
              agentId={managerId}
              document={notesDocument}
              onArtifactClick={onArtifactClick}
              onOpenSession={onOpenSession}
              onSelectDocument={handleSelectDocument}
              onOpenDiffViewer={onOpenDiffViewer}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="review" className="mt-0 min-h-0 flex-1">
          <ReviewStatusPanel key={`review-${refreshKey}`} wsUrl={wsUrl} onOpenSession={onOpenSession} />
        </TabsContent>

        <TabsContent value="schedules" className="mt-0 min-h-0 flex-1">
          <SchedulesPanel
            key={`schedules-${refreshKey}`}
            wsUrl={wsUrl}
            managerId={managerId}
            isActive={isOpen && activeTab === 'schedules'}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
