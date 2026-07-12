import { ClipboardList } from 'lucide-react'
import type { SessionPlanSnapshotEvent } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PlanView } from './PlanView'

export function PlanHeaderIndicator({ snapshot }: { snapshot?: SessionPlanSnapshotEvent | null }) {
  if (!snapshot || snapshot.plan.length === 0) return null
  const completed = snapshot.plan.filter((step) => step.status === 'completed').length
  const isComplete = completed === snapshot.plan.length

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2" aria-label="Open working plan">
          <ClipboardList className={isComplete ? 'size-4 text-emerald-500' : 'size-4 text-violet-500'} />
          <span className="hidden text-xs tabular-nums sm:inline">{completed}/{snapshot.plan.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="border-b border-border/60 px-4 py-3">
          <p className="text-sm font-semibold">{isComplete ? 'Plan complete' : 'Working plan'}</p>
        </div>
        <div className="p-4">
          <PlanView snapshot={snapshot} compact />
        </div>
      </PopoverContent>
    </Popover>
  )
}
