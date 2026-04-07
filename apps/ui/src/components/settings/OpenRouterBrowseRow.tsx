import { Check, Loader2, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatTokenCount } from '@/lib/format-utils'
import type { AvailableOpenRouterModel } from './openrouter-api'

function formatPricing(pricing: AvailableOpenRouterModel['pricing']): string {
  if (!pricing) return '—'
  if (pricing.inputPerMillion === 0 && pricing.outputPerMillion === 0) return 'Free'
  return `$${pricing.inputPerMillion.toFixed(2)} / $${pricing.outputPerMillion.toFixed(2)}`
}

interface OpenRouterBrowseRowProps {
  model: AvailableOpenRouterModel
  isAdded: boolean
  isAdding: boolean
  onAdd: (model: AvailableOpenRouterModel) => void
}

export function OpenRouterBrowseRow({ model, isAdded, isAdding, onAdd }: OpenRouterBrowseRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-card/30 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-sm font-medium text-foreground">{model.displayName}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">{model.modelId}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{formatTokenCount(model.contextWindow)} ctx</span>
          <span>{formatTokenCount(model.maxOutputTokens)} out</span>
          <span>{formatPricing(model.pricing)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {model.supportsReasoning ? (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Reasoning</Badge>
          ) : null}
          {model.inputModes.includes('image') ? (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Vision</Badge>
          ) : null}
          {model.supportsTools ? (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Tools</Badge>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 pt-0.5">
        {isAdded ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <Check className="size-3.5" />
            Added
          </span>
        ) : isAdding ? (
          <Button type="button" variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" disabled>
            <Loader2 className="size-3 animate-spin" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => onAdd(model)}
          >
            <Plus className="size-3" />
            Add
          </Button>
        )}
      </div>
    </div>
  )
}
