import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Archive, BookOpen, GitBranch, ListTree, RefreshCw, X } from 'lucide-react'
import type {
  CortexChangelogEntry,
  CortexConsolidationResponse,
  CortexEntriesResponse,
  CortexIndexResponse,
  CortexKnowledgeEntry,
} from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { ArtifactReference } from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import { HelpTrigger } from '@/components/help/HelpTrigger'
import type { DiffViewerInitialState } from '@/components/diff-viewer/DiffViewerDialog'
import { CortexSectionProvenance } from './CortexSectionProvenance'

interface CortexDashboardPanelProps {
  wsUrl: string
  managerId: string
  isOpen: boolean
  onClose: () => void
  onArtifactClick: (artifact: ArtifactReference) => void
  onOpenSession: (agentId: string) => void
  onOpenDiffViewer?: (initialState: DiffViewerInitialState) => void
  requestedTab?: { tab: DashboardTab; nonce: number } | null
  onActiveTabChange?: (tab: DashboardTab) => void
}

export type DashboardTab = 'index' | 'entries' | 'changelog' | 'consolidation'

const PANEL_WIDTH_KEY = 'cortex-panel-width'
const DEFAULT_WIDTH = 460
const MIN_WIDTH = 340
const MAX_WIDTH = 760

function loadPersistedWidth(): number {
  const stored = localStorage.getItem(PANEL_WIDTH_KEY)
  const value = stored ? Number.parseInt(stored, 10) : NaN
  return Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH ? value : DEFAULT_WIDTH
}

function isDashboardTab(value: string): value is DashboardTab {
  return value === 'index' || value === 'entries' || value === 'changelog' || value === 'consolidation'
}

export function CortexDashboardPanel({
  wsUrl,
  managerId: _managerId,
  isOpen,
  onClose,
  onArtifactClick: _onArtifactClick,
  onOpenSession: _onOpenSession,
  onOpenDiffViewer: _onOpenDiffViewer,
  requestedTab,
  onActiveTabChange,
}: CortexDashboardPanelProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>('index')
  const [panelWidth, setPanelWidth] = useState(loadPersistedWidth)
  const [indexView, setIndexView] = useState<CortexIndexResponse | null>(null)
  const [entriesView, setEntriesView] = useState<CortexEntriesResponse | null>(null)
  const [changelog, setChangelog] = useState<CortexChangelogEntry[]>([])
  const [consolidation, setConsolidation] = useState<CortexConsolidationResponse | null>(null)
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const isDraggingRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (requestedTab) {
      setActiveTab(requestedTab.tab)
      onActiveTabChange?.(requestedTab.tab)
    }
  }, [onActiveTabChange, requestedTab])

  useEffect(() => {
    if (!isOpen) return
    const abortController = new AbortController()
    void Promise.all([
      fetchJson<CortexIndexResponse>(wsUrl, '/api/cortex/index', abortController.signal).then(setIndexView),
      fetchJson<CortexEntriesResponse>(wsUrl, '/api/cortex/entries', abortController.signal).then((payload) => {
        setEntriesView(payload)
        setSelectedEntryId((current) => current ?? payload.entries[0]?.id ?? null)
      }),
      fetchJson<{ changelog: CortexChangelogEntry[] }>(wsUrl, '/api/cortex/changelog', abortController.signal).then((payload) => setChangelog(payload.changelog ?? [])),
      fetchJson<CortexConsolidationResponse>(wsUrl, '/api/cortex/consolidation', abortController.signal).then(setConsolidation),
    ]).catch(() => undefined)
    return () => abortController.abort()
  }, [isOpen, refreshKey, wsUrl])

  const selectedEntry = useMemo(
    () => entriesView?.entries.find((entry) => entry.id === selectedEntryId) ?? null,
    [entriesView, selectedEntryId],
  )

  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    isDraggingRef.current = true
    const startX = event.clientX
    const startWidth = panelWidth
    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return
      setPanelWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + startX - moveEvent.clientX)))
    }
    const handleMouseUp = () => {
      isDraggingRef.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      const width = panelRef.current?.getBoundingClientRect().width
      if (width) localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)))
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [panelWidth])

  const runConsolidation = useCallback(async () => {
    await fetch(resolveApiEndpoint(wsUrl, '/api/cortex/consolidation'), { method: 'POST' })
    setRefreshKey((value) => value + 1)
  }, [wsUrl])

  return (
    <div
      ref={panelRef}
      className={cn('relative flex h-full shrink-0 flex-col border-l border-border/80 bg-card/50 transition-[width,opacity] duration-200 ease-out',
        isOpen ? 'max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-l-0 md:w-[var(--cortex-panel-width)] md:opacity-100' : 'w-0 overflow-hidden opacity-0 max-md:hidden')}
      style={isOpen ? ({ '--cortex-panel-width': `${panelWidth}px` } as CSSProperties) : undefined}
      aria-label="Cortex Dashboard"
      aria-hidden={!isOpen}
    >
      <div className="absolute left-0 top-0 z-10 hidden h-full w-1 cursor-col-resize hover:bg-primary/20 md:block" onMouseDown={handleMouseDown} role="separator" aria-orientation="vertical" aria-label="Resize panel" />
      <Tabs value={activeTab} onValueChange={(value) => {
        if (isDashboardTab(value)) {
          setActiveTab(value)
          onActiveTabChange?.(value)
        }
      }} className="flex h-full flex-col gap-0">
        <div className="flex h-[62px] shrink-0 items-center gap-2 px-3">
          <TabsList className="h-7 w-full bg-muted/60 p-0.5">
            <TabTrigger value="index" icon={<BookOpen className="size-3" />} label="Index" />
            <TabTrigger value="entries" icon={<ListTree className="size-3" />} label="Entries" />
            <TabTrigger value="changelog" icon={<GitBranch className="size-3" />} label="Log" />
            <TabTrigger value="consolidation" icon={<Archive className="size-3" />} label="Run" />
          </TabsList>
          <HelpTrigger contextKey="cortex.dashboard" size="sm" className="h-7 w-7" />
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} aria-label="Close dashboard panel">
            <X className="size-3.5" />
          </Button>
        </div>

        <TabsContent value="index" className="mt-0 min-h-0 flex-1 overflow-auto px-3 pb-3">
          <IndexTab view={indexView} />
        </TabsContent>
        <TabsContent value="entries" className="mt-0 min-h-0 flex-1 overflow-hidden">
          <EntriesTab entries={entriesView?.entries ?? []} selectedEntry={selectedEntry} onSelect={setSelectedEntryId} />
        </TabsContent>
        <TabsContent value="changelog" className="mt-0 min-h-0 flex-1 overflow-auto px-3 pb-3">
          <ChangelogTab changelog={changelog} />
        </TabsContent>
        <TabsContent value="consolidation" className="mt-0 min-h-0 flex-1 overflow-auto px-3 pb-3">
          <ConsolidationTab view={consolidation} onRun={runConsolidation} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function TabTrigger({ value, icon, label }: { value: DashboardTab; icon: ReactNode; label: string }) {
  return (
    <TabsTrigger value={value} className="h-6 gap-1 rounded-sm px-2 text-[11px] font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
      {icon}
      {label}
    </TabsTrigger>
  )
}

function IndexTab({ view }: { view: CortexIndexResponse | null }) {
  return (
    <div className="space-y-3">
      {(view?.indexes ?? []).map((index) => (
        <section key={index.scope} className="space-y-2 border-b border-border/60 py-3" data-testid="cortex-index-section">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="font-medium">{index.scope}</span>
            <span className="text-muted-foreground">{index.tokenEstimate} / {index.tokenCap} tok</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-sm bg-muted">
            <div className="h-full bg-primary" style={{ width: `${Math.min(100, (index.tokenEstimate / Math.max(1, index.tokenCap)) * 100)}%` }} />
          </div>
          <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] leading-5">{index.content || '(empty)'}</pre>
        </section>
      ))}
    </div>
  )
}

function EntriesTab({ entries, selectedEntry, onSelect }: { entries: CortexKnowledgeEntry[]; selectedEntry: CortexKnowledgeEntry | null; onSelect: (id: string) => void }) {
  const grouped = ['preference', 'convention', 'gotcha', 'pointer'].map((type) => ({
    type,
    entries: entries.filter((entry) => entry.type === type),
  })).filter((group) => group.entries.length > 0)
  return (
    <div className="grid h-full grid-cols-[180px_minmax(0,1fr)]">
      <div className="min-h-0 overflow-auto border-r border-border/60 p-2">
        {grouped.map((group) => (
          <div key={group.type} className="mb-3">
            <div className="mb-1 px-1 text-[10px] font-medium uppercase text-muted-foreground">{group.type}</div>
            {group.entries.map((entry) => (
              <button key={entry.id} type="button" onClick={() => onSelect(entry.id)} className={cn('mb-1 block w-full rounded-md px-2 py-1.5 text-left text-[11px] hover:bg-accent', selectedEntry?.id === entry.id && 'bg-accent')} data-testid="cortex-entry-row">
                <span className="block truncate font-medium">{entry.title}</span>
                <span className="text-muted-foreground">{entry.tokenEstimate} tok · x{entry.support_count}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="min-h-0 overflow-auto p-3">
        {selectedEntry ? <EntryDetail entry={selectedEntry} /> : null}
      </div>
    </div>
  )
}

function EntryDetail({ entry }: { entry: CortexKnowledgeEntry }) {
  return (
    <div className="space-y-3" data-testid="cortex-provenance-panel">
      <div>
        <h3 className="text-sm font-semibold">{entry.title}</h3>
        <p className="text-[11px] text-muted-foreground">{entry.id} · {entry.status} · {entry.scope}</p>
      </div>
      <p className="rounded-md bg-muted/40 p-2 text-xs leading-5">{entry.body}</p>
      <CortexSectionProvenance entry={entry} />
    </div>
  )
}

function ChangelogTab({ changelog }: { changelog: CortexChangelogEntry[] }) {
  return (
    <div className="space-y-2 py-3">
      {changelog.map((entry, index) => (
        <div key={`${entry.runId}-${index}`} className="rounded-md border border-border/60 p-2 text-xs">
          <div className="font-medium">{entry.action}{entry.entryId ? ` · ${entry.entryId}` : ''}</div>
          <div className="text-muted-foreground">{entry.why}</div>
        </div>
      ))}
    </div>
  )
}

function ConsolidationTab({ view, onRun }: { view: CortexConsolidationResponse | null; onRun: () => void }) {
  return (
    <div className="space-y-3 py-3">
      <Button size="sm" className="h-8 gap-1" onClick={onRun}>
        <RefreshCw className="size-3" />
        Consolidate now
      </Button>
      <div className="rounded-md border border-border/60 p-2 text-xs">
        <div className="font-medium">Last run</div>
        <div className="text-muted-foreground">{view?.consolidation.lastRun?.completedAt ?? 'Never'}</div>
      </div>
      <div className="rounded-md border border-border/60 p-2 text-xs">
        <div className="font-medium">Promotion review queue</div>
        {(view?.consolidation.promotionQueue ?? []).length === 0 ? (
          <div className="text-muted-foreground">No nominations</div>
        ) : view?.consolidation.promotionQueue.map((item) => (
          <div key={item.id} className="mt-2 text-muted-foreground">{item.title} · {item.profileScopes.length} profiles</div>
        ))}
      </div>
    </div>
  )
}

async function fetchJson<T>(wsUrl: string, path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(resolveApiEndpoint(wsUrl, path), { signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return (await response.json()) as T
}
