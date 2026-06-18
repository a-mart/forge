/** Max UTF-8 bytes for eager per-line syntax highlighting in Session Audit detail. */
export const SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_BYTES = 256 * 1024

/** Max logical lines for eager per-line syntax highlighting. */
export const SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_LINES = 500

/** Max characters in a single line before falling back to plain rendering. */
export const SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_LINE_CHARS = 16_384

export function countUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export function shouldUsePlainJsonDetailView(text: string): boolean {
  if (!text) {
    return false
  }
  if (countUtf8Bytes(text) > SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_BYTES) {
    return true
  }
  const lines = text.split('\n')
  if (lines.length > SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_LINES) {
    return true
  }
  return lines.some((line) => line.length > SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_LINE_CHARS)
}
