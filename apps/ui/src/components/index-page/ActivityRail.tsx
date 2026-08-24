import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type ActivityRailItemId =
  | 'chat'
  | 'browser'
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
  /** Rooms-only bottom entry. Classic retains the established rail unchanged. */
  cortex?: ReactNode
  /** Gates all Rooms rail styling and the Cortex entry. */
  roomsV2?: boolean
}

function formatTooltipLabel(label: string, shortcutLabel?: string): string {
  return shortcutLabel ? `${label} (${shortcutLabel})` : label
}

function ActivityRailButton({ item, roomsV2 = false }: { item: ActivityRailItem; roomsV2?: boolean }) {
  const { label, icon: Icon, active, disabled, badge, shortcutLabel, onClick } = item
  const tooltip = formatTooltipLabel(label, shortcutLabel)
  const ariaLabel = badge ? `${tooltip} (${badge})` : tooltip

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            roomsV2
              ? 'relative inline-flex size-[34px] items-center justify-center rounded-[11px] bg-sidebar-accent/40 text-muted-foreground transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60 focus-visible:ring-offset-0'
              : 'relative inline-flex size-10 items-center justify-center rounded-xl bg-transparent text-muted-foreground transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60 focus-visible:ring-offset-0',
            active
              ? roomsV2
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'text-primary hover:bg-sidebar-accent/70 bg-sidebar-accent/70'
              : 'hover:bg-sidebar-accent/40 hover:text-sidebar-foreground',
          )}
          onClick={onClick}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-pressed={active}
          aria-current={active ? 'true' : undefined}
        >
          {active && !roomsV2 ? (
            <span
              aria-hidden="true"
              className="absolute left-1 top-2 bottom-2 w-0.5 rounded-full bg-primary"
            />
          ) : null}
          <Icon className="size-[18px]" strokeWidth={1.75} />
          {badge && badge > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold leading-none tabular-nums text-white shadow-sm ring-2 ring-sidebar"
            >
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

export function ActivityRail({ items, cortex, roomsV2 = false }: ActivityRailProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <nav
        className={cn(
          'hidden h-full w-12 shrink-0 flex-col items-center gap-1.5 bg-sidebar py-2 md:flex',
          roomsV2 ? 'border-x border-sidebar-border' : 'border-r border-sidebar-border',
        )}
        aria-label="Activity rail"
      >
        {items.map((item) => (
          <div key={item.id} className="flex w-full flex-col items-center gap-1.5">
            <ActivityRailButton item={item} roomsV2={roomsV2} />
          </div>
        ))}
        {roomsV2 && cortex ? (
          <div className="mt-auto flex w-full justify-center" data-testid="cortex-rail-slot">
            {cortex}
          </div>
        ) : null}
      </nav>
    </TooltipProvider>
  )
}
