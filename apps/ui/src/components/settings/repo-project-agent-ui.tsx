import { useCallback, useState } from 'react'
import type {
  ProjectAgentSourceStatus,
  RepoProjectAgentInventoryItem,
  RepoProjectAgentInventorySection,
} from '@forge/protocol'
import { AlertTriangle, CheckCircle2, GitBranch, Loader2, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { SettingsApiClient } from './settings-api-client'
import { activateRepoProjectAgent } from './project-resources-api'

export function getInactiveRepoProjectAgentDefinitions(
  section: RepoProjectAgentInventorySection | undefined,
): RepoProjectAgentInventoryItem[] {
  if (!section?.exists) return []
  return section.items.filter((item) => !item.activatedAgentId && item.status === 'valid')
}

export function getUnavailableRepoProjectAgentDefinitions(
  section: RepoProjectAgentInventorySection | undefined,
): RepoProjectAgentInventoryItem[] {
  if (!section?.exists) return []
  return section.items.filter(
    (item) => !item.activatedAgentId && item.status !== 'valid' && item.status !== 'local',
  )
}

export function matchesRepoProjectAgentSearch(
  item: RepoProjectAgentInventoryItem,
  query: string | undefined,
): boolean {
  if (!query?.trim()) return true
  const lower = query.trim().toLowerCase()
  return (
    item.handle.toLowerCase().includes(lower)
    || (item.displayName?.toLowerCase().includes(lower) ?? false)
    || (item.whenToUse?.toLowerCase().includes(lower) ?? false)
    || item.definitionId.toLowerCase().includes(lower)
  )
}

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

export function useRepoProjectAgentActivation(options: {
  apiClient: SettingsApiClient
  context: { profileId: string; sessionAgentId: string }
  onActivated?: (agentId: string) => void
}) {
  const { apiClient, context, onActivated } = options
  const [activatingId, setActivatingId] = useState<string | null>(null)
  const [activateError, setActivateError] = useState<string | null>(null)

  const handleActivate = useCallback(async (item: RepoProjectAgentInventoryItem) => {
    setActivatingId(item.definitionId)
    setActivateError(null)
    try {
      const result = await activateRepoProjectAgent(apiClient, {
        ...context,
        definitionId: item.definitionId,
        mode: 'create',
        applyRecommendedModel: Boolean(item.recommendedModel),
        approvedCapabilities: item.requestedCapabilities,
      })
      onActivated?.(result.agentId)
      return result
    } catch (err) {
      setActivateError(err instanceof Error ? err.message : 'Activation failed.')
      throw err
    } finally {
      setActivatingId(null)
    }
  }, [apiClient, context, onActivated])

  return {
    activatingId,
    activateError,
    setActivateError,
    handleActivate,
  }
}

export function RepoProjectAgentActivationHeader() {
  return (
    <div className="flex items-center gap-2">
      <GitBranch className="h-4 w-4" />
      <span>Repository Project Agent</span>
    </div>
  )
}
