import { type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { mentionMenuOptionId, type MentionMenuStatus } from './mention-menu-a11y'
import {
  isCodexMentionSuggestion,
  isCodexPluginMentionSuggestion,
  isCodexToolMentionSuggestion,
  type MentionSuggestion,
} from './mention-types'

export type { MentionMenuStatus } from './mention-menu-a11y'

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
  codexCatalogErrorMessage?: string
}

function codexCatalogFailureMessage(errorMessage: string | undefined): string {
  if (!errorMessage) {
    return 'Could not load Codex plugins. Try again in a moment.'
  }

  if (/failed to reload config|config\.toml|unknown variant/i.test(errorMessage)) {
    return 'Could not load Codex plugins: Codex rejected ~/.codex/config.toml. Check the Codex config and try again.'
  }

  if (/(?:spawn|enoent).*(?:codex|vendor)|(?:codex|vendor).*(?:spawn|enoent)/i.test(errorMessage)) {
    return 'Could not load Codex plugins: Forge could not start Codex. Reinstall Codex and try again.'
  }

  return 'Could not load Codex plugins. Try again in a moment.'
}

function emptyMessage(
  status: MentionMenuStatus,
  enableCodexMention: boolean,
  codexToolPicker: boolean,
  codexCatalogErrorMessage?: string,
): string {
  if (status === 'loading') {
    return 'Loading Codex plugins…'
  }
  if (status === 'error') {
    return codexCatalogFailureMessage(codexCatalogErrorMessage)
  }
  if (status === 'empty-catalog') {
    return 'No Codex plugins available'
  }
  if (codexToolPicker) {
    return 'No matching Codex plugins'
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
  codexCatalogErrorMessage,
}: MentionMenuProps) {
  if (status === 'list' && mentions.length > 0) {
    return (
      <div
        ref={menuRef}
        id={listboxId}
        role="listbox"
        aria-label="Mentions"
        className={cn(
          'mb-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg',
          '[color-scheme:light] dark:[color-scheme:dark]',
          '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
          '[&::-webkit-scrollbar-thumb:hover]:bg-border/80',
          '[scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent]',
        )}
      >
        {mentions.map((suggestion, idx) => {
          const isCodex = isCodexMentionSuggestion(suggestion)
          const isCodexPlugin = isCodexPluginMentionSuggestion(suggestion)
          const tokenLabel = isCodexPlugin
            ? `@Codex:${suggestion.selector}`
            : isCodex
              ? `@${suggestion.handle}`
              : isCodexToolMentionSuggestion(suggestion)
                ? `@Codex:${suggestion.selector}`
                : `@${suggestion.handle}`
          const id = mentionMenuOptionId(listboxId, idx)
          return (
            <button
              key={
                isCodex
                  ? 'codex-mention'
                  : isCodexPlugin
                    ? `codex-plugin-${suggestion.selector}`
                    : isCodexToolMentionSuggestion(suggestion)
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
                {isCodex || isCodexPlugin ? (
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
                    isCodex || isCodexPlugin
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-foreground',
                  )}
                >
                  {tokenLabel}
                </code>
                <span className="text-xs text-muted-foreground">{suggestion.displayName}</span>
                {isCodex || isCodexPlugin ? (
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
          {emptyMessage(status, enableCodexMention, codexToolPicker, codexCatalogErrorMessage)}
        </p>
      </div>
    )
  }

  return null
}
