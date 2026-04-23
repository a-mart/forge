import { cn } from '@/lib/utils'
import type { ActiveSurface } from '@/hooks/index-page/use-route-state'

interface ModeSwitchProps {
  activeSurface: ActiveSurface
  onSelectSurface: (surface: ActiveSurface) => void
  className?: string
}

export function ModeSwitch({ activeSurface, onSelectSurface, className }: ModeSwitchProps) {
  return (
    <div className={cn('inline-flex w-full rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-1', className)}>
      {(['builder', 'collab'] as const).map((surface) => {
        const isActive = activeSurface === surface
        return (
          <button
            key={surface}
            type="button"
            onClick={() => onSelectSurface(surface)}
            className={cn(
              'flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors',
              isActive
                ? 'bg-sidebar text-sidebar-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
            )}
            aria-pressed={isActive}
          >
            {surface}
          </button>
        )
      })}
    </div>
  )
}
