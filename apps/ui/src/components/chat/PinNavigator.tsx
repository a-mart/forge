import { useState, useCallback, useEffect, useRef } from 'react'
import { ChevronUp, ChevronDown, Pin, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'

interface PinNavigatorProps {
  pinnedMessageIds: string[]
  onScrollToMessage: (messageId: string) => void
}

export function PinNavigator({ pinnedMessageIds, onScrollToMessage }: PinNavigatorProps) {
  const [open, setOpen] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const activeMessageIdRef = useRef<string | null>(null)
  const count = pinnedMessageIds.length

  // Track the active message ID and recompute index when pins change
  useEffect(() => {
    if (!open || count === 0) return
    const activeId = activeMessageIdRef.current
    if (activeId) {
      const newIndex = pinnedMessageIds.indexOf(activeId)
      if (newIndex >= 0) {
        // Pin still exists — update index to its new position
        setCurrentIndex(newIndex)
      } else {
        // Active pin was removed — clamp to nearest valid index
        const clamped = Math.min(currentIndex, count - 1)
        setCurrentIndex(clamped)
        activeMessageIdRef.current = pinnedMessageIds[clamped] ?? null
      }
    } else {
      // No active pin tracked — clamp
      setCurrentIndex(Math.max(0, Math.min(currentIndex, count - 1)))
    }
  }, [pinnedMessageIds, open]) // eslint-disable-line react-hooks/exhaustive-deps

  const navigateTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, count - 1))
      setCurrentIndex(clamped)
      const id = pinnedMessageIds[clamped]
      if (id) {
        activeMessageIdRef.current = id
        onScrollToMessage(id)
      }
    },
    [count, pinnedMessageIds, onScrollToMessage],
  )

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (nextOpen && count > 0) {
        // Auto-navigate to first pin on open
        setCurrentIndex(0)
        activeMessageIdRef.current = pinnedMessageIds[0]
        onScrollToMessage(pinnedMessageIds[0])
      } else if (!nextOpen) {
        activeMessageIdRef.current = null
      }
    },
    [count, pinnedMessageIds, onScrollToMessage],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault()
        navigateTo(currentIndex - 1)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault()
        navigateTo(currentIndex + 1)
      }
    },
    [currentIndex, navigateTo],
  )

  if (count === 0) return null

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <TooltipProvider delayDuration={200}>
        {/* Suppress tooltip while popover is open (same pattern as WorkerPillBar) */}
        <Tooltip open={open ? false : undefined}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="hidden sm:inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-amber-600 hover:bg-amber-500/10 dark:text-amber-400 dark:hover:bg-amber-500/10 transition-colors cursor-pointer"
              >
                <Pin className="size-3 fill-current" />
                <span>{count}</span>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Navigate pinned messages
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        side="bottom"
        align="center"
        sideOffset={8}
        className="w-auto min-w-[200px] p-2"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Pin className="size-3 text-amber-500 fill-current" />
            <span className="font-medium tabular-nums">
              {currentIndex + 1} of {count}
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              disabled={currentIndex <= 0}
              onClick={() => navigateTo(currentIndex - 1)}
              aria-label="Previous pinned message"
            >
              <ChevronUp className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              disabled={currentIndex >= count - 1}
              onClick={() => navigateTo(currentIndex + 1)}
              aria-label="Next pinned message"
            >
              <ChevronDown className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground"
              onClick={() => setOpen(false)}
              aria-label="Close pin navigator"
            >
              <X className="size-3" />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
