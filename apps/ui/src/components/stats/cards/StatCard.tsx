import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface StatCardProps {
  title: string
  value: string
  unit?: string
  subtitle?: ReactNode
  className?: string
  variant?: 'default' | 'accent'
}

export function StatCard({
  title,
  value,
  unit,
  subtitle,
  className,
  variant = 'default',
}: StatCardProps) {
  return (
    <Card
      className={cn(
        'border-border/50 bg-card/80 p-3 backdrop-blur-sm',
        variant === 'accent' && 'border-l-2 border-l-primary/50',
        className,
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-bold leading-none text-foreground">
          {value}
        </span>
        {unit ? (
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {unit}
          </span>
        ) : null}
      </div>
      {subtitle ? (
        <div className="mt-1 text-xs text-muted-foreground/80">{subtitle}</div>
      ) : null}
    </Card>
  )
}
