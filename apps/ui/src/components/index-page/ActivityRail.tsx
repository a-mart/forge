import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type ActivityRailItemId =
  | 'chat'
  | 'artifacts'
  | 'schedules'
  | 'files'
  | 'terminal'
  | 'changes'

export interface ActivityRailItem {
  id: ActivityRailItemId
  label: string
  icon: LucideIcon
  active?: boolean
  disabled?: boolean
  badge?: number
  shortcutLabel?: string
  onClick: () => void
}

interface ActivityRailProps {
  items: ActivityRailItem[]
}

function formatTooltipLabel(label: string, shortcutLabel?: string): string {
  return shortcutLabel ? `${label} (${shortcutLabel})` : label
}

function ActivityRailButton({ item }: { item: ActivityRailItem }) {
  const { label, icon: Icon, active, disabled, badge, shortcutLabel, onClick } = item
  const tooltip = formatTooltipLabel(label, shortcutLabel)
  const ariaLabel = badge ? `${tooltip} (${badge})` : tooltip

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative inline-flex size-10 items-center justify-center rounded-xl bg-transparent text-muted-foreground transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60 focus-visible:ring-offset-0',
            active
              ? 'text-primary hover:bg-sidebar-accent/70 bg-sidebar-accent/70'
              : 'hover:bg-sidebar-accent/40 hover:text-sidebar-foreground',
          )}
          onClick={onClick}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-pressed={active}
          aria-current={active ? 'true' : undefined}
        >
          {active ? (
            <span
              aria-hidden="true"
              className="absolute left-1 top-2 bottom-2 w-0.5 rounded-full bg-primary"
            />
          ) : null}
          <Icon className="size-[18px]" strokeWidth={1.75} />
          {badge && badge > 0 ? (
            <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
              {badge > 9 ? '9+' : badge}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export function ActivityRail({ items }: ActivityRailProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <nav
        className="hidden h-full w-12 shrink-0 flex-col items-center gap-1.5 border-r border-sidebar-border bg-sidebar py-2 md:flex"
        aria-label="Activity rail"
      >
        {items.map((item) => (
          <div key={item.id} className="flex w-full flex-col items-center gap-1.5">
            <ActivityRailButton item={item} />
          </div>
        ))}
      </nav>
    </TooltipProvider>
  )
}
