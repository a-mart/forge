import { memo } from 'react'
import { ArrowLeft } from 'lucide-react'

interface WorkerBackBarProps {
  managerLabel: string
  onNavigateBack: () => void
}

export const WorkerBackBar = memo(function WorkerBackBar({
  managerLabel,
  onNavigateBack,
}: WorkerBackBarProps) {
  return (
    <div className="border-b border-border/40 bg-background px-2 py-1.5">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        onClick={onNavigateBack}
      >
        <ArrowLeft className="size-3" />
        <span>Back to {managerLabel}</span>
      </button>
    </div>
  )
})
