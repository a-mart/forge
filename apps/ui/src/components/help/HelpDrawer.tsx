import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
// NOTE: We use overflow-y-auto with custom scrollbar styles instead of shadcn
// ScrollArea to match the sidebar and message list scrollbar styling.
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

// ── Drawer resize ──

const HELP_DRAWER_WIDTH_KEY = 'forge-help-drawer-width'
const DEFAULT_DRAWER_WIDTH = 700
const MIN_DRAWER_WIDTH = 450
const MAX_DRAWER_WIDTH = 1000

function loadDrawerWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_DRAWER_WIDTH
  try {
    const stored = window.localStorage.getItem(HELP_DRAWER_WIDTH_KEY)
    if (stored) {
      const w = parseInt(stored, 10)
      if (w >= MIN_DRAWER_WIDTH && w <= MAX_DRAWER_WIDTH) return w
    }
  } catch { /* ignore */ }
  return DEFAULT_DRAWER_WIDTH
}

function persistDrawerWidth(width: number): void {
  try {
    window.localStorage.setItem(HELP_DRAWER_WIDTH_KEY, String(width))
  } catch { /* ignore */ }
}

function useDrawerResize() {
  const [width, setWidth] = useState(loadDrawerWidth)
  const [isResizing, setIsResizing] = useState(false)
  const widthRef = useRef(width)

  useEffect(() => {
    widthRef.current = width
  }, [width])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
    const startX = e.clientX
    const startWidth = widthRef.current

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // Dragging left = increasing width (handle is on left edge of right-side sheet)
      const delta = startX - moveEvent.clientX
      const newWidth = Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, startWidth + delta))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      persistDrawerWidth(widthRef.current)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

  return { width, isResizing, handleResizeStart }
}

// ── Categories ──

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

  const { width: drawerWidth, isResizing, handleResizeStart } = useDrawerResize()

  const handleBack = () => {
    // Clear article selection to go back to list
    openArticle(null)
  }

  return (
    <Sheet open={isDrawerOpen} onOpenChange={(open) => !open && closeDrawer()}>
      <SheetContent
        side="right"
        showCloseButton
        className={cn(
          'gap-0 overflow-hidden p-0',
          // Mobile: full width
          'w-full max-w-full',
          // Desktop: use CSS custom property for resizable width
          'sm:w-[var(--help-drawer-w)] sm:max-w-[var(--help-drawer-w)]',
        )}
        style={{ '--help-drawer-w': `${drawerWidth}px` } as React.CSSProperties}
      >
        {/* Resize handle on left edge (desktop only) */}
        <div
          className={cn(
            'absolute left-0 top-0 bottom-0 z-10 hidden w-1.5 cursor-col-resize select-none sm:block',
            'hover:bg-primary/20',
            isResizing && 'bg-primary/30',
          )}
          onMouseDown={handleResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize help panel"
          aria-valuenow={drawerWidth}
          aria-valuemin={MIN_DRAWER_WIDTH}
          aria-valuemax={MAX_DRAWER_WIDTH}
        />

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
              <div
                className={cn(
                  'min-h-0 flex-1 overflow-y-auto p-2',
                  '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
                  '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
                  '[scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent]',
                )}
              >
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


