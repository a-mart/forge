import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, ClipboardList, Clock3, StickyNote, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { ArtifactReference } from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import { SchedulesPanel } from '../SchedulesPanel'
import { KnowledgeFileViewer } from './KnowledgeFileViewer'
import { ReviewStatusPanel } from './ReviewStatusPanel'

interface CortexDashboardPanelProps {
  wsUrl: string
  managerId: string
  isOpen: boolean
  onClose: () => void
  onArtifactClick: (artifact: ArtifactReference) => void
  onSendMessage: (text: string) => void
}

type DashboardTab = 'knowledge' | 'notes' | 'review' | 'schedules'

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

interface ProfileKnowledgeEntry {
  path: string
  exists: boolean
  sizeBytes: number
}

interface CortexPaths {
  commonKnowledge: string | null
  cortexNotes: string | null
  profileKnowledge: Record<string, ProfileKnowledgeEntry>
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
  onSendMessage,
}: CortexDashboardPanelProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>('knowledge')
  const [panelWidth, setPanelWidth] = useState(loadPersistedWidth)
  const [paths, setPaths] = useState<CortexPaths>({ 
    commonKnowledge: null, 
    cortexNotes: null,
    profileKnowledge: {}
  })
  const [pathsLoaded, setPathsLoaded] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedKnowledgeScope, setSelectedKnowledgeScope] = useState<string>('common')
  const isDraggingRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // Fetch file paths from scan endpoint on mount
  useEffect(() => {
    if (!isOpen) return

    const abortController = new AbortController()
    const endpoint = resolveApiEndpoint(wsUrl, '/api/cortex/scan')

    void fetch(endpoint, { signal: abortController.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status}`)
        return response.json()
      })
      .then((data: unknown) => {
        if (abortController.signal.aborted) return
        const payload = data as {
          files?: {
            commonKnowledge?: string
            cortexNotes?: string
            profileKnowledge?: Record<string, ProfileKnowledgeEntry>
          }
          paths?: { commonKnowledge?: string; cortexNotes?: string }
          profileKnowledge?: Record<string, ProfileKnowledgeEntry>
        }
        const files = payload.files ?? payload.paths
        const profileKnowledge = payload.files?.profileKnowledge ?? payload.profileKnowledge ?? {}
        setPaths({
          commonKnowledge: typeof files?.commonKnowledge === 'string' ? files.commonKnowledge : null,
          cortexNotes: typeof files?.cortexNotes === 'string' ? files.cortexNotes : null,
          profileKnowledge,
        })
        setPathsLoaded(true)
      })
      .catch(() => {
        if (abortController.signal.aborted) return
        // Endpoint not available yet — fall through with null paths
        setPathsLoaded(true)
      })

    return () => {
      abortController.abort()
    }
  }, [wsUrl, isOpen])

  // Trigger refresh when panel opens or tab changes
  useEffect(() => {
    if (isOpen) {
      setRefreshKey((prev) => prev + 1)
    }
  }, [isOpen, activeTab])

  // Resizable drag handle logic
  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      isDraggingRef.current = true

      const startX = event.clientX
      const startWidth = panelWidth

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDraggingRef.current) return
        // Panel is on the right side, so dragging left increases width
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
        // Persist final width
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

  const handleTriggerReview = useCallback(
    (message: string) => {
      onSendMessage(message)
    },
    [onSendMessage],
  )

  return (
    <div
      ref={panelRef}
      className={cn(
        'relative flex h-full shrink-0 flex-col border-l border-border/80 bg-card/50',
        'transition-[width,opacity] duration-200 ease-out',
        isOpen
          ? 'max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-l-0 md:opacity-100'
          : 'w-0 opacity-0 overflow-hidden max-md:hidden',
        isOpen && 'opacity-100',
      )}
      style={isOpen ? { width: `${panelWidth}px` } : undefined}
      aria-label="Cortex Dashboard"
      aria-hidden={!isOpen}
    >
      {/* Resize handle (left edge) — hidden on mobile */}
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
            <TabsTrigger
              value="knowledge"
              className="h-6 gap-1 rounded-sm px-2 text-[11px] font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              <BookOpen className="size-3" />
              Knowledge
            </TabsTrigger>
            <TabsTrigger
              value="notes"
              className="h-6 gap-1 rounded-sm px-2 text-[11px] font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              <StickyNote className="size-3" />
              Notes
            </TabsTrigger>
            <TabsTrigger
              value="review"
              className="h-6 gap-1 rounded-sm px-2 text-[11px] font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              <ClipboardList className="size-3" />
              Review
            </TabsTrigger>
            <TabsTrigger
              value="schedules"
              className="h-6 gap-1 rounded-sm px-2 text-[11px] font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              <Clock3 className="size-3" />
              Cron
            </TabsTrigger>
          </TabsList>

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
              {/* Knowledge scope selector */}
              <div className="shrink-0 border-b border-border/60 px-3 py-2">
                <Select value={selectedKnowledgeScope} onValueChange={setSelectedKnowledgeScope}>
                  <SelectTrigger className="h-7 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="common">Common Knowledge</SelectItem>
                    {Object.entries(paths.profileKnowledge)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([profileId, entry]) => (
                        <SelectItem key={profileId} value={profileId}>
                          <div className="flex items-center gap-1.5">
                            <span>{profileId}</span>
                            {entry.exists && entry.sizeBytes > 0 ? (
                              <span className="text-[9px] text-muted-foreground">
                                ({(entry.sizeBytes / 1024).toFixed(1)}KB)
                              </span>
                            ) : (
                              <span className="text-[9px] text-muted-foreground/60">(empty)</span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {/* Viewer */}
              <div className="min-h-0 flex-1">
                <KnowledgeFileViewer
                  key={`knowledge-${selectedKnowledgeScope}-${refreshKey}`}
                  wsUrl={wsUrl}
                  filePath={
                    selectedKnowledgeScope === 'common'
                      ? paths.commonKnowledge
                      : paths.profileKnowledge[selectedKnowledgeScope]?.path ?? null
                  }
                  label={
                    selectedKnowledgeScope === 'common'
                      ? 'Common Knowledge'
                      : `Project Knowledge: ${selectedKnowledgeScope}`
                  }
                  description={
                    selectedKnowledgeScope === 'common'
                      ? 'Shared knowledge base across all profiles'
                      : `Knowledge specific to ${selectedKnowledgeScope}`
                  }
                  editable
                  onArtifactClick={onArtifactClick}
                />
              </div>
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="notes" className="mt-0 min-h-0 flex-1">
          {pathsLoaded ? (
            <KnowledgeFileViewer
              key={`notes-${refreshKey}`}
              wsUrl={wsUrl}
              filePath={paths.cortexNotes}
              label="Cortex Notes"
              description="Working notes and tentative observations"
              editable
              onArtifactClick={onArtifactClick}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="review" className="mt-0 min-h-0 flex-1">
          <ReviewStatusPanel
            key={`review-${refreshKey}`}
            wsUrl={wsUrl}
            onTriggerReview={handleTriggerReview}
          />
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
