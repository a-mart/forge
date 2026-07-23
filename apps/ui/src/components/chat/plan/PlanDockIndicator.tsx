import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Check, ClipboardList, GitBranch } from 'lucide-react'
import type { SessionPlanSnapshotEvent } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  CHAT_TRANSCRIPT_SURFACE_SELECTOR,
  PLAN_DOCK_POPOVER_HEIGHT_CLASS,
  PLAN_DOCK_POPOVER_SCROLL_CLASS,
  PLAN_DOCK_POPOVER_WIDTH_CLASS,
  planDockPopoverCollisionTopPx,
  planDockPopoverMaxHeightPx,
} from './plan-surface'
import { PlanView } from './PlanView'

const DOCK_POPOVER_SIDE_OFFSET = 8

export function PlanDockIndicator({ snapshot }: { snapshot?: SessionPlanSnapshotEvent | null }) {
  const [open, setOpen] = useState(false)
  const [collisionTop, setCollisionTop] = useState(0)
  const [maxHeightPx, setMaxHeightPx] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const updateBounds = useCallback(() => {
    const surface = document.querySelector(CHAT_TRANSCRIPT_SURFACE_SELECTOR)
    const transcriptTop = surface instanceof HTMLElement
      ? surface.getBoundingClientRect().top
      : 0
    const nextCollisionTop = planDockPopoverCollisionTopPx(transcriptTop)
    setCollisionTop(nextCollisionTop)

    const trigger = triggerRef.current
    if (!trigger) {
      setMaxHeightPx(null)
      return
    }
    const availableBottom = trigger.getBoundingClientRect().top - DOCK_POPOVER_SIDE_OFFSET
    setMaxHeightPx(planDockPopoverMaxHeightPx({
      collisionTop: nextCollisionTop,
      availableBottom,
    }))
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    updateBounds()
    const surface = document.querySelector(CHAT_TRANSCRIPT_SURFACE_SELECTOR)
    const ownerWindow = surface?.ownerDocument.defaultView ?? window
    const ResizeObserverImpl = ownerWindow.ResizeObserver
    const observer = ResizeObserverImpl ? new ResizeObserverImpl(() => updateBounds()) : null
    if (observer && surface instanceof HTMLElement) observer.observe(surface)
    if (observer && triggerRef.current) observer.observe(triggerRef.current)
    ownerWindow.addEventListener('resize', updateBounds)
    return () => {
      observer?.disconnect()
      ownerWindow.removeEventListener('resize', updateBounds)
    }
  }, [open, updateBounds])

  if (!snapshot || snapshot.plan.length === 0) return null

  const completed = snapshot.plan.filter((step) => step.status === 'completed').length
  const isComplete = completed === snapshot.plan.length
  const isGraph = snapshot.coordinationMode === 'graph' && Boolean(snapshot.workGraph)
  const label = isComplete
    ? (isGraph ? 'Graph complete' : 'Plan complete')
    : `${completed}/${snapshot.plan.length} done`

  return (
    <div className="relative z-20 h-0 shrink-0">
      <div className="absolute inset-x-0 bottom-1 flex justify-center px-3">
        <Popover
          open={open}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen)
            if (nextOpen) {
              // Always present the top of the graph; let overflow fall off the bottom.
              queueMicrotask(() => {
                if (scrollRef.current) scrollRef.current.scrollTop = 0
              })
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 rounded-full bg-card/95 px-3 text-xs shadow-sm backdrop-blur"
              aria-label={`Open working plan, ${label}`}
            >
              {isComplete ? (
                <Check className="size-3.5 text-emerald-500" />
              ) : (
                isGraph ? (
                  <GitBranch className="size-3.5 text-violet-500" />
                ) : (
                  <ClipboardList className="size-3.5 text-violet-500" />
                )
              )}
              <span className="tabular-nums">{label}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="center"
            sideOffset={DOCK_POPOVER_SIDE_OFFSET}
            collisionPadding={{ top: collisionTop, right: 8, bottom: 8, left: 8 }}
            className={cn(PLAN_DOCK_POPOVER_WIDTH_CLASS, 'overflow-hidden p-0')}
          >
            <div
              ref={scrollRef}
              tabIndex={0}
              data-plan-dock-popover-scroll=""
              style={maxHeightPx == null ? undefined : { maxHeight: `${maxHeightPx}px` }}
              className={cn(
                PLAN_DOCK_POPOVER_HEIGHT_CLASS,
                PLAN_DOCK_POPOVER_SCROLL_CLASS,
              )}
            >
              <div className="border-b border-border/60 px-4 py-3">
                <p className="text-sm font-semibold">
                  {isComplete ? (isGraph ? 'Graph complete' : 'Plan complete') : (isGraph ? 'Work graph' : 'Working plan')}
                </p>
              </div>
              <div className="p-4">
                <PlanView snapshot={snapshot} />
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
