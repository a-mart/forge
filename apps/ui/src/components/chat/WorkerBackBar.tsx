import { memo } from 'react'
import { ArrowLeft, ShieldCheck, ShieldOff } from 'lucide-react'

interface WorkerBackBarProps {
  managerLabel: string
  onNavigateBack: () => void
  secureStatus?: {
    active: boolean
    label: string
  }
}

export const WorkerBackBar = memo(function WorkerBackBar({
  managerLabel,
  onNavigateBack,
  secureStatus,
}: WorkerBackBarProps) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-background px-2 py-1.5">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        onClick={onNavigateBack}
      >
        <ArrowLeft className="size-3" />
        <span>Back to {managerLabel}</span>
      </button>
      {secureStatus ? (
        <div
          className="inline-flex min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground"
          aria-label={`Team Secure Bash: ${secureStatus.label}`}
        >
          {secureStatus.active ? (
            <ShieldCheck className="size-3 shrink-0 text-emerald-500" aria-hidden="true" />
          ) : (
            <ShieldOff className="size-3 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{secureStatus.label}</span>
        </div>
      ) : null}
    </div>
  )
})
