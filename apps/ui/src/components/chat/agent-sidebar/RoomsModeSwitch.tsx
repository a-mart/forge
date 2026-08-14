import { cn } from '@/lib/utils'

export type RoomsMode = 'inbox' | 'projects'

export function RoomsModeSwitch({
  mode,
  needsYouCount,
  onChange,
}: {
  mode: RoomsMode
  needsYouCount?: number
  onChange: (mode: RoomsMode) => void
}) {
  return (
    <div
      className="mt-2 inline-flex w-full rounded-lg border border-sidebar-border bg-sidebar-accent/30 p-0.5"
      aria-label="New project view sidebar mode"
      data-testid="rooms-mode-switch"
    >
      <button
        type="button"
        aria-pressed={mode === 'inbox'}
        onClick={() => onChange('inbox')}
        className={cn(
          'flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
          mode === 'inbox' ? 'bg-sidebar text-sidebar-foreground shadow-sm' : 'text-muted-foreground hover:text-sidebar-foreground',
        )}
      >
        Inbox
        {needsYouCount && needsYouCount > 0 ? (
          <span className="sidebar-room-unread-badge" aria-label={`${needsYouCount} sessions need you`}>
            {needsYouCount > 99 ? '99+' : needsYouCount}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-pressed={mode === 'projects'}
        onClick={() => onChange('projects')}
        className={cn(
          'min-h-8 flex-1 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
          mode === 'projects' ? 'bg-sidebar text-sidebar-foreground shadow-sm' : 'text-muted-foreground hover:text-sidebar-foreground',
        )}
      >
        Projects
      </button>
    </div>
  )
}
