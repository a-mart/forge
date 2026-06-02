import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import type { ProjectAgentShareEligibleTarget, ProjectAgentShareGrantInfo } from '@forge/protocol'

export interface ProjectAgentSharingSectionProps {
  grants: ProjectAgentShareGrantInfo[]
  eligibleTargets: ProjectAgentShareEligibleTarget[]
  selectedTargetIds: string[]
  projectAgentHandle: string
  onSelectedTargetIdsChange: (targetIds: string[]) => void
}

export function ProjectAgentSharingSection({
  grants,
  eligibleTargets,
  selectedTargetIds,
  projectAgentHandle,
  onSelectedTargetIdsChange,
}: ProjectAgentSharingSectionProps) {
  return (
    <>
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">Current external aliases</p>
        {grants.length > 0 ? (
          <div className="space-y-2">
            {grants.map((grant) => (
              <div key={grant.grantId} className="rounded-md border border-border/60 px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-foreground">{grant.targetProjectName}</div>
                    <div className="font-mono text-muted-foreground">@{grant.externalHandle}</div>
                  </div>
                  {grant.blockedReason ? (
                    <Badge variant="outline" className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
                      {grant.blockedReason === 'source_archived' ? 'source archived' : 'target archived'}
                    </Badge>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Not shared into any other Builder project yet.</p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">Share into other projects</p>
        {eligibleTargets.length > 0 ? (
          <div className="space-y-2">
            {eligibleTargets.map((target) => {
              const checked = selectedTargetIds.includes(target.profileId)
              const aliasPreview = `${target.namespacePreview}/${projectAgentHandle || 'agent'}`
              return (
                <div key={target.profileId} className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) => {
                      onSelectedTargetIdsChange(next === true
                        ? [...selectedTargetIds, target.profileId]
                        : selectedTargetIds.filter((profileId) => profileId !== target.profileId))
                    }}
                    aria-label={`Share with ${target.displayName}`}
                    className="mt-0.5"
                  />
                  <div className="space-y-0.5">
                    <div className="text-sm text-foreground">{target.displayName}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">@{aliasPreview}</div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No other Builder projects are currently eligible for sharing.</p>
        )}
      </div>
    </>
  )
}
