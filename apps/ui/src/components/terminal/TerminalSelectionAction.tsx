import { MessageSquarePlus } from 'lucide-react'

interface TerminalSelectionActionProps {
  top: number
  left: number
  onAddToChat: () => void
}

export function TerminalSelectionAction({ top, left, onAddToChat }: TerminalSelectionActionProps) {
  return (
    <button
      type="button"
      className="absolute z-30 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/70 px-2.5 py-1 text-[11px] font-medium text-zinc-200 shadow-lg backdrop-blur-sm transition-all hover:bg-white/15 hover:text-white active:scale-95"
      style={{ top, left }}
      onMouseDown={(e) => {
        // Prevent xterm from stealing focus / clearing selection before we grab it
        e.preventDefault()
        e.stopPropagation()
        onAddToChat()
      }}
    >
      <MessageSquarePlus className="size-3" />
      Add to Chat
    </button>
  )
}
