import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Columns2,
  LayoutGrid,
  MonitorPlay,
  RefreshCw,
  Settings,
  WifiOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PlaywrightSummaryBar } from './PlaywrightSummaryBar'
import {
  PlaywrightFilters,
  type PlaywrightDashboardFiltersState,
} from './PlaywrightFilters'
import { PlaywrightSessionCard } from './PlaywrightSessionCard'
import { PlaywrightMosaicTile } from './PlaywrightMosaicTile'
import { PlaywrightLivePreviewPane } from './PlaywrightLivePreviewPane'
import {
  closePlaywrightSession,
  fetchPlaywrightSnapshot,
  triggerPlaywrightRescan,
} from './playwright-api'
import { cn } from '@/lib/utils'
import { REPO_ROOT_WORKTREE_KEY, REPO_ROOT_WORKTREE_LABEL } from './playwright-constants'
import type { PlaywrightViewMode } from '@/hooks/index-page/use-route-state'
import type { WorktreeOption } from './PlaywrightFilters'
import type {
  PlaywrightDiscoveredSession,
  PlaywrightDiscoverySummary,
  PlaywrightDiscoverySnapshot,
} from '@middleman/protocol'

export interface PlaywrightDashboardViewProps {
  wsUrl: string
  snapshot: PlaywrightDiscoverySnapshot | null
  onSnapshotUpdate: (snapshot: PlaywrightDiscoverySnapshot) => void
  onOpenSettings: () => void
  onBack: () => void
  /** Currently selected session from route state */
  selectedSessionId?: string | null
  /** Current view mode from route state */
  viewMode?: PlaywrightViewMode
  /** Callback when session selection or view mode changes (updates route state) */
  onViewStateChange?: (sessionId: string | null, mode: PlaywrightViewMode) => void
}

const INITIAL_FILTERS: PlaywrightDashboardFiltersState = {
  search: '',
  status: 'all',
  worktree: 'all',
  onlyCorrelated: false,
  onlyPreferred: false,
  showInactive: false,
  showStale: false,
}

export function PlaywrightDashboardView({
  wsUrl,
  snapshot,
  onSnapshotUpdate,
  onOpenSettings,
  onBack,
  selectedSessionId = null,
  viewMode = 'tiles',
  onViewStateChange,
}: PlaywrightDashboardViewProps) {
  const [filters, setFilters] = useState<PlaywrightDashboardFiltersState>(INITIAL_FILTERS)
  const [isRescanning, setIsRescanning] = useState(false)
  const [rescanError, setRescanError] = useState<string | null>(null)

  // --- HTTP bootstrap fallback ---
  const [httpFetchState, setHttpFetchState] = useState<'idle' | 'fetching' | 'failed'>('idle')
  const [httpFetchError, setHttpFetchError] = useState<string | null>(null)
  const bootstrapAttemptedRef = useRef(false)

  useEffect(() => {
    if (snapshot || bootstrapAttemptedRef.current) return
    bootstrapAttemptedRef.current = true
    setHttpFetchState('fetching')
    setHttpFetchError(null)

    void fetchPlaywrightSnapshot(wsUrl)
      .then((fetched) => {
        setHttpFetchState('idle')
        onSnapshotUpdate(fetched)
      })
      .catch((err) => {
        setHttpFetchState('failed')
        setHttpFetchError(err instanceof Error ? err.message : 'Failed to load dashboard data')
      })
  }, [snapshot, wsUrl, onSnapshotUpdate])

  // ────────────────────────────────────────────────────────────────────────
  // Data derivation (worktree options, filtered sessions, hidden counts)
  //
  // NOTE: If another worker is modifying data-derivation logic (duplicate
  // filtering, worktree option generation), coordinate merges carefully.
  // The rendering code below consumes these without coupling to internals.
  // ────────────────────────────────────────────────────────────────────────

  // Derive worktree options from snapshot.
  // Uses path-based keys for stability (avoids same-name collisions across
  // repos) and includes a REPO_ROOT sentinel for sessions without a worktree.
  const worktreeOptions = useMemo((): WorktreeOption[] => {
    if (!snapshot?.sessions) return []
    const seen = new Map<string, WorktreeOption>()
    let hasRepoRoot = false
    for (const session of snapshot.sessions) {
      if (session.worktreeName) {
        // Key on the worktree path for stability; fall back to name if path is null
        const key = session.worktreePath ?? session.worktreeName
        if (!seen.has(key)) {
          seen.set(key, { key, label: session.worktreeName })
        }
      } else {
        hasRepoRoot = true
      }
    }
    const opts = Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label))
    if (hasRepoRoot) {
      opts.unshift({ key: REPO_ROOT_WORKTREE_KEY, label: REPO_ROOT_WORKTREE_LABEL })
    }
    return opts
  }, [snapshot?.sessions])

  // Apply filters to sessions.
  // In tiles mode we also hide non-preferred duplicates by default (unless
  // the user has explicitly toggled onlyPreferred off after turning it on,
  // or has an active search that might want to match a dup).
  const filteredSessions = useMemo(() => {
    if (!snapshot?.sessions) return []

    let sessions = snapshot.sessions

    if (filters.status !== 'all') {
      sessions = sessions.filter((s) => s.liveness === filters.status)
    } else {
      sessions = sessions.filter((s) => {
        if (s.liveness === 'inactive' && !filters.showInactive) return false
        if (s.liveness === 'stale' && !filters.showStale) return false
        return true
      })
    }

    if (filters.worktree !== 'all') {
      if (filters.worktree === REPO_ROOT_WORKTREE_KEY) {
        sessions = sessions.filter((s) => !s.worktreeName)
      } else {
        // Match on worktree path (stable key) OR name (fallback)
        sessions = sessions.filter(
          (s) => s.worktreePath === filters.worktree || s.worktreeName === filters.worktree,
        )
      }
    }

    if (filters.onlyCorrelated) {
      sessions = sessions.filter((s) => s.correlation.confidence !== 'none')
    }

    if (filters.onlyPreferred) {
      sessions = sessions.filter((s) => s.preferredInDuplicateGroup)
    }

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

  // In tiles mode, hide non-preferred duplicates automatically (in addition
  // to whatever the explicit filters produce).  This keeps the mosaic clean
  // without requiring the user to toggle a filter.
  const displaySessions = useMemo(() => {
    if (viewMode !== 'tiles') return filteredSessions
    // If user has explicitly enabled onlyPreferred, it's already applied
    if (filters.onlyPreferred) return filteredSessions
    // Auto-dedup for tiles: keep only preferred in each duplicate group
    return filteredSessions.filter((s) => s.preferredInDuplicateGroup)
  }, [filteredSessions, viewMode, filters.onlyPreferred])

  // Compute hidden counts
  const hiddenCounts = useMemo(() => {
    if (!snapshot?.sessions || filters.status !== 'all') return { inactive: 0, stale: 0, total: 0 }
    let inactive = 0
    let stale = 0
    for (const s of snapshot.sessions) {
      if (s.liveness === 'inactive' && !filters.showInactive) inactive++
      if (s.liveness === 'stale' && !filters.showStale) stale++
    }
    return { inactive, stale, total: inactive + stale }
  }, [snapshot?.sessions, filters.status, filters.showInactive, filters.showStale])

  // Resolve the selected session object
  const selectedSession: PlaywrightDiscoveredSession | null = useMemo(() => {
    if (!selectedSessionId || !snapshot?.sessions) return null
    return snapshot.sessions.find((s) => s.id === selectedSessionId) ?? null
  }, [selectedSessionId, snapshot?.sessions])

  // Auto-select: if exactly one active session exists and none is selected, auto-select it.
  // Only fires once per dashboard mount (not after deliberate deselection).
  const autoSelectAttemptedRef = useRef(false)
  const hadSelectionRef = useRef(!!selectedSessionId)

  // Track whether user has ever had a selection (deliberate deselection should not re-trigger)
  useEffect(() => {
    if (selectedSessionId) hadSelectionRef.current = true
  }, [selectedSessionId])

  useEffect(() => {
    if (autoSelectAttemptedRef.current || selectedSessionId || hadSelectionRef.current || !snapshot?.sessions) return
    autoSelectAttemptedRef.current = true

    const activeSessions = snapshot.sessions.filter((s) => s.liveness === 'active')
    if (activeSessions.length === 1) {
      onViewStateChange?.(activeSessions[0].id, viewMode)
    }
  }, [snapshot?.sessions, selectedSessionId, viewMode, onViewStateChange])

  // --- Callbacks ---

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      // In tiles mode, clicking a session drills into split view
      if (viewMode === 'tiles') {
        onViewStateChange?.(sessionId, 'split')
      } else {
        onViewStateChange?.(sessionId, viewMode)
      }
    },
    [viewMode, onViewStateChange],
  )

  const handleDeselectSession = useCallback(() => {
    onViewStateChange?.(null, 'tiles')
  }, [onViewStateChange])

  // Context-aware back: in split/focus mode, return to tiles first.
  // Only from tiles mode does back navigate out of the dashboard entirely.
  const handleBack = useCallback(() => {
    if (viewMode === 'split' || viewMode === 'focus') {
      onViewStateChange?.(null, 'tiles')
    } else {
      onBack()
    }
  }, [viewMode, onViewStateChange, onBack])

  const handleToggleFocusMode = useCallback(() => {
    const newMode: PlaywrightViewMode = viewMode === 'focus' ? 'split' : 'focus'
    onViewStateChange?.(selectedSessionId ?? null, newMode)
  }, [viewMode, selectedSessionId, onViewStateChange])

  const handleEnterFocusMode = useCallback(
    (sessionId: string) => {
      onViewStateChange?.(sessionId, 'focus')
    },
    [onViewStateChange],
  )

  const handleExitFocusMode = useCallback(() => {
    onViewStateChange?.(selectedSessionId ?? null, 'split')
  }, [selectedSessionId, onViewStateChange])

  const handleCloseSession = useCallback(
    async (sessionId: string) => {
      const result = await closePlaywrightSession(wsUrl, sessionId)
      onSnapshotUpdate(result.snapshot)
      // If the closed session was selected, deselect it
      if (selectedSessionId === sessionId) {
        onViewStateChange?.(null, 'tiles')
      }
    },
    [wsUrl, onSnapshotUpdate, selectedSessionId, onViewStateChange],
  )

  const handleRescan = useCallback(() => {
    if (isRescanning) return
    setIsRescanning(true)
    setRescanError(null)

    void triggerPlaywrightRescan(wsUrl)
      .then((rescanSnapshot) => {
        onSnapshotUpdate(rescanSnapshot)
      })
      .catch((err) => {
        setRescanError(err instanceof Error ? err.message : 'Rescan failed')
      })
      .finally(() => {
        setIsRescanning(false)
      })
  }, [wsUrl, isRescanning, onSnapshotUpdate])

  const handleRetryBootstrap = useCallback(() => {
    setHttpFetchState('fetching')
    setHttpFetchError(null)

    void fetchPlaywrightSnapshot(wsUrl)
      .then((fetched) => {
        setHttpFetchState('idle')
        onSnapshotUpdate(fetched)
      })
      .catch((err) => {
        setHttpFetchState('failed')
        setHttpFetchError(err instanceof Error ? err.message : 'Failed to load dashboard data')
      })
  }, [wsUrl, onSnapshotUpdate])

  // Clear rescan error after some time
  useEffect(() => {
    if (!rescanError) return
    const timer = setTimeout(() => setRescanError(null), 8000)
    return () => clearTimeout(timer)
  }, [rescanError])

  // --- Render states ---

  // Service unavailable / HTTP bootstrap failed
  if (!snapshot && httpFetchState === 'failed') {
    return (
      <div className="flex h-full flex-col">
        <DashboardHeader onBack={onBack} onOpenSettings={onOpenSettings} viewMode={viewMode} />
        <div className="flex flex-1 items-center justify-center p-8">
          <Card className="max-w-md w-full border-destructive/30">
            <CardContent className="flex flex-col items-center gap-4 p-6 text-center">
              <WifiOff className="size-12 text-destructive/50" />
              <div className="space-y-2">
                <h3 className="text-lg font-semibold">Dashboard Unavailable</h3>
                <p className="text-sm text-muted-foreground">
                  {httpFetchError ?? 'Could not load Playwright dashboard data from the backend.'}
                </p>
              </div>
              <Button onClick={handleRetryBootstrap} variant="outline" size="sm">
                Retry
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // Loading / no snapshot yet
  if (!snapshot) {
    return (
      <div className="flex h-full flex-col">
        <DashboardHeader onBack={onBack} onOpenSettings={onOpenSettings} viewMode={viewMode} />
        <div className="flex-1 p-4 space-y-4">
          <Skeleton className="h-8 w-full" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[16/10]" />
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
        <DashboardHeader onBack={onBack} onOpenSettings={onOpenSettings} viewMode={viewMode} />
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
        <DashboardHeader onBack={onBack} onOpenSettings={onOpenSettings} viewMode={viewMode} />
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

  // Empty state
  const isEmpty = snapshot.sessions.length === 0
  const isFocusMode = viewMode === 'focus' && !!selectedSession
  const isTilesMode = viewMode === 'tiles'
  const showDiscovery = !isFocusMode

  // ────────────────────────────────────────────────────────────────────────
  // Tiles mode — mosaic of live-preview tiles
  // ────────────────────────────────────────────────────────────────────────
  if (isTilesMode && showDiscovery) {
    return (
      <div className="flex h-full flex-col min-h-0">
        <DashboardHeader
          onBack={handleBack}
          onOpenSettings={onOpenSettings}
          serviceStatus={snapshot.serviceStatus}
          viewMode={viewMode}
          onViewModeChange={(mode) => onViewStateChange?.(selectedSessionId ?? null, mode)}
          summary={snapshot.summary}
          lastScanCompletedAt={snapshot.lastScanCompletedAt}
          onRescan={handleRescan}
          isRescanning={isRescanning}
        />

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-3">
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

            {/* Filters */}
            <PlaywrightFilters
              filters={filters}
              worktreeOptions={worktreeOptions}
              onFiltersChange={setFilters}
              onRescan={handleRescan}
              isRescanning={isRescanning}
              compact
            />

            {/* Hidden sessions hint */}
            {hiddenCounts.total > 0 && displaySessions.length > 0 ? (
              <HiddenSessionsHint
                inactiveCount={hiddenCounts.inactive}
                staleCount={hiddenCounts.stale}
                onShowInactive={() => setFilters((f) => ({ ...f, showInactive: true }))}
                onShowStale={() => setFilters((f) => ({ ...f, showStale: true }))}
              />
            ) : null}

            {/* Content */}
            {isEmpty ? (
              <EmptyState
                rootsScanned={snapshot.rootsScanned}
                onOpenSettings={onOpenSettings}
              />
            ) : displaySessions.length === 0 ? (
              <FilteredEmptyState
                onClearFilters={() => setFilters(INITIAL_FILTERS)}
                hiddenInactive={hiddenCounts.inactive}
                hiddenStale={hiddenCounts.stale}
                onShowInactive={() => setFilters((f) => ({ ...f, showInactive: true }))}
                onShowStale={() => setFilters((f) => ({ ...f, showStale: true }))}
              />
            ) : (
              <MosaicGrid
                wsUrl={wsUrl}
                sessions={displaySessions}
                selectedSessionId={selectedSessionId}
                onSelectSession={handleSelectSession}
                onFocusSession={handleEnterFocusMode}
                onCloseSession={handleCloseSession}
              />
            )}
          </div>
        </ScrollArea>
      </div>
    )
  }

  // ────────────────────────────────────────────────────────────────────────
  // Split / Focus modes — existing layout
  // ────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col min-h-0">
      {/* Dashboard header — hidden in focus mode */}
      {showDiscovery ? (
        <DashboardHeader
          onBack={handleBack}
          onOpenSettings={onOpenSettings}
          serviceStatus={snapshot.serviceStatus}
          viewMode={viewMode}
          onViewModeChange={(mode) => onViewStateChange?.(selectedSessionId ?? null, mode)}
          summary={snapshot.summary}
          lastScanCompletedAt={snapshot.lastScanCompletedAt}
          onRescan={handleRescan}
          isRescanning={isRescanning}
        />
      ) : null}

      <div className={cn(
        'flex flex-1 min-h-0',
        showDiscovery && selectedSession ? 'divide-x' : '',
      )}>
        {/* Left: Discovery pane — hidden in focus mode */}
        {showDiscovery ? (
          <div className={cn(
            'flex flex-col min-h-0',
            selectedSession ? 'w-[400px] min-w-[320px] shrink-0' : 'flex-1',
          )}>
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

                {/* Summary bar - compact when split view has preview */}
                {!selectedSession ? (
                  <PlaywrightSummaryBar
                    summary={snapshot.summary}
                    lastScanCompletedAt={snapshot.lastScanCompletedAt}
                  />
                ) : null}

                {/* Filters */}
                <PlaywrightFilters
                  filters={filters}
                  worktreeOptions={worktreeOptions}
                  onFiltersChange={setFilters}
                  onRescan={handleRescan}
                  isRescanning={isRescanning}
                />

                {/* Hidden sessions hint */}
                {hiddenCounts.total > 0 && filteredSessions.length > 0 ? (
                  <HiddenSessionsHint
                    inactiveCount={hiddenCounts.inactive}
                    staleCount={hiddenCounts.stale}
                    onShowInactive={() => setFilters((f) => ({ ...f, showInactive: true }))}
                    onShowStale={() => setFilters((f) => ({ ...f, showStale: true }))}
                  />
                ) : null}

                {/* Content */}
                {isEmpty ? (
                  <EmptyState
                    rootsScanned={snapshot.rootsScanned}
                    onOpenSettings={onOpenSettings}
                  />
                ) : filteredSessions.length === 0 ? (
                  <FilteredEmptyState
                    onClearFilters={() => setFilters(INITIAL_FILTERS)}
                    hiddenInactive={hiddenCounts.inactive}
                    hiddenStale={hiddenCounts.stale}
                    onShowInactive={() => setFilters((f) => ({ ...f, showInactive: true }))}
                    onShowStale={() => setFilters((f) => ({ ...f, showStale: true }))}
                  />
                ) : (
                  <SessionList
                    sessions={filteredSessions}
                    selectedSessionId={selectedSessionId}
                    compact={!!selectedSession}
                    onSelectSession={handleSelectSession}
                    onFocusSession={handleEnterFocusMode}
                    onCloseSession={handleCloseSession}
                  />
                )}
              </div>
            </ScrollArea>
          </div>
        ) : null}

        {/* Right: Preview pane — stable single instance, expands to fill in focus mode */}
        {selectedSession ? (
          <div className="flex-1 min-w-0 min-h-0">
            <PlaywrightLivePreviewPane
              wsUrl={wsUrl}
              session={selectedSession}
              isFocusMode={isFocusMode}
              onToggleFocusMode={handleToggleFocusMode}
              onClose={handleDeselectSession}
              onBack={isFocusMode ? handleExitFocusMode : undefined}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

function DashboardHeader({
  onBack,
  onOpenSettings,
  serviceStatus,
  viewMode,
  onViewModeChange,
  summary,
  lastScanCompletedAt,
  onRescan,
  isRescanning,
}: {
  onBack: () => void
  onOpenSettings: () => void
  serviceStatus?: string
  viewMode?: PlaywrightViewMode
  onViewModeChange?: (mode: PlaywrightViewMode) => void
  summary?: PlaywrightDiscoverySummary
  lastScanCompletedAt?: string | null
  onRescan?: () => void
  isRescanning?: boolean
}) {
  return (
    <div className="flex h-[44px] shrink-0 items-center gap-2 border-b px-3">
      <Button variant="ghost" size="sm" onClick={onBack} className="h-7 w-7 p-0" title="Back to chat">
        <ArrowLeft className="size-3.5" />
      </Button>
      <MonitorPlay className="size-4 text-muted-foreground" />
      <span className="text-sm font-semibold mr-1">Browsers</span>

      {serviceStatus === 'scanning' ? (
        <span className="text-[11px] text-muted-foreground animate-pulse">Scanning…</span>
      ) : null}

      {/* Inline compact summary */}
      {summary ? (
        <PlaywrightSummaryBar
          summary={summary}
          lastScanCompletedAt={lastScanCompletedAt ?? null}
          inline
        />
      ) : null}

      <div className="flex-1" />

      {/* Rescan button */}
      {onRescan ? (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={onRescan}
                disabled={isRescanning}
              >
                <RefreshCw className={cn('size-3.5', isRescanning && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Rescan</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}

      {/* View mode toggle buttons */}
      {onViewModeChange ? (
        <TooltipProvider delayDuration={300}>
          <div className="flex items-center gap-0.5 rounded-md border p-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={viewMode === 'tiles' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => onViewModeChange('tiles')}
                >
                  <LayoutGrid className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Grid view</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={viewMode === 'split' || viewMode === 'focus' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => onViewModeChange('split')}
                >
                  <Columns2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Split view</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      ) : null}

      <Button variant="ghost" size="sm" onClick={onOpenSettings} className="h-7 w-7 p-0" title="Settings">
        <Settings className="size-3.5" />
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

function FilteredEmptyState({
  onClearFilters,
  hiddenInactive,
  hiddenStale,
  onShowInactive,
  onShowStale,
}: {
  onClearFilters: () => void
  hiddenInactive: number
  hiddenStale: number
  onShowInactive: () => void
  onShowStale: () => void
}) {
  const hiddenTotal = hiddenInactive + hiddenStale
  const hiddenParts: string[] = []
  if (hiddenInactive > 0) hiddenParts.push(`${hiddenInactive} inactive`)
  if (hiddenStale > 0) hiddenParts.push(`${hiddenStale} stale`)

  return (
    <Card className="mx-auto max-w-md">
      <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          No sessions match the current filters.
        </p>
        {hiddenTotal > 0 ? (
          <p className="text-xs text-muted-foreground/80">
            {hiddenParts.join(' and ')} session{hiddenTotal !== 1 ? 's are' : ' is'} hidden by default.{' '}
            {hiddenInactive > 0 ? (
              <button
                type="button"
                onClick={onShowInactive}
                className="text-primary hover:underline"
              >
                Show inactive
              </button>
            ) : null}
            {hiddenInactive > 0 && hiddenStale > 0 ? ' · ' : null}
            {hiddenStale > 0 ? (
              <button
                type="button"
                onClick={onShowStale}
                className="text-primary hover:underline"
              >
                Show stale
              </button>
            ) : null}
          </p>
        ) : null}
        <Button onClick={onClearFilters} variant="outline" size="sm">
          Clear Filters
        </Button>
      </CardContent>
    </Card>
  )
}

function HiddenSessionsHint({
  inactiveCount,
  staleCount,
  onShowInactive,
  onShowStale,
}: {
  inactiveCount: number
  staleCount: number
  onShowInactive: () => void
  onShowStale: () => void
}) {
  const parts: string[] = []
  if (inactiveCount > 0) parts.push(`${inactiveCount} inactive`)
  if (staleCount > 0) parts.push(`${staleCount} stale`)

  return (
    <div className="text-center text-xs text-muted-foreground/70">
      {parts.join(' and ')} session{inactiveCount + staleCount !== 1 ? 's' : ''} hidden.{' '}
      {inactiveCount > 0 ? (
        <button
          type="button"
          onClick={onShowInactive}
          className="text-primary/70 hover:text-primary hover:underline"
        >
          Show inactive
        </button>
      ) : null}
      {inactiveCount > 0 && staleCount > 0 ? ' · ' : null}
      {staleCount > 0 ? (
        <button
          type="button"
          onClick={onShowStale}
          className="text-primary/70 hover:text-primary hover:underline"
        >
          Show stale
        </button>
      ) : null}
    </div>
  )
}

function MosaicGrid({
  wsUrl,
  sessions,
  selectedSessionId,
  onSelectSession,
  onFocusSession,
  onCloseSession,
}: {
  wsUrl: string
  sessions: PlaywrightDiscoveredSession[]
  selectedSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onFocusSession: (sessionId: string) => void
  onCloseSession: (sessionId: string) => Promise<void>
}) {
  return (
    <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
      {sessions.map((session) => (
        <PlaywrightMosaicTile
          key={session.id}
          wsUrl={wsUrl}
          session={session}
          selected={session.id === selectedSessionId}
          onSelect={() => onSelectSession(session.id)}
          onFocus={() => onFocusSession(session.id)}
          onClose={() => onCloseSession(session.id)}
        />
      ))}
    </div>
  )
}

function SessionList({
  sessions,
  selectedSessionId,
  compact,
  onSelectSession,
  onFocusSession,
  onCloseSession,
}: {
  sessions: PlaywrightDiscoveredSession[]
  selectedSessionId: string | null
  compact: boolean
  onSelectSession: (sessionId: string) => void
  onFocusSession: (sessionId: string) => void
  onCloseSession: (sessionId: string) => Promise<void>
}) {
  if (compact) {
    // Compact list view for split mode left pane
    return (
      <div className="space-y-1.5">
        {sessions.map((session) => (
          <PlaywrightSessionCard
            key={session.id}
            session={session}
            selected={session.id === selectedSessionId}
            compact
            onSelect={() => onSelectSession(session.id)}
            onFocus={() => onFocusSession(session.id)}
            onClose={() => onCloseSession(session.id)}
          />
        ))}
      </div>
    )
  }

  // Full grid view
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {sessions.map((session) => (
        <PlaywrightSessionCard
          key={session.id}
          session={session}
          selected={session.id === selectedSessionId}
          onSelect={() => onSelectSession(session.id)}
          onFocus={() => onFocusSession(session.id)}
          onClose={() => onCloseSession(session.id)}
        />
      ))}
    </div>
  )
}
