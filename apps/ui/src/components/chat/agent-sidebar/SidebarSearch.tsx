import type { ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface SidebarSearchProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  /** Optional element rendered to the right of the classic search input. */
  rightAction?: ReactNode
  /** Project View chip inserted into the Rooms command row. */
  commandAction?: ReactNode
  /** Gates the consolidated Rooms command row. */
  roomsV2?: boolean
}

export function SidebarSearch({
  searchQuery,
  onSearchChange,
  searchInputRef,
  rightAction,
  commandAction,
  roomsV2 = false,
}: SidebarSearchProps) {
  if (roomsV2) {
    return (
      <div className="px-2 py-2" data-testid="sidebar-command-row">
        <div className="flex h-8 items-center gap-1.5 rounded-[9px] bg-sidebar-accent/50 px-2">
          <Search className="pointer-events-none size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
          {commandAction}
          <div className="relative min-w-0 flex-1">
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search…"
              className="h-7 border-0 bg-transparent px-0 pr-11 text-xs shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
            />
            {searchQuery.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  onSearchChange('')
                  searchInputRef.current?.focus()
                }}
                className="absolute right-6 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                aria-label="Clear search"
              >
                <X className="size-3" />
              </button>
            ) : null}
            <kbd className={cn(
              'pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-[10px] font-normal text-muted-foreground/55',
              searchQuery.length > 0 && 'opacity-0',
            )}>
              ⌘K
            </kbd>
          </div>
          {rightAction}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" aria-hidden="true" />
        <Input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search sessions… ⌘K"
          className="h-7 pl-7 pr-7 text-xs placeholder:text-muted-foreground/50"
        />
        {searchQuery.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              onSearchChange('')
              searchInputRef.current?.focus()
            }}
            className="absolute right-1.5 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            aria-label="Clear search"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
      {rightAction}
    </div>
  )
}
