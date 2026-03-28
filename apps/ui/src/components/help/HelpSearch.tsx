import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, FileText } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { searchArticles } from './help-registry'
import { formatCategory } from './help-utils'
import { useHelp } from './help-hooks'
import { cn } from '@/lib/utils'
import type { HelpArticle } from './help-types'

interface HelpSearchProps {
  className?: string
}

export function HelpSearch({ className }: HelpSearchProps) {
  const { searchQuery, setSearch, openArticle } = useHelp()
  const [localQuery, setLocalQuery] = useState(searchQuery)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Sync external query changes (e.g. cleared by category switch)
  useEffect(() => {
    setLocalQuery(searchQuery)
  }, [searchQuery])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setLocalQuery(value)

      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }

      debounceRef.current = setTimeout(() => {
        setSearch(value)
      }, 200)
    },
    [setSearch],
  )

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  const results = useMemo(() => {
    if (!searchQuery.trim()) return []
    return searchArticles(searchQuery)
  }, [searchQuery])

  const hasQuery = searchQuery.trim().length > 0

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="text"
          placeholder="Search help articles..."
          value={localQuery}
          onChange={handleChange}
          className="h-8 border-border/50 bg-muted/30 pl-9 text-sm placeholder:text-muted-foreground/60"
          aria-label="Search help articles"
        />
      </div>

      {hasQuery && (
        <div className="mt-3">
          {results.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Search className="size-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                No articles matching &ldquo;{searchQuery}&rdquo;
              </p>
            </div>
          ) : (
            <ScrollArea className="max-h-[calc(100vh-240px)]">
              <div className="space-y-1">
                <p className="mb-2 text-xs text-muted-foreground">
                  {results.length} result{results.length !== 1 ? 's' : ''}
                </p>
                {results.map((article) => (
                  <SearchResultItem
                    key={article.id}
                    article={article}
                    query={searchQuery}
                    onClick={() => openArticle(article.id)}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      )}
    </div>
  )
}

function SearchResultItem({
  article,
  query,
  onClick,
}: {
  article: HelpArticle
  query: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left',
        'transition-colors hover:bg-accent/50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            <HighlightMatch text={article.title} query={query} />
          </span>
          <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0">
            {formatCategory(article.category)}
          </Badge>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          <HighlightMatch text={article.summary} query={query} />
        </p>
      </div>
    </button>
  )
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${escaped})`, 'gi')
  const parts = text.split(regex)

  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="rounded-sm bg-primary/20 text-foreground">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}


