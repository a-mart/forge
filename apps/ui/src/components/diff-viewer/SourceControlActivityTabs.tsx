import type { DiffTab } from './DiffDialogHeader'
import { cn } from '@/lib/utils'

export type SourceControlActivityTab = Extract<DiffTab, 'changes' | 'history'>

interface SourceControlActivityTabsProps {
  activeTab: SourceControlActivityTab | null
  onTabChange: (tab: SourceControlActivityTab) => void
}

export function SourceControlActivityTabs({ activeTab, onTabChange }: SourceControlActivityTabsProps) {
  return (
    <div className="border-b border-border/60 bg-card/80 p-2">
      <div
        className="inline-flex h-8 w-full items-center rounded-md border border-border/60 bg-muted/30 p-0.5"
        role="group"
        aria-label="Repository activity"
      >
        <ActivityTabButton
          label="Changes"
          active={activeTab === 'changes'}
          onClick={() => onTabChange('changes')}
        />
        <ActivityTabButton
          label="History"
          active={activeTab === 'history'}
          onClick={() => onTabChange('history')}
        />
      </div>
    </div>
  )
}

function ActivityTabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'h-full min-w-0 flex-1 rounded-[4px] px-2 text-[11px] font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
  )
}
