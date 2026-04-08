import { type RefObject } from 'react'
import { cn } from '@/lib/utils'
import type { SlashCommand } from '@/components/settings/slash-commands-api'

interface SlashCommandMenuProps {
  menuRef: RefObject<HTMLDivElement | null>
  commands: SlashCommand[]
  selectedIndex: number
  onSelect: (command: SlashCommand) => void
  onHover: (index: number) => void
  /** True when the menu is open but filtered results are empty. */
  showEmpty: boolean
}

export function SlashCommandMenu({
  menuRef,
  commands,
  selectedIndex,
  onSelect,
  onHover,
  showEmpty,
}: SlashCommandMenuProps) {
  if (commands.length > 0) {
    return (
      <div
        ref={menuRef}
        className="mb-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
      >
        {commands.map((cmd, idx) => (
          <button
            key={cmd.id}
            type="button"
            className={cn(
              'flex w-full items-start gap-3 px-3 py-2 text-left text-sm transition-colors',
              idx === selectedIndex
                ? 'bg-accent text-accent-foreground'
                : 'text-popover-foreground hover:bg-accent/50',
            )}
            onMouseEnter={() => onHover(idx)}
            onMouseDown={(e) => {
              e.preventDefault() // prevent textarea blur
              onSelect(cmd)
            }}
          >
            <code className="shrink-0 text-xs font-semibold text-foreground">/{cmd.name}</code>
            <span className="line-clamp-1 text-xs text-muted-foreground">{cmd.prompt}</span>
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
        <p className="text-xs text-muted-foreground">No matching commands</p>
      </div>
    )
  }

  return null
}
