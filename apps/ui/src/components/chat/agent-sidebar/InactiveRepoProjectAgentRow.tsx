import { GitBranch, Zap } from 'lucide-react'
import React from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { HighlightedText } from './shared'
import type { RepoProjectAgentSidebarEntry } from '@/hooks/use-inactive-repo-project-agents'

export interface InactiveRepoProjectAgentRowProps {
  entry: RepoProjectAgentSidebarEntry
  isSelected: boolean
  highlightQuery?: string
  onSelect: () => void
}

export const InactiveRepoProjectAgentRow = React.memo(function InactiveRepoProjectAgentRow({
  entry,
  isSelected,
  highlightQuery,
  onSelect,
}: InactiveRepoProjectAgentRowProps) {
  const { item, activatable } = entry
  const label = item.displayName || item.handle
  const tooltipStatus = activatable ? 'Not activated' : 'Unavailable'

  return (
    <li>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onSelect}
              aria-label={`${label} — repository project agent (${tooltipStatus.toLowerCase()})`}
              className={cn(
                'relative flex w-full items-center rounded-md py-1.5 pl-5 pr-1.5 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                isSelected
                  ? 'bg-white/[0.04] text-sidebar-foreground ring-1 ring-sidebar-ring/30'
                  : activatable
                    ? 'text-sidebar-foreground/55 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground/75'
                    : 'text-sidebar-foreground/40 hover:bg-sidebar-accent/30',
              )}
            >
              <span
                className={cn(
                  'mr-1.5 inline-flex size-3 shrink-0 items-center justify-center rounded-full border border-dashed',
                  activatable ? 'border-blue-400/40' : 'border-muted-foreground/30',
                )}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-sm leading-5">
                {highlightQuery ? <HighlightedText text={label} query={highlightQuery} /> : label}
              </span>
              <span
                className="inline-flex shrink-0 items-center gap-0.5 opacity-70"
                aria-label={activatable ? 'Repository project agent (not activated)' : 'Repository project agent (unavailable)'}
              >
                <GitBranch className={cn('size-2.5', activatable ? 'text-blue-400/50' : 'text-muted-foreground/40')} />
                <Zap className={cn('size-3', activatable ? 'text-blue-400/50' : 'text-muted-foreground/40')} />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={6} className="px-2 py-1 text-[10px]">
            <p className="font-medium">{label}</p>
            <p className="opacity-80">@{item.handle}</p>
            <p className="opacity-60">Repository definition — {tooltipStatus.toLowerCase()}</p>
            {!activatable ? (
              <p className="opacity-60">Status: {item.status.replace(/_/g, ' ')}</p>
            ) : null}
            {item.whenToUse ? (
              <p className="mt-1 line-clamp-3 opacity-60">{item.whenToUse}</p>
            ) : null}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </li>
  )
})
