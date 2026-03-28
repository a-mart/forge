import { useMemo } from 'react'
import { ArrowLeft, FileText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
// Uses overflow-y-auto with custom scrollbar to match sidebar/message list
import { MarkdownMessage } from '@/components/chat/MarkdownMessage'
import { getArticle } from './help-registry'
import { formatCategory } from './help-utils'
import { useHelp } from './help-hooks'
import { cn } from '@/lib/utils'

interface HelpArticleProps {
  articleId: string
  onBack: () => void
}

export function HelpArticle({ articleId, onBack }: HelpArticleProps) {
  const { openArticle } = useHelp()
  const article = useMemo(() => getArticle(articleId), [articleId])

  const relatedArticles = useMemo(() => {
    if (!article?.relatedIds?.length) return []
    return article.relatedIds
      .map((id) => getArticle(id))
      .filter((a): a is NonNullable<typeof a> => a != null)
  }, [article])

  if (!article) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm text-muted-foreground">Article not found.</p>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1.5 size-3.5" />
          Back
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Article header */}
      <div className="flex items-center gap-2 border-b border-border/40 px-4 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back
        </Button>
        <Badge variant="secondary" className="ml-auto shrink-0 text-[10px] px-1.5 py-0">
          {formatCategory(article.category)}
        </Badge>
      </div>

      {/* Article body */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
          '[scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent]',
        )}
      >
        <div className="px-4 py-4">
          <h2 className="mb-1.5 text-base font-semibold text-foreground">
            {article.title}
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            {article.summary}
          </p>

          <div>
            <MarkdownMessage content={article.content} variant="message" />
          </div>

          {/* Related articles */}
          {relatedArticles.length > 0 && (
            <div className="mt-6 border-t border-border/40 pt-4">
              <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Related
              </h3>
              <div className="space-y-1">
                {relatedArticles.map((related) => (
                  <button
                    key={related.id}
                    type="button"
                    onClick={() => openArticle(related.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left',
                      'transition-colors hover:bg-accent/50',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    )}
                  >
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        {related.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {related.summary}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


