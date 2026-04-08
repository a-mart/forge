import type { ReactNode } from 'react'

export const MENTION_TOKEN_RE = /\[@[^\]]+\]/g

/** Find the mention token range that contains or is bounded by the given cursor position. */
export function findMentionContaining(text: string, pos: number): { start: number; end: number } | null {
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const start = match.index!
    const end = start + match[0].length
    if (pos >= start && pos <= end) {
      return { start, end }
    }
  }
  return null
}

/** Render text with [@handle] tokens as styled mention chips for the overlay. */
export function renderMentionOverlay(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let lastIdx = 0
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const start = match.index!
    const end = start + match[0].length
    if (start > lastIdx) {
      parts.push(text.slice(lastIdx, start))
    }
    const handle = match[0].slice(2, -1)
    parts.push(
      <span key={start} className="rounded-sm bg-blue-500/10 dark:bg-blue-400/10">
        <span className="text-transparent">[</span>
        <span className="text-blue-600 dark:text-blue-400">@{handle}</span>
        <span className="text-transparent">]</span>
      </span>,
    )
    lastIdx = end
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx))
  }
  // Trailing newline matches textarea's implicit trailing line
  parts.push('\n')
  return parts
}
