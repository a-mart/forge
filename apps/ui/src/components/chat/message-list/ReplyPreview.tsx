import { MessageSquareReply, X } from 'lucide-react'
import type { ConversationReplyTarget, ConversationReplyTargetInput } from '@forge/protocol'
import { cn } from '@/lib/utils'

export type ReplyPreviewTarget = ConversationReplyTarget | ConversationReplyTargetInput

type ReplyPreviewTone = 'composer' | 'user-message'

function roleLabel(role?: ReplyPreviewTarget['role']): string {
  if (role === 'assistant') return 'Assistant'
  if (role === 'user') return 'You'
  if (role === 'system') return 'System'
  return 'Message'
}

function attachmentLabel(count?: number): string | null {
  if (!count || count <= 0) return null
  return `+ ${count} attachment${count === 1 ? '' : 's'}`
}

type ReplyPreviewProps = {
  target: ReplyPreviewTarget
  tone?: ReplyPreviewTone
  className?: string
} & (
  | {
      interactive?: false
      disabled?: never
      onClick?: never
      onClear?: () => void
    }
  | {
      interactive: true
      disabled?: boolean
      onClick?: () => void
      onClear?: never
    }
)

export function ReplyPreview(props: ReplyPreviewProps) {
  const {
    target,
    tone = 'composer',
    disabled = false,
    className,
    interactive,
    onClick,
  } = props
  const label = `Replying to ${roleLabel(target.role)}`
  const trimmedText = target.text?.trim() ?? ''
  const attachments = attachmentLabel(target.attachmentCount)
  const preview = trimmedText || attachments || 'Message'
  const content = (
    <>
      <div
        className={cn(
          'mt-0.5 border-l-2 pl-2',
          tone === 'user-message'
            ? 'border-primary-foreground/35'
            : 'border-primary/35',
        )}
      >
        <div className="flex items-center gap-1 text-[11px] font-medium leading-tight opacity-80">
          <MessageSquareReply className="size-3" />
          <span>{label}</span>
        </div>
        <div className="mt-0.5 line-clamp-2 break-words text-xs leading-snug opacity-90">
          {preview}
          {trimmedText && attachments ? <span className="ml-1 opacity-75">{attachments}</span> : null}
        </div>
      </div>
      {!interactive && props.onClear ? (
        <button
          type="button"
          onClick={props.onClear}
          className="ml-2 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Clear reply target"
          title="Clear reply target"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </>
  )

  const baseClassName = cn(
    'flex min-w-0 items-start rounded-lg px-2.5 py-2',
    tone === 'user-message'
      ? 'bg-primary-foreground/10 text-primary-foreground/90'
      : 'bg-muted/60 text-muted-foreground',
    disabled && 'cursor-not-allowed opacity-70',
    className,
  )

  const interactiveHoverClass = tone === 'user-message' ? 'hover:bg-primary-foreground/15' : 'hover:bg-muted'

  if (interactive) {
    return (
      <button
        type="button"
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        className={cn(
          baseClassName,
          'w-full text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          !disabled && interactiveHoverClass,
        )}
        title={disabled ? 'Original message is not loaded' : 'Scroll to original message'}
        aria-label={disabled ? `${label}. Original message is not loaded.` : `${label}. Scroll to original message.`}
      >
        {content}
      </button>
    )
  }

  return <div className={baseClassName}>{content}</div>
}
