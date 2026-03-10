import { useState } from 'react'
import {
  AlertCircle,
  Clock,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Globe,
  Image,
  Link2,
  Loader2,
  Maximize2,
  MonitorPlay,
  Network,
  Power,
  Terminal,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { PlaywrightDiscoveredSession } from '@middleman/protocol'

interface PlaywrightSessionCardProps {
  session: PlaywrightDiscoveredSession
  selected?: boolean
  compact?: boolean
  onSelect?: () => void
  onFocus?: () => void
  onClose?: () => Promise<void>
}

/** Determine if a session is previewable using backend-provided truth */
function isSessionPreviewable(session: PlaywrightDiscoveredSession): boolean {
  // Use backend previewability when available
  if (session.previewability) {
    return session.previewability.previewable
  }
  // Fallback: liveness heuristic only if backend hasn't enriched the session
  return session.liveness === 'active'
}

const LIVENESS_BADGE: Record<
  string,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  active: { label: 'Active', variant: 'default' },
  inactive: { label: 'Inactive', variant: 'secondary' },
  stale: { label: 'Stale', variant: 'outline' },
  error: { label: 'Error', variant: 'destructive' },
}

const CONFIDENCE_BADGE: Record<string, { label: string; className: string }> = {
  high: { label: 'High', className: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20' },
  medium: { label: 'Medium', className: 'text-amber-600 bg-amber-500/10 border-amber-500/20' },
  low: { label: 'Low', className: 'text-orange-600 bg-orange-500/10 border-orange-500/20' },
  none: { label: 'None', className: 'text-muted-foreground bg-muted border-muted-foreground/20' },
}

function LivenessBadge({ liveness }: { liveness: string }) {
  const config = LIVENESS_BADGE[liveness] ?? LIVENESS_BADGE.inactive
  return (
    <Badge variant={config.variant} className="text-[10px] px-1.5 py-0">
      {liveness === 'active' ? (
        <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-500 animate-pulse" />
      ) : null}
      {config.label}
    </Badge>
  )
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const config = CONFIDENCE_BADGE[confidence] ?? CONFIDENCE_BADGE.none
  return (
    <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-medium', config.className)}>
      {config.label}
    </span>
  )
}

function PortChip({ label, port }: { label: string; port: number | null }) {
  if (port === null) return null
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
      {label}:{port}
    </span>
  )
}

function TruncatedPath({ path, maxLength = 50 }: { path: string; maxLength?: number }) {
  if (path.length <= maxLength) {
    return <span className="font-mono text-[11px]">{path}</span>
  }

  const segments = path.split('/')
  const last3 = segments.slice(-3).join('/')
  const truncated = `…/${last3}`

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="font-mono text-[11px] cursor-help">{truncated}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-sm break-all text-[10px] font-mono">
          {path}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function PlaywrightSessionCard({
  session,
  selected = false,
  compact = false,
  onSelect,
  onFocus,
  onClose,
}: PlaywrightSessionCardProps) {
  const { artifactCounts, ports, correlation } = session
  const isClickable = !!onSelect
  const previewable = isSessionPreviewable(session)
  const [showCloseDialog, setShowCloseDialog] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation()
    void navigator.clipboard.writeText(session.sessionFilePath)
  }

  const handleFocus = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (previewable) onFocus?.()
  }

  const handleCloseClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setCloseError(null)
    setShowCloseDialog(true)
  }

  const handleConfirmClose = async () => {
    setIsClosing(true)
    setCloseError(null)
    try {
      await onClose?.()
      setShowCloseDialog(false)
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : 'Failed to close session')
    } finally {
      setIsClosing(false)
    }
  }

  const canClose = onClose && (session.liveness === 'active' || session.liveness === 'error') && session.socketExists

  // Compact card for split-view left pane
  if (compact) {
    return (
    <>
      <Card
        className={cn(
          'transition-colors cursor-pointer',
          selected && 'border-primary bg-primary/5 ring-1 ring-primary/20',
          !selected && 'hover:border-muted-foreground/30',
          session.liveness === 'active' && previewable && !selected && 'border-emerald-500/20',
          session.liveness === 'active' && !previewable && !selected && 'border-amber-500/20',
          !session.preferredInDuplicateGroup && 'opacity-60',
        )}
        onClick={onSelect}
      >
        <CardContent className="p-2.5 space-y-1.5">
          {/* Header row */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <MonitorPlay className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-xs font-medium truncate">{session.sessionName}</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <LivenessBadge liveness={session.liveness} />
              {previewable ? (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0"
                        onClick={handleFocus}
                      >
                        <Maximize2 className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs">Focus mode</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
              {canClose ? (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                        onClick={handleCloseClick}
                      >
                        <Power className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs">Close session</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
            </div>
          </div>

          {/* Location + correlation */}
          <div className="flex items-center gap-2 text-muted-foreground">
            {session.worktreeName ? (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                {session.worktreeName}
              </Badge>
            ) : null}
            {correlation.matchedAgentDisplayName ? (
              <span className="text-[10px] truncate">
                {correlation.matchedAgentDisplayName}
              </span>
            ) : null}
            {/* Not-previewable hint for active sessions */}
            {session.liveness === 'active' && !previewable ? (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                      <EyeOff className="size-2.5" />
                      <span>No preview</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs max-w-xs">
                    {session.previewability?.unavailableReason ?? 'Socket not responsive'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            <span className="ml-auto text-[10px] shrink-0">
              {formatShortTime(session.sessionFileUpdatedAt)}
            </span>
          </div>
        </CardContent>
      </Card>
      <CloseSessionDialog
        open={showCloseDialog}
        sessionName={session.sessionName}
        isClosing={isClosing}
        closeError={closeError}
        onConfirm={handleConfirmClose}
        onCancel={() => setShowCloseDialog(false)}
      />
    </>
    )
  }

  // Full card (grid view)
  return (
    <>
    <Card
      className={cn(
        'transition-colors',
        isClickable && 'cursor-pointer',
        selected && 'border-primary bg-primary/5 ring-1 ring-primary/20',
        !selected && isClickable && 'hover:border-muted-foreground/30',
        session.liveness === 'active' && previewable && !selected && 'border-emerald-500/30',
        session.liveness === 'active' && !previewable && !selected && 'border-amber-500/20',
        session.liveness === 'stale' && 'border-amber-500/20',
        session.liveness === 'error' && 'border-destructive/30',
        !session.preferredInDuplicateGroup && 'opacity-60',
      )}
      onClick={onSelect}
    >
      <CardContent className="p-3 space-y-2.5">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <MonitorPlay className="size-4 shrink-0 text-muted-foreground" />
            <h4 className="text-sm font-medium truncate">{session.sessionName}</h4>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
              {session.schemaVersion}
            </Badge>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <LivenessBadge liveness={session.liveness} />
            {!session.preferredInDuplicateGroup ? (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">Dup</Badge>
            ) : null}
          </div>
        </div>

        {/* Location */}
        <div className="flex items-center gap-2 text-muted-foreground">
          <Globe className="size-3 shrink-0" />
          <TruncatedPath path={session.worktreePath ?? session.rootPath} />
          {session.worktreeName ? (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
              {session.worktreeName}
            </Badge>
          ) : null}
          <button
            type="button"
            onClick={handleCopyPath}
            className="ml-auto shrink-0 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            title="Copy session file path"
          >
            <Copy className="size-3" />
          </button>
        </div>

        {/* Correlation */}
        {correlation.matchedAgentId ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Link2 className="size-3 shrink-0" />
            <span className="text-xs truncate">
              {correlation.matchedAgentDisplayName ?? correlation.matchedAgentId}
            </span>
            <ConfidenceBadge confidence={correlation.confidence} />
          </div>
        ) : null}

        {/* Ports */}
        {(ports.frontend !== null || ports.backendApi !== null || ports.cdp !== null) ? (
          <div className="flex flex-wrap gap-1">
            <PortChip label="FE" port={ports.frontend} />
            <PortChip label="API" port={ports.backendApi} />
            <PortChip label="CDP" port={ports.cdp} />
            <PortChip label="Sandbox" port={ports.sandbox} />
            <PortChip label="LiteLLM" port={ports.liteLlm} />
          </div>
        ) : null}

        {/* Artifacts + Timestamps */}
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            {artifactCounts.total > 0 ? (
              <>
                {artifactCounts.pageSnapshots > 0 ? (
                  <span className="flex items-center gap-0.5" title="Page snapshots">
                    <FileText className="size-3" />{artifactCounts.pageSnapshots}
                  </span>
                ) : null}
                {artifactCounts.screenshots > 0 ? (
                  <span className="flex items-center gap-0.5" title="Screenshots">
                    <Image className="size-3" />{artifactCounts.screenshots}
                  </span>
                ) : null}
                {artifactCounts.consoleLogs > 0 ? (
                  <span className="flex items-center gap-0.5" title="Console logs">
                    <Terminal className="size-3" />{artifactCounts.consoleLogs}
                  </span>
                ) : null}
                {artifactCounts.networkLogs > 0 ? (
                  <span className="flex items-center gap-0.5" title="Network logs">
                    <Network className="size-3" />{artifactCounts.networkLogs}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground/60">No artifacts</span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Clock className="size-3" />
            <span>{formatShortTime(session.sessionFileUpdatedAt)}</span>
          </div>
        </div>

        {/* Action buttons row — previewability-aware */}
        {(session.liveness === 'active' || canClose) ? (
          <div className="flex items-center gap-1.5 pt-0.5">
            {session.liveness === 'active' && previewable ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelect?.()
                  }}
                >
                  <Eye className="size-3 mr-1" />
                  Live view
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={handleFocus}
                >
                  <Maximize2 className="size-3 mr-1" />
                  Focus
                </Button>
              </>
            ) : session.liveness === 'active' ? (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                      <EyeOff className="size-3" />
                      Preview unavailable
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs max-w-xs">
                    {session.previewability?.unavailableReason ?? 'Browser socket is not responsive'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            {canClose ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs px-2 ml-auto text-muted-foreground hover:text-destructive"
                onClick={handleCloseClick}
              >
                <Power className="size-3 mr-1" />
                Close
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Warnings */}
        {session.warnings.length > 0 ? (
          <div className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            <AlertCircle className="size-3 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              {session.warnings.map((warning, i) => (
                <p key={i}>{warning}</p>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
    <CloseSessionDialog
      open={showCloseDialog}
      sessionName={session.sessionName}
      isClosing={isClosing}
      closeError={closeError}
      onConfirm={handleConfirmClose}
      onCancel={() => setShowCloseDialog(false)}
    />
    </>
  )
}

function CloseSessionDialog({
  open,
  sessionName,
  isClosing,
  closeError,
  onConfirm,
  onCancel,
}: {
  open: boolean
  sessionName: string
  isClosing: boolean
  closeError: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !isClosing) onCancel() }}>
      <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Close browser session</DialogTitle>
          <DialogDescription>
            This will shut down the Playwright daemon for <strong>{sessionName}</strong>.
            The browser will be closed and the session will become inactive.
          </DialogDescription>
        </DialogHeader>
        {closeError ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {closeError}
          </div>
        ) : null}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={isClosing}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={isClosing}
          >
            {isClosing ? (
              <>
                <Loader2 className="size-3 mr-1.5 animate-spin" />
                Closing…
              </>
            ) : (
              <>
                <Power className="size-3 mr-1.5" />
                Close Session
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatShortTime(isoString: string): string {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return 'Unknown'

  const now = new Date()
  const diffMs = now.getTime() - date.getTime()

  if (diffMs < 60_000) return 'Just now'
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
