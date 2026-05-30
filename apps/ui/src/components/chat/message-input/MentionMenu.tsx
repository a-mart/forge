import { type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { isCodexMentionSuggestion, type MentionSuggestion } from './mention-types'

interface MentionMenuProps {
  menuRef: RefObject<HTMLDivElement | null>
  mentions: MentionSuggestion[]
  selectedIndex: number
  onSelect: (suggestion: MentionSuggestion) => void
  onHover: (index: number) => void
  /** True when the menu is open but filtered results are empty. */
  showEmpty: boolean
  enableCodexMention?: boolean
}

export function MentionMenu({
  menuRef,
  mentions,
  selectedIndex,
  onSelect,
  onHover,
  showEmpty,
  enableCodexMention = false,
}: MentionMenuProps) {
  if (mentions.length > 0) {
    return (
      <div
        ref={menuRef}
        className="mb-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
      >
        {mentions.map((suggestion, idx) => {
          const isCodex = isCodexMentionSuggestion(suggestion)
          return (
            <button
              key={isCodex ? 'codex-mention' : suggestion.agentId}
              type="button"
              className={cn(
                'flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors',
                idx === selectedIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'text-popover-foreground hover:bg-accent/50',
              )}
              onMouseEnter={() => onHover(idx)}
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(suggestion)
              }}
            >
              <div className="flex items-center gap-2">
                {isCodex ? (
                  <img
                    src="/agents/codex-logo.svg"
                    alt=""
                    aria-hidden
                    className="size-4 shrink-0 dark:invert"
                  />
                ) : null}
                <code
                  className={cn(
                    'shrink-0 text-xs font-semibold',
                    isCodex ? 'text-emerald-700 dark:text-emerald-300' : 'text-foreground',
                  )}
                >
                  @{suggestion.handle}
                </code>
                <span className="text-xs text-muted-foreground">{suggestion.displayName}</span>
                {isCodex ? (
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                    Codex
                  </span>
                ) : null}
              </div>
              {suggestion.whenToUse ? (
                <span className="line-clamp-1 text-xs text-muted-foreground">{suggestion.whenToUse}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    )
  }

  if (showEmpty) {
    return (
      <div
        ref={menuRef}
        className="mb-1 rounded-lg border border-border bg-popover px-3 py-2 shadow-lg"
      >
        <p className="text-xs text-muted-foreground">
          {enableCodexMention ? 'No matching mentions' : 'No matching project agents'}
        </p>
      </div>
    )
  }

  return null
}
