import { useMemo } from 'react'
import { BookOpen, Compass, Keyboard } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useHelp } from './help-hooks'
import { HelpSearch } from './HelpSearch'
import { HelpArticle } from './HelpArticle'
import {
  getAllArticles,
  getArticle,
  getArticlesByCategory,
  getArticlesForContext,
  searchArticles,
} from './help-registry'
import { formatCategory } from './help-utils'
import { cn } from '@/lib/utils'
import type { HelpArticle as HelpArticleType, HelpCategory } from './help-types'

const CATEGORIES: { key: HelpCategory; label: string }[] = [
  { key: 'getting-started', label: 'Start' },
  { key: 'chat', label: 'Chat' },
  { key: 'settings', label: 'Settings' },
  { key: 'cortex', label: 'Cortex' },
  { key: 'models', label: 'Models' },
  { key: 'concepts', label: 'Concepts' },
  { key: 'terminals', label: 'Terminals' },
  { key: 'playwright', label: 'Playwright' },
]

export function HelpDrawer() {
  const {
    isDrawerOpen,
    activeArticleId,
    activeCategory,
    searchQuery,
    contextKey,
    hasCompletedTour,
    closeDrawer,
    openArticle,
    setCategory,
    startTour,
    toggleShortcutOverlay,
  } = useHelp()

  // Build the visible article list based on filters
  const articles = useMemo(() => {
    // If searching, search takes priority
    if (searchQuery.trim()) {
      const results = searchArticles(searchQuery)
      if (activeCategory) {
        return results.filter((a) => a.category === activeCategory)
      }
      return results
    }

    // If a category is selected, show that category
    if (activeCategory) {
      return getArticlesByCategory(activeCategory)
    }

    // Default: show context-relevant articles, falling back to all
    const contextArticles = getArticlesForContext(contextKey)
    if (contextArticles.length > 0) {
      return contextArticles
    }

    return getAllArticles()
  }, [searchQuery, activeCategory, contextKey])

  const handleBack = () => {
    // Clear article selection to go back to list
    openArticle(null)
  }

  return (
    <Sheet open={isDrawerOpen} onOpenChange={(open) => !open && closeDrawer()}>
      <SheetContent
        side="right"
        showCloseButton
        className="w-[420px] gap-0 overflow-hidden p-0 sm:w-[420px] sm:max-w-[420px]"
      >
        {/* Accessible description for screen readers */}
        <SheetDescription className="sr-only">
          Browse help articles, search documentation, and view keyboard shortcuts.
        </SheetDescription>

        {activeArticleId ? (
          /* Article detail view */
          <>
            <SheetTitle className="sr-only">
              {getArticle(activeArticleId)?.title ?? 'Help Article'}
            </SheetTitle>
            <HelpArticle articleId={activeArticleId} onBack={handleBack} />
          </>
        ) : (
          /* List view */
          <div className="flex h-full flex-col">
            {/* Header */}
            <SheetHeader className="gap-3 border-b border-border/40 p-4">
              <SheetTitle className="flex items-center gap-2 text-sm">
                <BookOpen className="size-4 text-muted-foreground" />
                Help
              </SheetTitle>

              {/* Search */}
              <HelpSearch />
            </SheetHeader>

            {/* Category filter bar */}
            <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border/40 px-4 py-2.5">
              <CategoryPill
                label="All"
                active={activeCategory === null}
                onClick={() => setCategory(null)}
              />
              {CATEGORIES.map((cat) => (
                <CategoryPill
                  key={cat.key}
                  label={cat.label}
                  active={activeCategory === cat.key}
                  onClick={() =>
                    setCategory(activeCategory === cat.key ? null : cat.key)
                  }
                />
              ))}
            </div>

            {/* Article list — hidden when search is active (HelpSearch renders its own results) */}
            {!searchQuery.trim() && (
              <ScrollArea className="flex-1">
                <div className="p-2">
                  {articles.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 py-12 text-center">
                      <BookOpen className="size-8 text-muted-foreground/30" />
                      <p className="text-sm text-muted-foreground">
                        No articles found.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {articles.map((article) => (
                        <ArticleListItem
                          key={article.id}
                          article={article}
                          onClick={() => openArticle(article.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </ScrollArea>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-border/40 px-4 py-2.5">
              <p className="text-[11px] text-muted-foreground/60">
                Press{' '}
                <kbd className="rounded border border-border/60 bg-muted/50 px-1 font-mono text-[10px]">
                  Ctrl+/
                </kbd>{' '}
                to toggle
              </p>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    closeDrawer()
                    startTour()
                  }}
                  className="h-6 gap-1.5 px-2 text-[11px] text-muted-foreground/60 hover:text-muted-foreground"
                >
                  <Compass className="size-3" />
                  {hasCompletedTour ? 'Restart tour' : 'Take a tour'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={toggleShortcutOverlay}
                  className="h-6 gap-1.5 px-2 text-[11px] text-muted-foreground/60 hover:text-muted-foreground"
                >
                  <Keyboard className="size-3" />
                  Shortcuts
                </Button>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function CategoryPill({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <Badge
      variant={active ? 'default' : 'outline'}
      className={cn(
        'cursor-pointer select-none whitespace-nowrap text-[11px] transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border-border/60 bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground',
      )}
      onClick={onClick}
    >
      {label}
    </Badge>
  )
}

function ArticleListItem({
  article,
  onClick,
}: {
  article: HelpArticleType
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left',
        'transition-colors hover:bg-accent/50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          {article.title}
        </span>
        <Badge
          variant="secondary"
          className="shrink-0 text-[10px] px-1.5 py-0"
        >
          {formatCategory(article.category)}
        </Badge>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">
        {article.summary}
      </p>
    </button>
  )
}


