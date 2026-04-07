import { useCallback, useEffect, useRef } from 'react'
import { ChevronUp, ChevronDown, X, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ChatSearchState } from './useChatSearch'

interface ChatSearchBarProps {
  search: ChatSearchState
}

export function ChatSearchBar({ search }: ChatSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  // Autofocus when opened
  useEffect(() => {
    if (search.isOpen) {
      // Small delay to ensure the element is mounted
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [search.isOpen])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        search.close()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        search.prev()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        search.next()
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        search.prev()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        search.next()
      }
    },
    [search],
  )

  if (!search.isOpen) return null

  const hasQuery = search.query.length > 0
  const hasMatches = search.totalMatches > 0

  return (
    <div className="flex items-center gap-1.5 border-b border-border bg-background/95 px-3 py-1.5 backdrop-blur-sm">
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={search.query}
        onChange={(e) => search.setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in chat…"
        aria-label="Find in chat"
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />

      {hasQuery ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {hasMatches
            ? `${search.currentMatchIndex + 1} of ${search.totalMatches}`
            : 'No results'}
        </span>
      ) : null}

      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          disabled={!hasMatches}
          onClick={search.prev}
          aria-label="Previous match"
        >
          <ChevronUp className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          disabled={!hasMatches}
          onClick={search.next}
          aria-label="Next match"
        >
          <ChevronDown className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          onClick={search.close}
          aria-label="Close search"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
