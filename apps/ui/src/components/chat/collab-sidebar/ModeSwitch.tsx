import { cn } from '@/lib/utils'
import type { ActiveSurface } from '@/hooks/index-page/use-route-state'
import { useConnectionHealth, type ConnectionHealth } from '@/lib/connection-health-store'

interface ModeSwitchProps {
  activeSurface: ActiveSurface
  onSelectSurface: (surface: ActiveSurface) => void
  className?: string
}

const healthDotColor: Record<ConnectionHealth, string> = {
  connected: 'bg-emerald-500',
  reconnecting: 'bg-amber-500',
  disconnected: 'bg-muted-foreground/40',
}

const healthA11yLabel: Record<ConnectionHealth, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
}

export function ModeSwitch({ activeSurface, onSelectSurface, className }: ModeSwitchProps) {
  const health = useConnectionHealth()

  const healthBySurface: Record<ActiveSurface, ConnectionHealth> = {
    builder: health.builder,
    collab: health.collab,
  }

  return (
    <div className={cn('inline-flex w-full rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-1', className)}>
      {(['builder', 'collab'] as const).map((surface) => {
        const isActive = activeSurface === surface
        const surfaceHealth = healthBySurface[surface]
        return (
          <button
            key={surface}
            type="button"
            onClick={() => onSelectSurface(surface)}
            className={cn(
              'flex-1 inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors',
              isActive
                ? 'bg-sidebar text-sidebar-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
            )}
            aria-pressed={isActive}
          >
            <span
              className={cn('size-1.5 shrink-0 rounded-full', healthDotColor[surfaceHealth])}
              role="status"
              aria-label={`${surface} ${healthA11yLabel[surfaceHealth]}`}
            />
            {surface}
          </button>
        )
      })}
    </div>
  )
}
