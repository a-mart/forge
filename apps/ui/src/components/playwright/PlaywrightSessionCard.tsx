import {
  AlertCircle,
  Clock,
  Copy,
  FileText,
  Globe,
  Image,
  Link2,
  MonitorPlay,
  Network,
  Terminal,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PlaywrightDiscoveredSession } from '@middleman/protocol'

interface PlaywrightSessionCardProps {
  session: PlaywrightDiscoveredSession
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

export function PlaywrightSessionCard({ session }: PlaywrightSessionCardProps) {
  const { artifactCounts, ports, correlation } = session

  const handleCopyPath = () => {
    void navigator.clipboard.writeText(session.sessionFilePath)
  }

  return (
    <Card className={cn(
      'transition-colors',
      session.liveness === 'active' && 'border-emerald-500/30',
      session.liveness === 'stale' && 'border-amber-500/20',
      session.liveness === 'error' && 'border-destructive/30',
      !session.preferredInDuplicateGroup && 'opacity-60',
    )}>
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
