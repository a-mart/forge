import { Pause, Play, Trash2 } from 'lucide-react'
import React from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SpecialistBadge } from '../SpecialistBadge'
import { cn } from '@/lib/utils'
import { HighlightedText } from './shared'
import type { WorkerRowProps } from './types'

export const WorkerRow = React.memo(function WorkerRow({
  agent,
  statusValue,
  isSelected,
  onSelect,
  onDelete,
  onStop,
  onResume,
  highlightQuery,
}: WorkerRowProps) {
  const name = agent.displayName || agent.agentId
  const tooltipLines = [
    name,
    `${agent.model.provider}/${agent.model.modelId}`,
    ...(agent.model.thinkingLevel ? [`reasoning: ${agent.model.thinkingLevel}`] : []),
  ]
  const isActive = statusValue === 'streaming'
  const isRunning = statusValue === 'streaming' || statusValue === 'idle'
  const isStopped = statusValue === 'terminated' || statusValue === 'stopped'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'flex w-full items-center gap-1 rounded-md py-1.5 pl-12 pr-1.5 transition-colors',
            isSelected
              ? 'bg-white/[0.04] text-sidebar-foreground ring-1 ring-sidebar-ring/30'
              : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
          )}
        >
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onSelect(agent.agentId)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
                >
                  <span
                    className={cn(
                      'inline-block size-1.5 shrink-0 rounded-full',
                      isActive ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                    )}
                    aria-label={isActive ? 'Active' : 'Idle'}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm leading-5">
                    {highlightQuery ? <HighlightedText text={name} query={highlightQuery} /> : name}
                  </span>
                  {agent.specialistId && agent.specialistDisplayName && agent.specialistColor ? (
                    <SpecialistBadge
                      displayName={agent.specialistDisplayName}
                      color={agent.specialistColor}
                      className="shrink-0"
                    />
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={6} className="px-2 py-1 text-[10px]">
                {tooltipLines.map((line, i) => (
                  <p key={i} className={i === 0 ? 'font-medium' : 'opacity-80'}>{line}</p>
                ))}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {isRunning && onStop ? (
          <ContextMenuItem onClick={() => onStop(agent.agentId)}>
            <Pause className="mr-2 size-3.5" />
            Stop
          </ContextMenuItem>
        ) : null}
        {isStopped && onResume ? (
          <ContextMenuItem onClick={() => onResume(agent.agentId)}>
            <Play className="mr-2 size-3.5" />
            Resume
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => onDelete(agent.agentId)}>
          <Trash2 className="mr-2 size-3.5" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})
