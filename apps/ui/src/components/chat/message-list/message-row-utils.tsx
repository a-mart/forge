/* eslint-disable react-refresh/only-export-components -- shared utility + tiny presentational badge co-located */
import { cn } from '@/lib/utils'
import type { MessageSourceContext } from '@forge/protocol'

export function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''

    const now = new Date()
    const isToday =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    const isSameYear = date.getFullYear() === now.getFullYear()

    const time = date.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    })

    if (isToday) return time

    const month = date.getMonth() + 1
    const day = date.getDate()

    if (isSameYear) return `${month}/${day} ${time}`

    return `${month}/${day}/${date.getFullYear()} ${time}`
  } catch {
    return ''
  }
}

function formatSourceBadge(sourceContext?: MessageSourceContext): string | null {
  if (!sourceContext) {
    return null
  }

  if (sourceContext.channel === 'web') {
    return 'Web'
  }

  const isDm = sourceContext.channelType === 'dm'

  let label = 'Telegram'

  if (isDm) {
    label = sourceContext.userId
      ? `Telegram DM ${sourceContext.userId}`
      : 'Telegram DM'
  } else if (sourceContext.channelId) {
    label = `Telegram ${sourceContext.channelId}`
  }

  if (sourceContext.threadTs) {
    return `${label} → thread`
  }

  return label
}

export function SourceBadge({
  sourceContext,
  isUser = false,
}: {
  sourceContext?: MessageSourceContext
  isUser?: boolean
}) {
  const label = formatSourceBadge(sourceContext)
  if (!label || !sourceContext) {
    return null
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        isUser
          ? 'border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground/90'
          : sourceContext.channel === 'telegram'
            ? 'border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300'
            : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      )}
    >
      [{label}]
    </span>
  )
}
