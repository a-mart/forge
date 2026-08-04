import { Pause, Play, Trash2 } from 'lucide-react'
import React from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SpecialistBadge } from '../SpecialistBadge'
import { cn } from '@/lib/utils'
import { isCodexExternalThread } from '@/lib/external-threads'
import { CodexExternalThreadIcon, HighlightedText } from './shared'
import { WorkerHighlightOutline } from '../WorkGraphWorkerHighlight'
import type { WorkerRowProps } from './types'

export const WorkerRow = React.memo(function WorkerRow({
  agent,
  liveStatus,
  roomsV2 = false,
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
  const statusValue = liveStatus.status
  const isActive = statusValue === 'streaming'
  const isRunning = statusValue === 'streaming' || statusValue === 'idle'
  const isStopped = statusValue === 'terminated' || statusValue === 'stopped'
  const isCodexWorker = isCodexExternalThread(agent)

  const row = (
        <div
          data-worker-row
          className={cn(
            roomsV2
              ? 'sidebar-room-worker-row'
              : 'relative flex w-full items-center gap-1 rounded-md py-1.5 pl-12 pr-1.5 transition-colors',
            roomsV2
              ? isSelected ? 'sidebar-room-row-selected' : undefined
              : isSelected
                ? 'bg-white/[0.04] text-sidebar-foreground ring-1 ring-sidebar-ring/30'
                : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
          )}
        >
          <WorkerHighlightOutline workerId={agent.agentId} className="rounded-md" />
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onSelect()}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                    roomsV2 ? 'text-xs leading-4' : undefined,
                  )}
                >
                  <span
                    className={cn(
                      'inline-block size-1.5 shrink-0 rounded-full',
                      roomsV2 ? 'sidebar-room-status-glyph' : undefined,
                      roomsV2
                        ? isActive ? 'sidebar-room-status-running' : 'sidebar-room-status-idle'
                        : isActive ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                    )}
                    aria-label={isActive ? 'Active' : 'Idle'}
                  />
                  {isCodexWorker ? <CodexExternalThreadIcon /> : null}
                  <span className={cn('min-w-0 flex-1 truncate text-sm leading-5', roomsV2 ? 'text-xs leading-4' : undefined)}>
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
  )

  if (!onDelete && !onStop && !onResume) return row

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {isRunning && onStop ? (
          <ContextMenuItem onClick={() => onStop()}>
            <Pause className="mr-2 size-3.5" />
            Stop
          </ContextMenuItem>
        ) : null}
        {isStopped && onResume ? (
          <ContextMenuItem onClick={() => onResume()}>
            <Play className="mr-2 size-3.5" />
            Resume
          </ContextMenuItem>
        ) : null}
        {onDelete && ((isRunning && onStop) || (isStopped && onResume)) ? <ContextMenuSeparator /> : null}
        {onDelete ? (
          <ContextMenuItem variant="destructive" onClick={() => onDelete()}>
            <Trash2 className="mr-2 size-3.5" />
            Delete
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
})
