import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  MonitorPlay,
  Settings,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { PlaywrightSummaryBar } from './PlaywrightSummaryBar'
import {
  PlaywrightFilters,
  type PlaywrightDashboardFiltersState,
} from './PlaywrightFilters'
import { PlaywrightSessionCard } from './PlaywrightSessionCard'
import { triggerPlaywrightRescan } from './playwright-api'
import type {
  PlaywrightDiscoveredSession,
  PlaywrightDiscoverySnapshot,
} from '@middleman/protocol'

export interface PlaywrightDashboardViewProps {
  wsUrl: string
  connected: boolean // kept for future use (disconnected banners etc.)
  snapshot: PlaywrightDiscoverySnapshot | null
  onOpenSettings: () => void
  onBack: () => void
}

const INITIAL_FILTERS: PlaywrightDashboardFiltersState = {
  search: '',
  status: 'all',
  worktree: 'all',
  onlyCorrelated: false,
  onlyPreferred: false,
}

export function PlaywrightDashboardView({
  wsUrl,
  connected: _connected,
  snapshot,
  onOpenSettings,
  onBack,
}: PlaywrightDashboardViewProps) {
  const [filters, setFilters] = useState<PlaywrightDashboardFiltersState>(INITIAL_FILTERS)
  const [isRescanning, setIsRescanning] = useState(false)
  const [rescanError, setRescanError] = useState<string | null>(null)

  // Derive worktree options from snapshot
  const worktreeOptions = useMemo(() => {
    if (!snapshot?.sessions) return []
    const unique = new Set<string>()
    for (const session of snapshot.sessions) {
      if (session.worktreeName) {
        unique.add(session.worktreeName)
      }
    }
    return Array.from(unique).sort()
  }, [snapshot?.sessions])

  // Apply filters to sessions
  const filteredSessions = useMemo(() => {
    if (!snapshot?.sessions) return []

    let sessions = snapshot.sessions

    // Status filter
    if (filters.status !== 'all') {
      sessions = sessions.filter((s) => s.liveness === filters.status)
    }

    // Worktree filter
    if (filters.worktree !== 'all') {
      sessions = sessions.filter((s) => s.worktreeName === filters.worktree)
    }

    // Correlated only
    if (filters.onlyCorrelated) {
      sessions = sessions.filter((s) => s.correlation.confidence !== 'none')
    }

    // Preferred only
    if (filters.onlyPreferred) {
      sessions = sessions.filter((s) => s.preferredInDuplicateGroup)
    }

    // Search
    if (filters.search.trim()) {
      const term = filters.search.trim().toLowerCase()
      sessions = sessions.filter((s) =>
        s.sessionName.toLowerCase().includes(term) ||
        s.rootPath.toLowerCase().includes(term) ||
        (s.worktreeName?.toLowerCase().includes(term) ?? false) ||
        (s.correlation.matchedAgentDisplayName?.toLowerCase().includes(term) ?? false) ||
        (s.correlation.matchedAgentId?.toLowerCase().includes(term) ?? false) ||
        s.sessionFilePath.toLowerCase().includes(term),
      )
    }

    return sessions
  }, [snapshot?.sessions, filters])

  // Handle rescan
  const handleRescan = useCallback(() => {
    if (isRescanning) return
    setIsRescanning(true)
    setRescanError(null)

    void triggerPlaywrightRescan(wsUrl)
      .catch((err) => {
        setRescanError(err instanceof Error ? err.message : 'Rescan failed')
      })
      .finally(() => {
        setIsRescanning(false)
      })
  }, [wsUrl, isRescanning])

  // Clear rescan error after some time
  useEffect(() => {
    if (!rescanError) return
    const timer = setTimeout(() => setRescanError(null), 8000)
    return () => clearTimeout(timer)
  }, [rescanError])

  // --- Render states ---

  // Loading / no snapshot yet
  if (!snapshot) {
    return (
      <div className="flex h-full flex-col">
        <DashboardHeader onBack={onBack} onOpenSettings={onOpenSettings} />
        <div className="flex-1 p-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 flex-1 min-w-[120px]" />
            ))}
          </div>
          <Skeleton className="h-8 w-full" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Feature disabled
  if (snapshot.serviceStatus === 'disabled') {
    return (
      <div className="flex h-full flex-col">
        <DashboardHeader onBack={onBack} onOpenSettings={onOpenSettings} />
        <div className="flex flex-1 items-center justify-center p-8">
          <Card className="max-w-md w-full">
            <CardContent className="flex flex-col items-center gap-4 p-6 text-center">
              <MonitorPlay className="size-12 text-muted-foreground/40" />
              <div className="space-y-2">
                <h3 className="text-lg font-semibold">Playwright Dashboard is disabled</h3>
                <p className="text-sm text-muted-foreground">
                  {snapshot.settings.source === 'env'
                    ? 'This feature is forced off by the MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED environment variable.'
                    : 'Enable the Playwright Dashboard in Settings to discover browser sessions across your worktrees.'}
                </p>
              </div>
              {snapshot.settings.source !== 'env' ? (
                <Button onClick={onOpenSettings} variant="outline" size="sm">
                  <Settings className="size-3.5 mr-1.5" />
                  Open Settings
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // Error state
  if (snapshot.serviceStatus === 'error' && snapshot.lastError) {
    return (
      <div className="flex h-full flex-col">
        <DashboardHeader onBack={onBack} onOpenSettings={onOpenSettings} />
        <div className="flex flex-1 items-center justify-center p-8">
          <Card className="max-w-md w-full border-destructive/30">
            <CardContent className="flex flex-col items-center gap-4 p-6 text-center">
              <AlertTriangle className="size-12 text-destructive/60" />
              <div className="space-y-2">
                <h3 className="text-lg font-semibold">Discovery Error</h3>
                <p className="text-sm text-muted-foreground">{snapshot.lastError}</p>
              </div>
              <Button onClick={handleRescan} variant="outline" size="sm" disabled={isRescanning}>
                Retry Scan
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // Empty state (ready but no sessions)
  const isEmpty = snapshot.sessions.length === 0

  return (
    <div className="flex h-full flex-col min-h-0">
      <DashboardHeader
        onBack={onBack}
        onOpenSettings={onOpenSettings}
        serviceStatus={snapshot.serviceStatus}
      />

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Rescan error banner */}
          {rescanError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Rescan failed: {rescanError}
            </div>
          ) : null}

          {/* Snapshot-level warnings */}
          {snapshot.warnings.length > 0 ? (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400 space-y-1">
              {snapshot.warnings.map((w, i) => (
                <p key={i} className="flex items-start gap-1.5">
                  <AlertTriangle className="size-3 shrink-0 mt-0.5" />
                  {w}
                </p>
              ))}
            </div>
          ) : null}

          {/* Summary bar */}
          <PlaywrightSummaryBar
            summary={snapshot.summary}
            lastScanCompletedAt={snapshot.lastScanCompletedAt}
          />

          {/* Filters */}
          <PlaywrightFilters
            filters={filters}
            worktreeOptions={worktreeOptions}
            onFiltersChange={setFilters}
            onRescan={handleRescan}
            isRescanning={isRescanning}
          />

          {/* Content */}
          {isEmpty ? (
            <EmptyState
              rootsScanned={snapshot.rootsScanned}
              onOpenSettings={onOpenSettings}
            />
          ) : filteredSessions.length === 0 ? (
            <FilteredEmptyState onClearFilters={() => setFilters(INITIAL_FILTERS)} />
          ) : (
            <SessionGrid sessions={filteredSessions} />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

// --- Sub-components ---

function DashboardHeader({
  onBack,
  onOpenSettings,
  serviceStatus,
}: {
  onBack: () => void
  onOpenSettings: () => void
  serviceStatus?: string
}) {
  return (
    <div className="flex h-[62px] shrink-0 items-center gap-3 border-b px-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="h-8 w-8 p-0" title="Back to chat">
        <ArrowLeft className="size-4" />
      </Button>
      <MonitorPlay className="size-5 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <h1 className="text-sm font-semibold">Playwright Dashboard</h1>
        <p className="text-[11px] text-muted-foreground truncate">
          Discover browser sessions across repo roots and worktrees
        </p>
      </div>
      {serviceStatus === 'scanning' ? (
        <span className="text-[11px] text-muted-foreground animate-pulse">Scanning…</span>
      ) : null}
      <Button variant="ghost" size="sm" onClick={onOpenSettings} className="h-8 w-8 p-0" title="Settings">
        <Settings className="size-4" />
      </Button>
    </div>
  )
}

function EmptyState({
  rootsScanned,
  onOpenSettings,
}: {
  rootsScanned: string[]
  onOpenSettings: () => void
}) {
  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="flex flex-col items-center gap-4 p-6 text-center">
        <MonitorPlay className="size-12 text-muted-foreground/30" />
        <div className="space-y-2">
          <h3 className="text-base font-semibold">No Playwright sessions found</h3>
          <p className="text-sm text-muted-foreground">
            {rootsScanned.length === 0
              ? 'No scan roots are configured. Add scan roots in Settings or ensure agent working directories are set.'
              : `Scanned ${rootsScanned.length} root${rootsScanned.length !== 1 ? 's' : ''} but found no .playwright-cli session files.`}
          </p>
        </div>
        <Button onClick={onOpenSettings} variant="outline" size="sm">
          <Settings className="size-3.5 mr-1.5" />
          Configure Scan Roots
        </Button>
      </CardContent>
    </Card>
  )
}

function FilteredEmptyState({ onClearFilters }: { onClearFilters: () => void }) {
  return (
    <Card className="mx-auto max-w-md">
      <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          No sessions match the current filters.
        </p>
        <Button onClick={onClearFilters} variant="outline" size="sm">
          Clear Filters
        </Button>
      </CardContent>
    </Card>
  )
}

function SessionGrid({ sessions }: { sessions: PlaywrightDiscoveredSession[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {sessions.map((session) => (
        <PlaywrightSessionCard key={session.id} session={session} />
      ))}
    </div>
  )
}
