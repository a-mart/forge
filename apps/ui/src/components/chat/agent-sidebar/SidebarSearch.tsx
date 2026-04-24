import type { ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'

interface SidebarSearchProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  /** Optional element rendered to the right of the search input (e.g. "New Project" icon). */
  rightAction?: ReactNode
}

export function SidebarSearch({ searchQuery, onSearchChange, searchInputRef, rightAction }: SidebarSearchProps) {
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
