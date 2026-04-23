import { Hash, MessageSquareText } from 'lucide-react'
import { cn } from '@/lib/utils'

type CollabEmptyStateVariant = 'no-channel' | 'empty-channel'

interface CollabEmptyStateProps {
  variant: CollabEmptyStateVariant
  channelName?: string
  className?: string
}

export function CollabEmptyState({
  variant,
  channelName,
  className,
}: CollabEmptyStateProps) {
  const config =
    variant === 'empty-channel'
      ? {
          icon: MessageSquareText,
          title: 'Start the conversation',
          description: channelName
            ? `#${channelName} is ready for the first message.`
            : 'This channel is ready for the first message.',
        }
      : {
          icon: Hash,
          title: 'Select a channel',
          description: 'Choose a channel from the sidebar to open the workspace.',
        }

  const Icon = config.icon

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-1 items-center justify-center px-6 py-10',
        className,
      )}
    >
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-border/70 bg-card/70 text-muted-foreground shadow-sm">
          <Icon className="size-5" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">{config.title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{config.description}</p>
      </div>
    </div>
  )
}
