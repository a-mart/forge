import { useId, useState } from 'react'
import { Check, ChevronDown, ClipboardList } from 'lucide-react'
import type { PlanSummaryEvent } from '@forge/protocol'
import { cn } from '@/lib/utils'
import { PlanView } from './PlanView'

export function PlanSummaryRow({ summary }: { summary: PlanSummaryEvent }) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()

  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-1" aria-label="Completed plan summary">
      <div className="overflow-hidden rounded-xl border border-emerald-500/20 bg-card/60">
        <button
          type="button"
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
            <ClipboardList className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Completed plan
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] tabular-nums text-emerald-500">
                <Check className="size-3" />
                {summary.plan.length}/{summary.plan.length}
              </span>
            </span>
            <span className="block truncate text-sm text-foreground">
              {summary.explanation ?? summary.plan.at(-1)?.step ?? 'Plan completed'}
            </span>
          </span>
          <ChevronDown className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )} />
        </button>
        {expanded ? (
          <div id={detailsId} className="border-t border-border/60 px-4 py-3">
            <PlanView snapshot={summary} />
          </div>
        ) : null}
      </div>
    </section>
  )
}
