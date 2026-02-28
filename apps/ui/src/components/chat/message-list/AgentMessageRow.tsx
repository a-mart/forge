import { SourceBadge, formatTimestamp } from './message-row-utils'
import type { AgentMessageEntry } from './types'

export function AgentMessageRow({
  message,
}: {
  message: AgentMessageEntry
}) {
  const fromLabel =
    message.source === 'user_to_agent' ? 'User' : message.fromAgentId?.trim() || 'Agent'
  const toLabel = message.toAgentId.trim() || 'Unknown'
  const normalizedText = message.text.trim()
  const attachmentCount = message.attachmentCount ?? 0
  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext

  const deliveryLabel =
    message.requestedDelivery || message.acceptedMode
      ? [
          message.requestedDelivery ? `requested ${message.requestedDelivery}` : null,
          message.acceptedMode ? `accepted ${message.acceptedMode}` : null,
        ]
          .filter(Boolean)
          .join(' • ')
      : null

  return (
    <div className="rounded-lg border border-slate-300/70 bg-slate-50/75 px-3 py-2 text-sm text-slate-800 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-200">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-700/80 dark:text-slate-300/90">
        <span>{fromLabel}</span>
        <span>→</span>
        <span>{toLabel}</span>
        {deliveryLabel ? (
          <span className="normal-case tracking-normal text-slate-700/70 dark:text-slate-300/75">
            • {deliveryLabel}
          </span>
        ) : null}
      </div>

      <div className="mt-1 space-y-1.5">
        {normalizedText ? (
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            {normalizedText}
          </p>
        ) : null}

        {attachmentCount > 0 ? (
          <p className="text-[11px] text-slate-700/80 dark:text-slate-300/80">
            Sent {attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}
          </p>
        ) : null}

        {!normalizedText && attachmentCount === 0 ? (
          <p className="text-[11px] italic text-slate-700/70 dark:text-slate-300/70">
            (empty message)
          </p>
        ) : null}
      </div>

      {timestampLabel || sourceContext ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-700/75 dark:text-slate-300/75">
          <SourceBadge sourceContext={sourceContext} />
          {timestampLabel ? <span>{timestampLabel}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
