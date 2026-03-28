import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getTooltip } from './help-registry'
import { useHelp } from './help-hooks'
import { cn } from '@/lib/utils'

interface HelpTooltipProps {
  id: string
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}

export function HelpTooltip({ id, children, side = 'top' }: HelpTooltipProps) {
  const { openArticle } = useHelp()
  const tooltip = getTooltip(id)

  if (!tooltip) {
    return <>{children}</>
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={4}
        className={cn(
          'max-w-[260px] text-pretty',
          tooltip.articleId && 'pb-2',
        )}
      >
        <span>{tooltip.text}</span>
        {tooltip.articleId && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              openArticle(tooltip.articleId!)
            }}
            className="mt-1.5 block text-[10px] text-primary/80 underline underline-offset-2 transition-colors hover:text-primary"
          >
            Learn more
          </button>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
