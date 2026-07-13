import { memo } from 'react'
import { cn } from '@/lib/utils'
import { formatTimestamp } from './message-row-utils'

export const ProjectAgentMessageRow = memo(function ProjectAgentMessageRow({
  text,
  fromLabel,
  toLabel,
  outgoing,
  timestamp,
}: {
  text: string
  fromLabel: string
  toLabel: string
  outgoing: boolean
  timestamp: string
}) {
  const normalizedText = text.trim()
  const timestampLabel = formatTimestamp(timestamp)

  return (
    <div
      className={cn('flex', outgoing ? 'justify-end' : 'justify-start')}
      data-project-agent-direction={outgoing ? 'outgoing' : 'incoming'}
      data-project-agent-tone={outgoing ? 'blue' : 'sky'}
    >
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm',
          outgoing
            ? 'rounded-tr-sm bg-blue-600 text-white dark:bg-blue-600'
            : 'rounded-tl-sm border border-sky-300/70 bg-sky-50 text-sky-950 dark:border-sky-400/30 dark:bg-sky-500/15 dark:text-sky-100',
        )}
      >
        <div
          className={cn(
            'text-[10px] font-medium uppercase tracking-wide',
            outgoing ? 'text-white/75' : 'text-sky-700/85 dark:text-sky-300/90',
          )}
        >
          {fromLabel} → {toLabel}
        </div>

        {normalizedText ? (
          <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">
            {normalizedText}
          </p>
        ) : (
          <p
            className={cn(
              'mt-1 text-[11px] italic',
              outgoing ? 'text-white/65' : 'text-sky-700/70 dark:text-sky-300/70',
            )}
          >
            (empty message)
          </p>
        )}

        {timestampLabel ? (
          <div
            className={cn(
              'mt-1 text-[10px]',
              outgoing ? 'text-right text-white/65' : 'text-sky-700/70 dark:text-sky-300/70',
            )}
          >
            {timestampLabel}
          </div>
        ) : null}
      </div>
    </div>
  )
})
