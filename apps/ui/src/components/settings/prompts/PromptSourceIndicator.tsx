import { Layers } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { PromptSourceLayer } from '@forge/protocol'

const LAYER_LABELS: Record<PromptSourceLayer, string> = {
  profile: 'Profile override',
  repo: 'Repository override (.swarm/)',
  builtin: 'Built-in default',
}

const LAYER_CLASSES: Record<PromptSourceLayer, string> = {
  profile: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  repo: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  builtin: 'border-border/50 bg-muted/50 text-muted-foreground',
}

interface PromptSourceIndicatorProps {
  sourceLayer: PromptSourceLayer
}

export function PromptSourceIndicator({ sourceLayer }: PromptSourceIndicatorProps) {
  return (
    <Badge variant="outline" className={`gap-1.5 ${LAYER_CLASSES[sourceLayer]}`}>
      <Layers className="size-3" />
      {LAYER_LABELS[sourceLayer]}
    </Badge>
  )
}
