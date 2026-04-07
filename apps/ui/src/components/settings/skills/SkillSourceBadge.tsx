import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const SOURCE_LABELS: Record<string, string> = {
  builtin: 'Builtin',
  repo: 'Repo',
  'machine-local': 'Local',
  profile: 'Profile',
}

const SOURCE_CLASSES: Record<string, string> = {
  builtin: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  repo: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'machine-local': 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  profile: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
}

interface SkillSourceBadgeProps {
  sourceKind: string
  className?: string
}

export function SkillSourceBadge({ sourceKind, className }: SkillSourceBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'px-1.5 py-0 text-[10px] font-medium leading-4',
        SOURCE_CLASSES[sourceKind] ?? 'border-border',
        className,
      )}
    >
      {SOURCE_LABELS[sourceKind] ?? sourceKind}
    </Badge>
  )
}
