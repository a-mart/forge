import { cn } from '@/lib/utils'
import type { ActiveSurface } from '@/hooks/index-page/use-route-state'

interface ModeSwitchProps {
  activeSurface: ActiveSurface
  onSelectSurface: (surface: ActiveSurface) => void
  /** Builder WebSocket connection state — drives the Builder status dot. */
  connected?: boolean
  className?: string
}

export function ModeSwitch({ activeSurface, onSelectSurface, connected, className }: ModeSwitchProps) {
  return (
    <div className={cn('inline-flex w-full rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-1', className)}>
      {(['builder', 'collab'] as const).map((surface) => {
        const isActive = activeSurface === surface
        // Builder dot: green when connected, amber when disconnected.
        // Collab dot: always neutral muted (true WS state not exposed here).
        const dotColor =
          surface === 'builder'
            ? connected ? 'bg-emerald-500' : 'bg-amber-500'
            : 'bg-muted-foreground/50'
        const dotTitle =
          surface === 'builder'
            ? connected ? 'Connected' : 'Reconnecting'
            : 'Available'
        return (
          <button
            key={surface}
            type="button"
            onClick={() => onSelectSurface(surface)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors',
              isActive
                ? 'bg-sidebar text-sidebar-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
            )}
            aria-pressed={isActive}
          >
            <span
              className={cn('inline-block size-1.5 shrink-0 rounded-full', dotColor)}
              aria-hidden="true"
              title={dotTitle}
            />
            {surface}
          </button>
        )
      })}
    </div>
  )
}
