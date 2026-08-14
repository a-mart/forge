import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useResizableHeight } from './useResizableHeight'

const CHANGES_COLLAPSED_KEY = 'forge-source-control-changes-collapsed'
const HISTORY_COLLAPSED_KEY = 'forge-source-control-history-collapsed'

interface SourceControlExplorerProps {
  changesCount?: number
  defaultFocus?: 'changes' | 'history'
  focusSection?: 'changes' | 'history'
  onSectionFocus?: (section: 'changes' | 'history') => void
  changes: ReactNode
  history: ReactNode
}

export function SourceControlExplorer({
  changesCount,
  defaultFocus = 'changes',
  focusSection,
  onSectionFocus,
  changes,
  history,
}: SourceControlExplorerProps) {
  const [changesCollapsed, setChangesCollapsed] = useState(() => readCollapsed(CHANGES_COLLAPSED_KEY, false))
  const [historyCollapsed, setHistoryCollapsed] = useState(() => readCollapsed(HISTORY_COLLAPSED_KEY, false))

  useEffect(() => {
    if (focusSection === 'changes' && changesCollapsed) {
      setChangesCollapsed(false)
    }
    if (focusSection === 'history' && historyCollapsed) {
      setHistoryCollapsed(false)
    }
  }, [changesCollapsed, focusSection, historyCollapsed])
  const { height: changesHeight, isDragging, handleRef } = useResizableHeight({
    storageKey: 'forge-source-control-changes-height',
    defaultHeight: 220,
    minHeight: 120,
    maxHeight: 640,
  })

  useEffect(() => {
    persistCollapsed(CHANGES_COLLAPSED_KEY, changesCollapsed)
  }, [changesCollapsed])

  useEffect(() => {
    persistCollapsed(HISTORY_COLLAPSED_KEY, historyCollapsed)
  }, [historyCollapsed])

  const toggleChanges = useCallback(() => {
    const next = !changesCollapsed
    setChangesCollapsed(next)
    if (next && historyCollapsed) {
      setHistoryCollapsed(false)
    }
    if (!next) {
      queueMicrotask(() => onSectionFocus?.('changes'))
    }
  }, [changesCollapsed, historyCollapsed, onSectionFocus])

  const toggleHistory = useCallback(() => {
    const next = !historyCollapsed
    setHistoryCollapsed(next)
    if (next && changesCollapsed) {
      setChangesCollapsed(false)
    }
    if (!next) {
      queueMicrotask(() => onSectionFocus?.('history'))
    }
  }, [changesCollapsed, historyCollapsed, onSectionFocus])

  const bothExpanded = !changesCollapsed && !historyCollapsed

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="source-control-explorer">
      <ExplorerSection
        label="Changes"
        toggleName="Toggle Changes section"
        count={changesCount}
        collapsed={changesCollapsed}
        onToggle={toggleChanges}
        style={bothExpanded ? { height: changesHeight } : changesCollapsed ? undefined : { flex: 1 }}
        className={changesCollapsed ? 'shrink-0' : bothExpanded ? 'shrink-0' : 'min-h-0 flex-1'}
      >
        {changes}
      </ExplorerSection>

      {bothExpanded ? (
        <div
          ref={handleRef}
          className={cn(
            'group relative h-1.5 shrink-0 cursor-row-resize',
            isDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border',
          )}
        >
          <div className="absolute left-1/2 top-1/2 h-0.5 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
        </div>
      ) : null}

      <ExplorerSection
        label="History"
        toggleName="Toggle History section"
        collapsed={historyCollapsed}
        onToggle={toggleHistory}
        className={historyCollapsed ? 'shrink-0' : 'min-h-0 flex-1'}
      >
        {history}
      </ExplorerSection>
    </div>
  )
}

function ExplorerSection({
  label,
  toggleName,
  count,
  collapsed,
  onToggle,
  className,
  style,
  children,
}: {
  label: string
  toggleName: string
  count?: number
  collapsed: boolean
  onToggle: () => void
  className?: string
  style?: { height?: number; flex?: number }
  children: ReactNode
}) {
  return (
    <section className={cn('flex min-h-0 flex-col', className)} style={style} aria-label={label}>
      <button
        type="button"
        className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 bg-card/80 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        onClick={onToggle}
        aria-label={toggleName}
        aria-expanded={!collapsed}
      >
        <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', collapsed && '-rotate-90')} />
        <span aria-hidden="true">{label}</span>
        {typeof count === 'number' ? (
          <span className="ml-auto inline-flex min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium normal-case text-muted-foreground" aria-hidden="true">
            {count}
          </span>
        ) : null}
      </button>
      {!collapsed ? <div className="min-h-0 flex-1">{children}</div> : null}
    </section>
  )
}

function readCollapsed(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  const storage = globalThis.localStorage
  if (!storage || typeof storage.getItem !== 'function') {
    return fallback
  }

  const stored = storage.getItem(key)
  if (stored === 'true') return true
  if (stored === 'false') return false
  return fallback
}

function persistCollapsed(key: string, collapsed: boolean): void {
  const storage = globalThis.localStorage
  if (!storage || typeof storage.setItem !== 'function') {
    return
  }

  storage.setItem(key, String(collapsed))
}
