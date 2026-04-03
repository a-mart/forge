import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatTokenCount } from '@/lib/format-utils'
import type { OpenRouterModelEntry } from '@forge/protocol'

interface OpenRouterModelCardProps {
  model: OpenRouterModelEntry
  onRemove: (modelId: string) => void
  isRemoving: boolean
}

export function OpenRouterModelCard({ model, onRemove, isRemoving }: OpenRouterModelCardProps) {
  const hasVision = model.inputModes.includes('image')

  return (
    <div className="group flex items-start justify-between gap-4 rounded-lg border border-border/70 bg-card/40 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{model.displayName}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{model.modelId}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Context {formatTokenCount(model.contextWindow)}</span>
          <span>Output {formatTokenCount(model.maxOutputTokens)}</span>
          {model.supportsReasoning ? (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Reasoning</Badge>
          ) : null}
          {hasVision ? (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Vision</Badge>
          ) : null}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
        onClick={() => onRemove(model.modelId)}
        disabled={isRemoving}
        aria-label={`Remove ${model.displayName}`}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
