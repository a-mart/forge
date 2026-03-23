import { Badge } from '@/components/ui/badge'
import type { ModelDistributionEntry } from '@forge/protocol'

interface ModelDistributionProps {
  models: ModelDistributionEntry[]
}

export function ModelDistribution({ models }: ModelDistributionProps) {
  if (models.length === 0) {
    return null
  }

  return (
    <div>
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Top Models
      </h3>
      <div className="flex flex-wrap gap-2">
        {models.map((model) => (
          <Badge
            key={model.modelId}
            variant="secondary"
            className="gap-1.5 px-3 py-1.5 text-sm"
          >
            <span className="font-medium">{model.displayName}</span>
            <span className="text-muted-foreground">
              {model.percentage.toFixed(1)}%
            </span>
          </Badge>
        ))}
      </div>
    </div>
  )
}
