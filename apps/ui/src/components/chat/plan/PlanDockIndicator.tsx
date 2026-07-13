import { Check, ClipboardList } from 'lucide-react'
import type { SessionPlanSnapshotEvent } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PlanView } from './PlanView'

export function PlanDockIndicator({ snapshot }: { snapshot?: SessionPlanSnapshotEvent | null }) {
  if (!snapshot || snapshot.plan.length === 0) return null

  const completed = snapshot.plan.filter((step) => step.status === 'completed').length
  const isComplete = completed === snapshot.plan.length
  const activeIndex = snapshot.plan.findIndex((step) => step.status === 'in_progress')
  const nextIndex = activeIndex >= 0
    ? activeIndex
    : snapshot.plan.findIndex((step) => step.status === 'pending')
  const label = isComplete
    ? `${completed}/${snapshot.plan.length} complete`
    : `Step ${Math.max(0, nextIndex) + 1}/${snapshot.plan.length}`

  return (
    <div className="relative z-20 flex shrink-0 justify-center bg-background px-3 pt-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 rounded-full bg-card/95 px-3 text-xs shadow-sm backdrop-blur"
            aria-label={`Open working plan, ${label}`}
          >
            {isComplete ? (
              <Check className="size-3.5 text-emerald-500" />
            ) : (
              <ClipboardList className="size-3.5 text-violet-500" />
            )}
            <span className="tabular-nums">{label}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          sideOffset={8}
          className="w-[min(24rem,calc(100vw-2rem))] p-0"
        >
          <div className="border-b border-border/60 px-4 py-3">
            <p className="text-sm font-semibold">{isComplete ? 'Plan complete' : 'Working plan'}</p>
          </div>
          <div className="p-4">
            <PlanView snapshot={snapshot} compact />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
