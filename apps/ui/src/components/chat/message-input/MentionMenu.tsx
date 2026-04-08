import { type RefObject } from 'react'
import { cn } from '@/lib/utils'
import type { ProjectAgentSuggestion } from './types'

interface MentionMenuProps {
  menuRef: RefObject<HTMLDivElement | null>
  mentions: ProjectAgentSuggestion[]
  selectedIndex: number
  onSelect: (agent: ProjectAgentSuggestion) => void
  onHover: (index: number) => void
  /** True when the menu is open but filtered results are empty. */
  showEmpty: boolean
}

export function MentionMenu({
  menuRef,
  mentions,
  selectedIndex,
  onSelect,
  onHover,
  showEmpty,
}: MentionMenuProps) {
  if (mentions.length > 0) {
    return (
      <div
        ref={menuRef}
        className="mb-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
      >
        {mentions.map((agent, idx) => (
          <button
            key={agent.agentId}
            type="button"
            className={cn(
              'flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors',
              idx === selectedIndex
                ? 'bg-accent text-accent-foreground'
                : 'text-popover-foreground hover:bg-accent/50',
            )}
            onMouseEnter={() => onHover(idx)}
            onMouseDown={(e) => {
              e.preventDefault() // prevent textarea blur
              onSelect(agent)
            }}
          >
            <div className="flex items-center gap-2">
              <code className="shrink-0 text-xs font-semibold text-foreground">@{agent.handle}</code>
              <span className="text-xs text-muted-foreground">{agent.displayName}</span>
            </div>
            {agent.whenToUse ? (
              <span className="line-clamp-1 text-xs text-muted-foreground">{agent.whenToUse}</span>
            ) : null}
          </button>
        ))}
      </div>
    )
  }

  if (showEmpty) {
    return (
      <div
        ref={menuRef}
        className="mb-1 rounded-lg border border-border bg-popover px-3 py-2 shadow-lg"
      >
        <p className="text-xs text-muted-foreground">No matching project agents</p>
      </div>
    )
  }

  return null
}
