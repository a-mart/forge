import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Clipboard, Loader2, RotateCw, X } from 'lucide-react'
import type { SessionAuditEntry, SessionAuditEntryCategory, SessionAuditEntryDetailResponse, SessionAuditManifest, SessionAuditWorkerSummary } from '@forge/protocol'
import { SESSION_AUDIT_ENTRY_CATEGORIES } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogDescription, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { fetchSessionAuditEntryDetail, fetchSessionAuditPage } from '@/lib/session-audit-api'
import { shouldUsePlainJsonDetailView } from '@/lib/session-audit-json-detail'
import { highlightCode } from '@/lib/syntax-highlight'
import { cn } from '@/lib/utils'
import '@/styles/syntax-highlight.css'

const PAGE_LIMIT = 50
const EMPTY_AUDIT_ITEMS: SessionAuditEntry[] = []
const ALL_CATEGORIES = 'all'
const MANAGER_SOURCE_VALUE = 'session'
const WORKER_SOURCE_PREFIX = 'worker:'
const SPLIT_STORAGE_KEY = 'forge.sessionAudit.splitPercent'
const DEFAULT_SPLIT_PERCENT = 38
const MIN_SPLIT_PERCENT = 26
const MAX_SPLIT_PERCENT = 62
const SPLIT_KEYBOARD_STEP = 4

interface SessionAuditDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionAgentId: string | null
  sessionLabel: string
  wsUrl?: string
}

export function SessionAuditDrawer({
  open,
  onOpenChange,
  sessionAgentId,
  sessionLabel,
  wsUrl,
}: SessionAuditDrawerProps) {
  const [category, setCategory] = useState<string>(ALL_CATEGORIES)
  const [typeFilter, setTypeFilter] = useState('')
  const [selectedSource, setSelectedSource] = useState(MANAGER_SOURCE_VALUE)
  const [manifestState, setManifestState] = useState<{
    sessionKey: string
    manifest: SessionAuditManifest
  } | null>(null)
  const [pageState, setPageState] = useState<{
    requestKey: string
    items: SessionAuditEntry[]
    nextCursor?: string
    hasMore: boolean
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const normalizedTypeFilter = typeFilter.trim()
  const selectedCategory = category === ALL_CATEGORIES ? undefined : category as SessionAuditEntryCategory
  const selectedWorkerId = selectedSource.startsWith(WORKER_SOURCE_PREFIX) ? selectedSource.slice(WORKER_SOURCE_PREFIX.length) : undefined
  const selectedScope = selectedWorkerId ? 'worker' : 'session'
  const selectedSourceKind = selectedWorkerId ? 'canonical_worker_jsonl' : 'canonical_session_jsonl'
  const sourceSessionKey = `${open ? 'open' : 'closed'}:${sessionAgentId ?? ''}:${wsUrl ?? ''}`
  const requestKey = `${sourceSessionKey}:${selectedSource}:${category}:${normalizedTypeFilter}`
  const activeRequestKeyRef = useRef(requestKey)
  const requestGenerationRef = useRef(0)
  const loadMoreAbortRef = useRef<AbortController | null>(null)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const resizingSplitPointerIdRef = useRef<number | null>(null)
  const [splitPercent, setSplitPercent] = useState(() => readStoredSplitPercent())
  const [splitLayoutEnabled, setSplitLayoutEnabled] = useState(() => isDesktopSplitLayout())

  if (activeRequestKeyRef.current !== requestKey) {
    activeRequestKeyRef.current = requestKey
    requestGenerationRef.current += 1
  }

  const canShowRows = open && Boolean(sessionAgentId)
  const currentManifest = canShowRows && manifestState?.sessionKey === sourceSessionKey ? manifestState.manifest : null
  const sourceOptions = useMemo(() => buildSourceOptions(currentManifest), [currentManifest])
  const selectedSourceMetadata = sourceOptions.find((source) => source.value === selectedSource) ?? sourceOptions[0]
  const currentPageState = canShowRows && pageState?.requestKey === requestKey ? pageState : null
  const visibleItems = currentPageState?.items ?? EMPTY_AUDIT_ITEMS
  const visibleLoading = canShowRows ? loading : false
  const visibleLoadingMore = canShowRows ? loadingMore : false
  const visibleError = canShowRows ? error : null
  const visibleHasMore = currentPageState?.hasMore ?? false
  const visibleNextCursor = currentPageState?.nextCursor

  const resetAuditState = useCallback(() => {
    loadMoreAbortRef.current?.abort()
    loadMoreAbortRef.current = null
    setPageState(null)
    setManifestState(null)
    setLoading(false)
    setLoadingMore(false)
    setError(null)
    setSelectedEntryId(null)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mediaQuery = window.matchMedia('(min-width: 1024px)')
    const handleChange = () => setSplitLayoutEnabled(mediaQuery.matches)
    handleChange()
    mediaQuery.addEventListener?.('change', handleChange)
    return () => mediaQuery.removeEventListener?.('change', handleChange)
  }, [])

  useEffect(() => {
    setSelectedSource(MANAGER_SOURCE_VALUE)
    setSelectedEntryId(null)
  }, [sessionAgentId, wsUrl])

  useEffect(() => {
    setSelectedEntryId(null)
  }, [requestKey])

  useEffect(() => {
    const generation = requestGenerationRef.current

    if (!open || !sessionAgentId) {
      resetAuditState()
      return
    }

    loadMoreAbortRef.current?.abort()
    loadMoreAbortRef.current = null

    const controller = new AbortController()
    const currentRequestKey = requestKey

    async function loadInitial() {
      setLoading(true)
      setLoadingMore(false)
      setError(null)
      try {
        const page = await fetchSessionAuditPage(wsUrl, sessionAgentId!, {
          scope: selectedScope,
          workerId: selectedWorkerId,
          sourceKind: selectedSourceKind,
          order: 'desc',
          limit: PAGE_LIMIT,
          categories: selectedCategory ? [selectedCategory] : undefined,
          types: normalizedTypeFilter ? [normalizedTypeFilter] : undefined,
          signal: controller.signal,
        })
        if (controller.signal.aborted || activeRequestKeyRef.current !== currentRequestKey || requestGenerationRef.current !== generation) return
        setManifestState({ sessionKey: sourceSessionKey, manifest: page.manifest })
        setPageState({
          requestKey: currentRequestKey,
          items: page.items,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        })
      } catch (error) {
        if (controller.signal.aborted || activeRequestKeyRef.current !== currentRequestKey || requestGenerationRef.current !== generation) return
        setPageState({ requestKey: currentRequestKey, items: [], hasMore: false })
        setError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!controller.signal.aborted && activeRequestKeyRef.current === currentRequestKey && requestGenerationRef.current === generation) {
          setLoading(false)
        }
      }
    }

    void loadInitial()
    return () => {
      controller.abort()
    }
  }, [open, requestKey, resetAuditState, sessionAgentId, selectedCategory, normalizedTypeFilter, selectedScope, selectedSourceKind, selectedWorkerId, sourceSessionKey, wsUrl])

  const updateSplitPercent = useCallback((nextPercent: number) => {
    const boundedPercent = clampSplitPercent(nextPercent)
    setSplitPercent(boundedPercent)
    persistSplitPercent(boundedPercent)
  }, [])

  const updateSplitFromClientX = useCallback((clientX: number) => {
    const container = splitContainerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0) return
    updateSplitPercent(((clientX - rect.left) / rect.width) * 100)
  }, [updateSplitPercent])

  const handleSplitPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    resizingSplitPointerIdRef.current = event.pointerId
    event.currentTarget.setPointerCapture?.(event.pointerId)
    updateSplitFromClientX(event.clientX)
  }, [updateSplitFromClientX])

  const handleSplitPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (resizingSplitPointerIdRef.current !== event.pointerId) return
    event.preventDefault()
    updateSplitFromClientX(event.clientX)
  }, [updateSplitFromClientX])

  const handleSplitPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (resizingSplitPointerIdRef.current === event.pointerId) {
      resizingSplitPointerIdRef.current = null
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
  }, [])

  const handleSplitKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      updateSplitPercent(splitPercent - SPLIT_KEYBOARD_STEP)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      updateSplitPercent(splitPercent + SPLIT_KEYBOARD_STEP)
    } else if (event.key === 'Home') {
      event.preventDefault()
      updateSplitPercent(MIN_SPLIT_PERCENT)
    } else if (event.key === 'End') {
      event.preventDefault()
      updateSplitPercent(MAX_SPLIT_PERCENT)
    }
  }, [splitPercent, updateSplitPercent])

  async function loadMore() {
    if (!sessionAgentId || !visibleNextCursor || loadingMore) return
    const currentRequestKey = activeRequestKeyRef.current
    const generation = requestGenerationRef.current
    const cursor = visibleNextCursor
    loadMoreAbortRef.current?.abort()
    const controller = new AbortController()
    loadMoreAbortRef.current = controller
    setLoadingMore(true)
    setError(null)
    try {
      const page = await fetchSessionAuditPage(wsUrl, sessionAgentId, {
        scope: selectedScope,
        workerId: selectedWorkerId,
        sourceKind: selectedSourceKind,
        cursor,
        order: 'desc',
        limit: PAGE_LIMIT,
        categories: selectedCategory ? [selectedCategory] : undefined,
        types: normalizedTypeFilter ? [normalizedTypeFilter] : undefined,
        signal: controller.signal,
      })
      if (controller.signal.aborted || activeRequestKeyRef.current !== currentRequestKey || requestGenerationRef.current !== generation) return
      setManifestState({ sessionKey: sourceSessionKey, manifest: page.manifest })
      setPageState((current) => {
        if (!current || current.requestKey !== currentRequestKey || current.nextCursor !== cursor || requestGenerationRef.current !== generation) {
          return current
        }
        return {
          requestKey: currentRequestKey,
          items: [...current.items, ...page.items],
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        }
      })
    } catch (error) {
      if (controller.signal.aborted || activeRequestKeyRef.current !== currentRequestKey || requestGenerationRef.current !== generation) return
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (!controller.signal.aborted && activeRequestKeyRef.current === currentRequestKey && requestGenerationRef.current === generation) {
        setLoadingMore(false)
        if (loadMoreAbortRef.current === controller) {
          loadMoreAbortRef.current = null
        }
      }
    }
  }

  const selectedEntry = visibleItems.find((item) => item.id === selectedEntryId) ?? null

  useEffect(() => {
    if (!canShowRows || visibleLoading) return
    if (visibleItems.length === 0) {
      if (selectedEntryId !== null) setSelectedEntryId(null)
      return
    }
    if (!selectedEntryId || !visibleItems.some((item) => item.id === selectedEntryId)) {
      setSelectedEntryId(visibleItems[0]?.id ?? null)
    }
  }, [canShowRows, selectedEntryId, visibleItems, visibleLoading])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className="fixed z-50 flex min-w-0 flex-col gap-0 overflow-hidden border border-border bg-background p-0 shadow-xl data-[state=closed]:animate-out data-[state=open]:animate-in"
          style={{
            inset: 0,
            width: '100vw',
            maxWidth: 'none',
            height: '100vh',
            maxHeight: 'none',
            margin: 0,
            transform: 'none',
          }}
        >
          <DialogHeader className="min-w-0 shrink-0 border-b border-border/70 p-4 pr-12">
            <DialogTitle>Session Audit Log</DialogTitle>
            <DialogDescription>
              Complete persisted session audit for {sessionLabel}, newest items first. This full-screen diagnostic view reads canonical session history and does not change normal Web, All, or Detailed chat visibility.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-w-0 shrink-0 flex-col gap-3 border-b border-border/70 bg-background/95 p-4">
            <div className="flex flex-col gap-2">
              <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted-foreground">
                Source
                <Select value={selectedSource} onValueChange={setSelectedSource}>
                  <SelectTrigger className="h-8 text-xs" aria-label="Audit source">
                    <SelectValue placeholder="Manager canonical JSONL" />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceOptions.map((source) => (
                      <SelectItem key={source.value} value={source.value}>{source.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {selectedSourceMetadata ? <SourceMetadata source={selectedSourceMetadata} /> : null}
            </div>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
                Category
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="All categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
                    {SESSION_AUDIT_ENTRY_CATEGORIES.map((value) => (
                      <SelectItem key={value} value={value}>{formatCategory(value)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
                Type filter
                <Input
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value)}
                  placeholder="wrapper/custom/conversation type"
                  className="h-8 text-xs"
                />
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={loading}
                onClick={() => {
                  setCategory(ALL_CATEGORIES)
                  setTypeFilter('')
                  setSelectedSource(MANAGER_SOURCE_VALUE)
                }}
              >
                <RotateCw className="size-3.5" />
                Reset
              </Button>
            </div>
            {sessionAgentId ? (
              <div className="min-w-0 rounded-md border border-border/50 bg-muted/20 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                <span className="font-sans uppercase tracking-wide">Session</span> <span className="break-all">{sessionAgentId}</span>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Select any audit row to load its full canonical JSONL detail. Normal Web, All, and Detailed chat visibility is unchanged.
            </p>
          </div>

          <div ref={splitContainerRef} className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
            <ScrollArea
              className="min-h-0 w-full min-w-0 flex-1 overflow-hidden border-border/70 lg:flex-none"
              style={splitLayoutEnabled ? { flexBasis: `${splitPercent}%` } : undefined}
            >
              <div className="min-w-0 space-y-2 p-3" role="listbox" aria-label="Session audit rows">
              {visibleLoading ? (
                <StateCard icon={<Loader2 className="size-4 animate-spin" />} title="Loading audit log…" />
              ) : visibleError ? (
                <StateCard title="Could not load session audit" detail={visibleError} tone="error" />
              ) : visibleItems.length === 0 ? (
                <StateCard title="No audit rows found" detail="Try a different category or type filter." />
              ) : (
                visibleItems.map((item) => (
                  <SessionAuditRow
                    key={item.id}
                    item={item}
                    selected={item.id === selectedEntryId}
                    onSelect={() => setSelectedEntryId(item.id)}
                  />
                ))
              )}

              {!visibleLoading && !visibleError && visibleItems.length > 0 ? (
                <div className="flex justify-center pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!visibleHasMore || visibleLoadingMore}
                    onClick={() => void loadMore()}
                    className="gap-1.5 text-xs"
                  >
                    {visibleLoadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {visibleHasMore ? 'Load older audit rows' : 'End of audit log'}
                  </Button>
                </div>
              ) : null}
              </div>
            </ScrollArea>

            <div
              role="separator"
              aria-label="Resize audit panes"
              aria-orientation="vertical"
              aria-valuemin={MIN_SPLIT_PERCENT}
              aria-valuemax={MAX_SPLIT_PERCENT}
              aria-valuenow={Math.round(splitPercent)}
              tabIndex={0}
              className="group hidden w-3 shrink-0 cursor-col-resize touch-none items-stretch justify-center outline-none lg:flex"
              onPointerDown={handleSplitPointerDown}
              onPointerMove={handleSplitPointerMove}
              onPointerUp={handleSplitPointerUp}
              onPointerCancel={handleSplitPointerUp}
              onKeyDown={handleSplitKeyDown}
            >
              <span className="my-2 flex w-2 items-center justify-center rounded-full transition-colors group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2">
                <span className="h-full w-0.5 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary" />
                <span className="absolute flex flex-col gap-1 rounded-full bg-background/80 px-0.5 py-1 opacity-70 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <span className="size-1 rounded-full bg-muted-foreground/60" />
                  <span className="size-1 rounded-full bg-muted-foreground/60" />
                  <span className="size-1 rounded-full bg-muted-foreground/60" />
                </span>
              </span>
            </div>

            <div className="flex min-h-[50vh] min-w-0 flex-1 flex-col overflow-hidden border-t border-border/70 lg:min-h-0 lg:border-t-0 lg:border-l-0">
              <SessionAuditDetailPanel
                sessionAgentId={sessionAgentId}
                wsUrl={wsUrl}
                entry={selectedEntry}
                scope={selectedScope}
                workerId={selectedWorkerId}
                sourceKind={selectedSourceKind}
              />
            </div>
          </div>
          <DialogPrimitive.Close
            className={cn(
              'absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity',
              'hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
              'disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground',
            )}
            aria-label="Close session audit log"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

interface AuditSourceOption {
  value: string
  label: string
  description: string
  relativePath: string
  bytes?: number
  updatedAt?: string
  status?: string
}

function isDesktopSplitLayout(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(min-width: 1024px)').matches
}

function clampSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_PERCENT
  return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, Math.round(value)))
}

function readStoredSplitPercent(): number {
  if (typeof window === 'undefined') return DEFAULT_SPLIT_PERCENT
  try {
    const storage = window.localStorage
    if (typeof storage?.getItem !== 'function') return DEFAULT_SPLIT_PERCENT
    const storedValue = storage.getItem(SPLIT_STORAGE_KEY)
    if (!storedValue) return DEFAULT_SPLIT_PERCENT
    return clampSplitPercent(Number(storedValue))
  } catch {
    return DEFAULT_SPLIT_PERCENT
  }
}

function persistSplitPercent(value: number): void {
  if (typeof window === 'undefined') return
  try {
    const storage = window.localStorage
    if (typeof storage?.setItem !== 'function') return
    storage.setItem(SPLIT_STORAGE_KEY, String(clampSplitPercent(value)))
  } catch {
    // Ignore storage failures; resizing should still work for the current render.
  }
}

function buildSourceOptions(manifest: SessionAuditManifest | null): AuditSourceOption[] {
  return [
    {
      value: MANAGER_SOURCE_VALUE,
      label: 'Manager canonical JSONL',
      description: 'Canonical manager session history',
      relativePath: manifest?.sessionRelativePath ?? 'session.jsonl',
      bytes: manifest?.sessionBytes,
    },
    ...(manifest?.workers ?? []).map(workerToSourceOption),
  ]
}

function workerToSourceOption(worker: SessionAuditWorkerSummary): AuditSourceOption {
  const workerName = worker.displayName?.trim() || worker.workerId
  return {
    value: `${WORKER_SOURCE_PREFIX}${worker.workerId}`,
    label: `Worker: ${workerName}${worker.descriptorPresent ? '' : ' (file only)'}`,
    description: worker.descriptorPresent ? 'Canonical worker transcript' : 'Canonical worker transcript without a live descriptor',
    relativePath: worker.relativePath,
    bytes: worker.bytes,
    updatedAt: worker.updatedAt,
    status: worker.status,
  }
}

function SourceMetadata({ source }: { source: AuditSourceOption }) {
  const parts = [
    source.description,
    source.relativePath,
    typeof source.bytes === 'number' ? formatBytes(source.bytes) : undefined,
    source.updatedAt ? `updated ${formatTimestamp(source.updatedAt)}` : undefined,
    source.status ? `status ${source.status}` : undefined,
  ].filter(Boolean)

  return <p className="min-w-0 break-words text-xs text-muted-foreground">{parts.join(' · ')}</p>
}

function SessionAuditRow({
  item,
  selected,
  onSelect,
}: {
  item: SessionAuditEntry
  selected: boolean
  onSelect: () => void
}) {
  const timestamp = item.entryTimestamp ?? item.wrapperTimestamp
  const typeLabel = useMemo(() => [item.wrapperType, item.conversationType, item.customType].filter(Boolean).join(' / '), [item.wrapperType, item.conversationType, item.customType])
  const agentLabel = item.agentId ?? item.actorAgentId ?? item.fromAgentId ?? item.toAgentId
  const offsetLabel = `${item.byteOffset}→${item.nextByteOffset}`

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'group flex w-full min-w-0 cursor-pointer flex-col gap-2 rounded-lg border p-3 text-left shadow-sm outline-none transition-colors',
        'hover:border-primary/50 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        selected ? 'border-primary/70 bg-primary/10 ring-1 ring-primary/25' : 'border-border/70 bg-card/60',
      )}
    >
      <span className="flex min-w-0 items-start justify-between gap-3">
        <span className="block min-w-0 space-y-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge variant={selected ? 'default' : 'outline'} className="max-w-full text-[10px]">{formatCategory(item.category)}</Badge>
            {typeLabel ? <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{typeLabel}</span> : null}
          </span>
          <span className="block line-clamp-1 text-sm font-semibold text-foreground">{item.title}</span>
        </span>
        <span className="shrink-0 text-right font-mono text-[10px] text-muted-foreground">
          {timestamp ? formatTimestamp(timestamp) : `line ${item.lineNumber ?? item.ordinal ?? '—'}`}
        </span>
      </span>

      <span className="block line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{item.summary}</span>

      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
        <span className="max-w-full truncate">{item.sourceLabel}</span>
        {agentLabel ? <span className="max-w-full truncate font-mono">agent {agentLabel}</span> : null}
        <span className="font-mono">offset {offsetLabel}</span>
        {item.hiddenReason ? <span className="max-w-full truncate">{item.hiddenReason}</span> : null}
      </span>
    </button>
  )
}

function SessionAuditDetailPanel({
  sessionAgentId,
  wsUrl,
  entry,
  scope,
  workerId,
  sourceKind,
}: {
  sessionAgentId: string | null
  wsUrl?: string
  entry: SessionAuditEntry | null
  scope: 'session' | 'worker'
  workerId?: string
  sourceKind: 'canonical_session_jsonl' | 'canonical_worker_jsonl'
}) {
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted')
  const [detail, setDetail] = useState<SessionAuditEntryDetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [wordWrap, setWordWrap] = useState(true)
  const copyResetTimeoutRef = useRef<number | null>(null)
  const requestKey = entry ? `${entry.id}:${scope}:${workerId ?? ''}:${sourceKind}` : ''
  const activeRequestKeyRef = useRef(requestKey)

  if (activeRequestKeyRef.current !== requestKey) {
    activeRequestKeyRef.current = requestKey
  }

  useEffect(() => {
    setViewMode('formatted')
    setDetail(null)
    setError(null)
    setCopied(false)
    setWordWrap(true)
    if (copyResetTimeoutRef.current) {
      clearTimeout(copyResetTimeoutRef.current)
      copyResetTimeoutRef.current = null
    }

    if (!entry || !sessionAgentId) {
      setLoading(false)
      return
    }

    const controller = new AbortController()
    const currentRequestKey = requestKey

    async function loadDetail() {
      setLoading(true)
      setError(null)
      try {
        const response = await fetchSessionAuditEntryDetail(wsUrl, sessionAgentId!, {
          scope,
          workerId,
          sourceKind,
          byteOffset: entry!.byteOffset,
          nextByteOffset: entry!.nextByteOffset,
          signal: controller.signal,
        })
        if (controller.signal.aborted || activeRequestKeyRef.current !== currentRequestKey) return
        setDetail(response)
      } catch (loadError) {
        if (controller.signal.aborted || activeRequestKeyRef.current !== currentRequestKey) return
        setDetail(null)
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      } finally {
        if (!controller.signal.aborted && activeRequestKeyRef.current === currentRequestKey) {
          setLoading(false)
        }
      }
    }

    void loadDetail()
    return () => {
      controller.abort()
      if (copyResetTimeoutRef.current) {
        clearTimeout(copyResetTimeoutRef.current)
        copyResetTimeoutRef.current = null
      }
    }
  }, [entry, requestKey, scope, sessionAgentId, sourceKind, workerId, wsUrl])

  const displayText = entry && (viewMode === 'formatted' && detail?.formattedJson
    ? detail.formattedJson
    : detail?.rawText ?? '')
  const usePlainDetailView = Boolean(detail && (detail.truncated || (displayText ? shouldUsePlainJsonDetailView(displayText) : false)))

  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select an audit row to load full canonical JSON details.
      </div>
    )
  }

  async function copyFullJson() {
    const text = viewMode === 'raw' ? detail?.rawText : (detail?.formattedJson ?? detail?.rawText)
    if (!text) return
    try {
      await navigator.clipboard?.writeText(text)
      setCopied(true)
      if (copyResetTimeoutRef.current) {
        clearTimeout(copyResetTimeoutRef.current)
      }
      copyResetTimeoutRef.current = window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="truncate text-sm font-semibold text-foreground">{entry.title}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {entry.relativePath} · bytes {entry.byteOffset} → {entry.nextByteOffset}
            {detail ? ` · ${formatBytes(detail.rawBytes)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border/60 p-0.5">
            <Button
              type="button"
              size="sm"
              variant={viewMode === 'formatted' ? 'secondary' : 'ghost'}
              className="h-7 px-2 text-xs"
              disabled={!detail?.formattedJson}
              onClick={() => setViewMode('formatted')}
            >
              Formatted
            </Button>
            <Button
              type="button"
              size="sm"
              variant={viewMode === 'raw' ? 'secondary' : 'ghost'}
              className="h-7 px-2 text-xs"
              disabled={!detail}
              onClick={() => setViewMode('raw')}
            >
              Raw
            </Button>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={!detail}
            onClick={() => setWordWrap((current) => !current)}
          >
            {wordWrap ? 'No wrap' : 'Wrap lines'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            disabled={!detail || loading}
            onClick={() => void copyFullJson()}
          >
            <Clipboard className="size-3.5" />
            {copied ? 'Copied' : 'Copy JSON'}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading full JSON…
          </div>
        ) : error ? (
          <div className="p-4">
            <StateCard title="Could not load full JSON" detail={error} tone="error" />
          </div>
        ) : detail?.truncated ? (
          <div className="flex h-full flex-col overflow-hidden">
            <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
              This row exceeds the {formatBytes(detail.maxBytes)} detail cap. Showing the first {formatBytes(new TextEncoder().encode(detail.rawText).length)} of {formatBytes(detail.rawBytes)}. Copy includes the fetched partial JSON only.
            </div>
            <JsonDetailView
              text={displayText ?? ''}
              wordWrap={wordWrap}
              usePlainView
              plainNotice="Server-truncated row — plain scrollable view to keep the audit UI responsive."
            />
          </div>
        ) : detail?.parseError && viewMode === 'formatted' && !detail.formattedJson ? (
          <div className="flex h-full flex-col overflow-hidden">
            <div className="border-b border-border/70 bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
              JSON parse failed: {detail.parseError}. Switch to Raw to inspect the original line.
            </div>
            <JsonDetailView text={displayText ?? ''} wordWrap={wordWrap} usePlainView={usePlainDetailView} />
          </div>
        ) : (
          <JsonDetailView text={displayText ?? ''} wordWrap={wordWrap} usePlainView={usePlainDetailView} />
        )}
      </div>
    </div>
  )
}

function JsonDetailView({
  text,
  wordWrap,
  usePlainView = false,
  plainNotice,
}: {
  text: string
  wordWrap: boolean
  usePlainView?: boolean
  plainNotice?: string
}) {
  const highlightedLines = useMemo(() => {
    if (!text || usePlainView) return null
    return text.split('\n').map((line) => highlightCode(line, 'json'))
  }, [text, usePlainView])

  if (!text) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        No JSON content available.
      </div>
    )
  }

  if (usePlainView) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="border-b border-border/70 bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          {plainNotice ?? 'Large JSON payload — plain scrollable view to keep the audit UI responsive. Copy still includes the full fetched JSON.'}
        </div>
        <pre
          className={cn(
            'min-h-0 flex-1 overflow-auto p-4 font-mono text-[12px] leading-relaxed text-foreground',
            wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
          )}
        >
          {text}
        </pre>
      </div>
    )
  }

  return (
    <div className="syntax-highlight h-full min-h-0 overflow-auto font-mono text-[12px] leading-relaxed">
      <table className="w-full min-w-0 border-collapse">
        <tbody>
          {(highlightedLines ?? []).map((html, index) => (
            <tr key={index} className="hover:bg-muted/20">
              <td className="sticky left-0 z-[1] select-none border-r border-border/30 bg-background/95 px-3 py-0 text-right align-top text-muted-foreground/50">
                {index + 1}
              </td>
              <td className={cn('px-3 py-0 align-top', wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
                <span dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StateCard({
  icon,
  title,
  detail,
  tone = 'muted',
}: {
  icon?: ReactNode
  title: string
  detail?: string
  tone?: 'muted' | 'error'
}) {
  return (
    <div className={cn('rounded-lg border p-4 text-sm', tone === 'error' ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-border/70 bg-muted/20 text-muted-foreground')}>
      <div className="flex items-center gap-2 font-medium">
        {icon}
        <span>{title}</span>
      </div>
      {detail ? <p className="mt-1 text-xs opacity-85">{detail}</p> : null}
    </div>
  )
}

function formatCategory(category: string): string {
  return category.replace(/_/g, ' ')
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`
    }
    value /= 1024
  }
  return `${bytes} B`
}
