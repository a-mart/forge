import { cn } from '@/lib/utils'
import type { ConnectionHealth } from '@/lib/connection-health-store'

interface ConnectionSectionHeaderProps {
  label: string
  health: ConnectionHealth
  totalUnread: number
  isActive: boolean
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

function formatUnreadCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export function ConnectionSectionHeader({
  label,
  health,
  totalUnread,
  isActive,
}: ConnectionSectionHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wide',
        isActive
          ? 'text-sidebar-foreground'
          : 'text-muted-foreground',
      )}
    >
      <span
        className={cn('size-1.5 shrink-0 rounded-full', healthDotColor[health])}
        role="status"
        aria-label={`${label} ${healthA11yLabel[health]}`}
      />
      <span className="min-w-0 truncate">{label}</span>
      {totalUnread > 0 ? (
        <span className="ml-auto shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-sky-400">
          {formatUnreadCount(totalUnread)}
        </span>
      ) : null}
    </div>
  )
}
