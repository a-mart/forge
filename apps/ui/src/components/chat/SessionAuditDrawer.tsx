import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ChevronDown, ChevronRight, Clipboard, Loader2, RotateCw, X } from 'lucide-react'
import type { SessionAuditEntry, SessionAuditEntryCategory, SessionAuditManifest, SessionAuditWorkerSummary } from '@forge/protocol'
import { SESSION_AUDIT_ENTRY_CATEGORIES } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogDescription, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { fetchSessionAuditPage } from '@/lib/session-audit-api'
import { cn } from '@/lib/utils'

const PAGE_LIMIT = 50
const ALL_CATEGORIES = 'all'
const MANAGER_SOURCE_VALUE = 'session'
const WORKER_SOURCE_PREFIX = 'worker:'

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

  if (activeRequestKeyRef.current !== requestKey) {
    activeRequestKeyRef.current = requestKey
    requestGenerationRef.current += 1
  }

  const canShowRows = open && Boolean(sessionAgentId)
  const currentManifest = canShowRows && manifestState?.sessionKey === sourceSessionKey ? manifestState.manifest : null
  const sourceOptions = useMemo(() => buildSourceOptions(currentManifest), [currentManifest])
  const selectedSourceMetadata = sourceOptions.find((source) => source.value === selectedSource) ?? sourceOptions[0]
  const currentPageState = canShowRows && pageState?.requestKey === requestKey ? pageState : null
  const visibleItems = currentPageState?.items ?? []
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
  }, [])

  useEffect(() => {
    setSelectedSource(MANAGER_SOURCE_VALUE)
  }, [sessionAgentId, wsUrl])

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
              <CopyPill label="Session" value={sessionAgentId} />
            ) : null}
          </div>

          <ScrollArea className="min-h-0 flex-1 overflow-hidden">
            <div className="min-w-0 space-y-3 p-4">
            {visibleLoading ? (
              <StateCard icon={<Loader2 className="size-4 animate-spin" />} title="Loading audit log…" />
            ) : visibleError ? (
              <StateCard title="Could not load session audit" detail={visibleError} tone="error" />
            ) : visibleItems.length === 0 ? (
              <StateCard title="No audit rows found" detail="Try a different category or type filter." />
            ) : (
              visibleItems.map((item) => <SessionAuditRow key={item.id} item={item} />)
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

function SessionAuditRow({ item }: { item: SessionAuditEntry }) {
  const [expanded, setExpanded] = useState(false)
  const timestamp = item.entryTimestamp ?? item.wrapperTimestamp
  const typeLabel = useMemo(() => [item.wrapperType, item.conversationType, item.customType].filter(Boolean).join(' / '), [item.wrapperType, item.conversationType, item.customType])

  return (
    <article className="min-w-0 rounded-lg border border-border/70 bg-card/60 p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1 overflow-hidden">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px]">{formatCategory(item.category)}</Badge>
            <Badge variant="secondary" className="max-w-full truncate text-[10px]">{item.sourceLabel}</Badge>
            {typeLabel ? <span className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">{typeLabel}</span> : null}
          </div>
          <h3 className="break-words text-sm font-semibold text-foreground">{item.title}</h3>
          <p className="break-words text-xs text-muted-foreground">{item.summary}</p>
        </div>
        <div className="shrink-0 text-right font-mono text-[11px] text-muted-foreground">
          {timestamp ? formatTimestamp(timestamp) : `line ${item.lineNumber ?? item.ordinal ?? '—'}`}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <CopyPill label="Row" value={item.id} />
        <CopyPill label="Agent" value={item.agentId ?? item.actorAgentId ?? item.fromAgentId ?? item.toAgentId} />
        <CopyPill label="Tool call" value={item.toolCallId} />
        <CopyPill label="Source" value={item.sourceId} />
      </div>

      <dl className="mt-3 grid min-w-0 gap-2 rounded-md border border-border/50 bg-muted/20 p-2 text-[11px] md:grid-cols-2 xl:grid-cols-4">
        <MetaItem label="Source kind" value={item.sourceKind} />
        <MetaItem label="Source label" value={item.sourceLabel} />
        <MetaItem label="Conversation source" value={item.conversationSource} />
        <MetaItem label="Relative path" value={item.relativePath} copyable />
        <MetaItem label="Byte offsets" value={`${item.byteOffset} → ${item.nextByteOffset}`} />
        <MetaItem label="Renderable" value={item.renderable ? 'yes' : 'no'} />
        <MetaItem label="Hidden reason" value={item.hiddenReason} />
        <MetaItem label="Line" value={item.lineNumber ? String(item.lineNumber) : undefined} />
      </dl>

      <button
        type="button"
        className="mt-3 flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {expanded ? 'Hide capped JSON preview' : 'Show capped JSON preview'}
      </button>
      {expanded ? (
        <div className="mt-2 space-y-2">
          <JsonPreview label={item.previewTruncated ? 'Parsed preview (truncated)' : 'Parsed preview'} value={item.preview} />
          <JsonPreview label={item.rawPreviewTruncated ? 'Raw row preview (truncated)' : 'Raw row preview'} value={item.rawPreview} />
        </div>
      ) : null}
    </article>
  )
}

function MetaItem({ label, value, copyable = false }: { label: string; value?: string; copyable?: boolean }) {
  if (!value) return null
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0 font-mono text-foreground">
        {copyable ? <CopyPill label={label} value={value} /> : <span className="break-words">{value}</span>}
      </dd>
    </div>
  )
}

function JsonPreview({ label, value }: { label: string; value: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-muted/30">
      <div className="border-b border-border/60 px-2 py-1 text-[11px] font-medium text-muted-foreground">{label}</div>
      <pre className="max-h-96 overflow-auto whitespace-pre p-2 font-mono text-[11px] leading-relaxed text-foreground"><code className="block min-w-max">{value}</code></pre>
    </div>
  )
}

function CopyPill({ label, value }: { label: string; value?: string | null }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null

  async function copy() {
    try {
      await navigator.clipboard?.writeText(value ?? '')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-1.5 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      onClick={() => void copy()}
      title={`Copy ${label.toLowerCase()}: ${value}`}
    >
      <Clipboard className="size-3" aria-hidden="true" />
      <span className="font-sans text-[10px] uppercase tracking-wide">{copied ? 'Copied' : label}</span>
      <span className="min-w-0 truncate">{value}</span>
    </button>
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
