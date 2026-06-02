import { type RefObject } from 'react'
import { cn } from '@/lib/utils'
import {
  isCodexMentionSuggestion,
  isCodexToolMentionSuggestion,
  type MentionSuggestion,
} from './mention-types'

export type MentionMenuStatus =
  | 'list'
  | 'loading'
  | 'error'
  | 'empty-catalog'
  | 'empty-filter'

interface MentionMenuProps {
  menuRef: RefObject<HTMLDivElement | null>
  listboxId: string
  status: MentionMenuStatus
  mentions: MentionSuggestion[]
  selectedIndex: number
  onSelect: (suggestion: MentionSuggestion) => void
  onHover: (index: number) => void
  enableCodexMention?: boolean
  codexToolPicker?: boolean
}

function optionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`
}

function emptyMessage(
  status: MentionMenuStatus,
  enableCodexMention: boolean,
  codexToolPicker: boolean,
): string {
  if (status === 'loading') {
    return 'Loading Codex tools…'
  }
  if (status === 'error') {
    return 'Could not load Codex tools. Try again in a moment.'
  }
  if (status === 'empty-catalog') {
    return 'No Codex tools available'
  }
  if (codexToolPicker) {
    return 'No matching Codex tools'
  }
  return enableCodexMention ? 'No matching mentions' : 'No matching project agents'
}

export function MentionMenu({
  menuRef,
  listboxId,
  status,
  mentions,
  selectedIndex,
  onSelect,
  onHover,
  enableCodexMention = false,
  codexToolPicker = false,
}: MentionMenuProps) {
  if (status === 'list' && mentions.length > 0) {
    return (
      <div
        ref={menuRef}
        id={listboxId}
        role="listbox"
        aria-label="Mentions"
        className="mb-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
      >
        {mentions.map((suggestion, idx) => {
          const isCodex = isCodexMentionSuggestion(suggestion)
          const isCodexTool = isCodexToolMentionSuggestion(suggestion)
          const tokenLabel = isCodexTool
            ? `@Codex:${suggestion.selector}`
            : isCodex
              ? `@${suggestion.handle}`
              : `@${suggestion.handle}`
          const id = optionId(listboxId, idx)
          return (
            <button
              key={
                isCodex
                  ? 'codex-mention'
                  : isCodexTool
                    ? `codex-tool-${suggestion.selector}`
                    : suggestion.agentId
              }
              id={id}
              type="button"
              role="option"
              aria-selected={idx === selectedIndex}
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
                {isCodex || isCodexTool ? (
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
                    isCodex || isCodexTool
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-foreground',
                  )}
                >
                  {tokenLabel}
                </code>
                <span className="text-xs text-muted-foreground">{suggestion.displayName}</span>
                {isCodex || isCodexTool ? (
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

  if (status === 'loading' || status === 'error' || status === 'empty-catalog' || status === 'empty-filter') {
    return (
      <div
        ref={menuRef}
        id={listboxId}
        role="listbox"
        aria-label="Mentions"
        aria-busy={status === 'loading'}
        className="mb-1 rounded-lg border border-border bg-popover px-3 py-2 shadow-lg"
      >
        <p className="text-xs text-muted-foreground" role="status">
          {emptyMessage(status, enableCodexMention, codexToolPicker)}
        </p>
      </div>
    )
  }

  return null
}

export function mentionMenuActiveDescendantId(
  listboxId: string,
  status: MentionMenuStatus,
  selectedIndex: number,
): string | undefined {
  if (status !== 'list') {
    return undefined
  }
  return optionId(listboxId, selectedIndex)
}
