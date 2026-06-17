import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Clipboard, Loader2, RotateCw } from 'lucide-react'
import type { SessionAuditEntry, SessionAuditEntryCategory } from '@forge/protocol'
import { SESSION_AUDIT_ENTRY_CATEGORIES } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Input } from '@/components/ui/input'
import { fetchSessionAuditPage } from '@/lib/session-audit-api'
import { cn } from '@/lib/utils'

const PAGE_LIMIT = 50
const ALL_CATEGORIES = 'all'

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
  const [items, setItems] = useState<SessionAuditEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const normalizedTypeFilter = typeFilter.trim()
  const selectedCategory = category === ALL_CATEGORIES ? undefined : category as SessionAuditEntryCategory
  const requestKey = `${open ? 'open' : 'closed'}:${sessionAgentId ?? ''}:${category}:${normalizedTypeFilter}:${wsUrl ?? ''}`
  const activeRequestKeyRef = useRef(requestKey)
  const canShowRows = open && Boolean(sessionAgentId)
  const visibleItems = canShowRows ? items : []
  const visibleLoading = canShowRows ? loading : false
  const visibleLoadingMore = canShowRows ? loadingMore : false
  const visibleError = canShowRows ? error : null
  const visibleHasMore = canShowRows ? hasMore : false

  const resetAuditState = useCallback(() => {
    setItems([])
    setNextCursor(undefined)
    setHasMore(false)
    setLoading(false)
    setLoadingMore(false)
    setError(null)
  }, [])

  useEffect(() => {
    activeRequestKeyRef.current = requestKey

    if (!open || !sessionAgentId) {
      resetAuditState()
      return
    }

    const controller = new AbortController()
    const currentRequestKey = requestKey

    async function loadInitial() {
      setLoading(true)
      setLoadingMore(false)
      setError(null)
      try {
        const page = await fetchSessionAuditPage(wsUrl, sessionAgentId!, {
          limit: PAGE_LIMIT,
          categories: selectedCategory ? [selectedCategory] : undefined,
          types: normalizedTypeFilter ? [normalizedTypeFilter] : undefined,
          signal: controller.signal,
        })
        if (controller.signal.aborted || activeRequestKeyRef.current !== currentRequestKey) return
        setItems(page.items)
        setNextCursor(page.nextCursor)
        setHasMore(page.hasMore)
      } catch (error) {
        if (controller.signal.aborted || activeRequestKeyRef.current !== currentRequestKey) return
        setItems([])
        setNextCursor(undefined)
        setHasMore(false)
        setError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!controller.signal.aborted && activeRequestKeyRef.current === currentRequestKey) {
          setLoading(false)
        }
      }
    }

    void loadInitial()
    return () => {
      controller.abort()
    }
  }, [open, requestKey, resetAuditState, sessionAgentId, selectedCategory, normalizedTypeFilter, wsUrl])

  async function loadMore() {
    if (!sessionAgentId || !nextCursor || loadingMore) return
    const currentRequestKey = activeRequestKeyRef.current
    const cursor = nextCursor
    const controller = new AbortController()
    setLoadingMore(true)
    setError(null)
    try {
      const page = await fetchSessionAuditPage(wsUrl, sessionAgentId, {
        cursor,
        limit: PAGE_LIMIT,
        categories: selectedCategory ? [selectedCategory] : undefined,
        types: normalizedTypeFilter ? [normalizedTypeFilter] : undefined,
        signal: controller.signal,
      })
      if (controller.signal.aborted || activeRequestKeyRef.current !== currentRequestKey) return
      setItems((current) => [...current, ...page.items])
      setNextCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (error) {
      if (controller.signal.aborted || activeRequestKeyRef.current !== currentRequestKey) return
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (!controller.signal.aborted && activeRequestKeyRef.current === currentRequestKey) {
        setLoadingMore(false)
      }
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-hidden sm:max-w-none md:w-[760px]" style={{ width: 'min(760px, 100vw)' }}>
        <SheetHeader className="border-b border-border/70 pr-10">
          <SheetTitle>Session Audit Log</SheetTitle>
          <SheetDescription>
            Complete persisted session audit for {sessionLabel}. This diagnostic view reads canonical session history and does not change normal Web, All, or Detailed chat visibility.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 border-b border-border/70 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
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
          <div className="space-y-3 p-4">
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
                  {visibleHasMore ? 'Load more audit rows' : 'End of audit log'}
                </Button>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

function SessionAuditRow({ item }: { item: SessionAuditEntry }) {
  const [expanded, setExpanded] = useState(false)
  const timestamp = item.entryTimestamp ?? item.wrapperTimestamp
  const typeLabel = useMemo(() => [item.wrapperType, item.conversationType, item.customType].filter(Boolean).join(' / '), [item.wrapperType, item.conversationType, item.customType])

  return (
    <article className="rounded-lg border border-border/70 bg-card/60 p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px]">{formatCategory(item.category)}</Badge>
            <Badge variant="secondary" className="text-[10px]">{item.sourceLabel}</Badge>
            {typeLabel ? <span className="font-mono text-[11px] text-muted-foreground">{typeLabel}</span> : null}
          </div>
          <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
          <p className="text-xs text-muted-foreground">{item.summary}</p>
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

      <dl className="mt-3 grid gap-2 rounded-md border border-border/50 bg-muted/20 p-2 text-[11px] sm:grid-cols-2">
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
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[11px] leading-relaxed text-foreground">{value}</pre>
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
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-1.5 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      onClick={() => void copy()}
      title={`Copy ${label.toLowerCase()}: ${value}`}
    >
      <Clipboard className="size-3" aria-hidden="true" />
      <span className="font-sans text-[10px] uppercase tracking-wide">{copied ? 'Copied' : label}</span>
      <span className="truncate">{value}</span>
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
