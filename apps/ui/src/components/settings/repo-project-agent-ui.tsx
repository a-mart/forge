import type {
  ProjectAgentSourceStatus,
  RepoProjectAgentInventoryItem,
} from '@forge/protocol'
import { AlertTriangle, CheckCircle2, GitBranch, Loader2, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
export function SourceStatusBadge({ status }: { status: ProjectAgentSourceStatus }) {
  switch (status) {
    case 'valid':
      return <Badge className="gap-1 text-[10px]"><CheckCircle2 className="h-2.5 w-2.5" />Valid</Badge>
    case 'local':
      return <Badge variant="secondary" className="text-[10px]">Local</Badge>
    case 'missing':
      return <Badge variant="destructive" className="text-[10px]">Missing</Badge>
    case 'invalid':
      return <Badge variant="destructive" className="text-[10px]">Invalid</Badge>
    case 'conflict':
      return <Badge variant="destructive" className="text-[10px]">Conflict</Badge>
    case 'wrong_workspace':
      return <Badge variant="secondary" className="text-[10px]">Wrong workspace</Badge>
    case 'unavailable':
      return <Badge variant="secondary" className="text-[10px]">Unavailable</Badge>
    default:
      return <Badge variant="secondary" className="text-[10px]">{status}</Badge>
  }
}

export function ProjectAgentDefinitionRow({
  item,
  activating,
  onActivate,
  showPath = true,
}: {
  item: RepoProjectAgentInventoryItem
  activating?: boolean
  onActivate?: () => void
  showPath?: boolean
}) {
  const canActivate = item.status === 'valid' && !item.activatedAgentId
  const isActive = Boolean(item.activatedAgentId)

  return (
    <div className="space-y-1.5 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Zap className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          <code className="truncate text-sm font-semibold">@{item.handle}</code>
          {item.displayName ? (
            <span className="truncate text-sm text-muted-foreground">{item.displayName}</span>
          ) : null}
          <SourceStatusBadge status={item.status} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isActive ? (
            <Badge variant="outline" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Active
            </Badge>
          ) : canActivate && onActivate ? (
            <Button size="sm" variant="outline" onClick={onActivate} disabled={activating}>
              {activating ? (
                <>
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  Activating
                </>
              ) : (
                'Activate'
              )}
            </Button>
          ) : null}
        </div>
      </div>
      {item.whenToUse ? (
        <p className="line-clamp-2 text-sm text-muted-foreground">{item.whenToUse}</p>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {showPath ? <span className="break-all">{item.path}</span> : null}
        {item.recommendedModel ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default">
                  Model: {item.recommendedModel.provider}/{item.recommendedModel.modelId}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {item.recommendedModel.thinkingLevel ? `Thinking: ${item.recommendedModel.thinkingLevel}` : 'No thinking level set'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        {item.requestedCapabilities?.length ? (
          <span>Capabilities: {item.requestedCapabilities.join(', ')}</span>
        ) : null}
      </div>
      {item.problems.length > 0 ? (
        <div className="space-y-1">
          {item.problems.map((problem, index) => (
            <div key={index} className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{problem.message}{problem.path ? ` (${problem.path})` : ''}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}


export function RepoProjectAgentActivationHeader() {
  return (
    <div className="flex items-center gap-2">
      <GitBranch className="h-4 w-4" />
      <span>Repository Project Agent</span>
    </div>
  )
}
