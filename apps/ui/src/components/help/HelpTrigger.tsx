import { CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useHelp } from './help-hooks'
import { cn } from '@/lib/utils'

interface HelpTriggerProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
  contextKey: string
  articleId?: string
  size?: 'sm' | 'md'
  variant?: 'ghost' | 'outline'
  className?: string
}

export function HelpTrigger({
  contextKey,
  articleId,
  size = 'md',
  variant = 'ghost',
  className,
  ...rest
}: HelpTriggerProps) {
  const { openDrawer, openArticle } = useHelp()

  const handleClick = () => {
    if (articleId) {
      openArticle(articleId)
    } else {
      openDrawer(contextKey)
    }
  }

  const iconSize = size === 'sm' ? 'size-3.5' : 'size-4'
  const buttonSize = size === 'sm' ? 'size-7' : 'size-8'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={variant}
          className={cn(
            buttonSize,
            'shrink-0 rounded-md p-0 text-muted-foreground transition-colors hover:text-foreground',
            className,
          )}
          onClick={handleClick}
          aria-label="Help"
          {...rest}
        >
          <CircleHelp className={iconSize} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        Help (Ctrl+/)
      </TooltipContent>
    </Tooltip>
  )
}
