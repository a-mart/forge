import type { ReactNode } from 'react'
import { CODEX_MENTION_HANDLE } from './mention-types'

export const MENTION_TOKEN_RE = /\[@[^\]]+\]/gi

/** True when the @ trigger sits at the leading edge of the composer text. */
export function isLeadingMentionPosition(text: string, atIdx: number): boolean {
  return text.slice(0, atIdx).trim().length === 0
}

function normalizeMentionHandle(token: string): string {
  return token.slice(2, -1).trim()
}

function isCodexMentionToken(token: string): boolean {
  return normalizeMentionHandle(token).toLowerCase() === CODEX_MENTION_HANDLE.toLowerCase()
}

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
    const handle = normalizeMentionHandle(match[0])
    const isCodex = isCodexMentionToken(match[0])
    parts.push(
      <span
        key={start}
        className={
          isCodex
            ? 'rounded-sm bg-emerald-500/15 dark:bg-emerald-400/15'
            : 'rounded-sm bg-blue-500/10 dark:bg-blue-400/10'
        }
      >
        <span className="text-transparent">[</span>
        <span
          className={
            isCodex
              ? 'font-medium text-emerald-700 dark:text-emerald-300'
              : 'text-blue-600 dark:text-blue-400'
          }
        >
          @{handle}
        </span>
        <span className="text-transparent">]</span>
      </span>,
    )
    lastIdx = end
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx))
  }
  parts.push('\n')
  return parts
}

export function hasComposerMentionTokens(text: string): boolean {
  return /\[@[^\]]+\]/i.test(text)
}
