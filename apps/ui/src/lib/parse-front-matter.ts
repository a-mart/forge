/* ------------------------------------------------------------------ */
/*  YAML front matter parser (simple, no dependencies)                 */
/* ------------------------------------------------------------------ */

export interface FrontMatterResult {
  /** Parsed key-value entries (preserves original string values) */
  entries: Array<{ key: string; value: string }>
  /** Markdown body with front matter stripped */
  body: string
}

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Extract YAML front matter from markdown content.
 *
 * Returns null if there is no valid front matter block.
 * Uses a simple line-based parser — supports scalar values,
 * inline arrays (`[a, b]`), and multi-line block values.
 * Gracefully returns null on malformed input.
 */
export function parseFrontMatter(content: string): FrontMatterResult | null {
  const match = FRONT_MATTER_RE.exec(content)
  if (!match) return null

  const raw = match[1]
  const body = content.slice(match[0].length)

  const entries: Array<{ key: string; value: string }> = []

  try {
    const lines = raw.split(/\r?\n/)
    let i = 0
    while (i < lines.length) {
      const line = lines[i]

      // Skip blank lines and comments
      if (!line.trim() || line.trim().startsWith('#')) {
        i++
        continue
      }

      // Match "key: value" or "key:" (value on next lines)
      const kvMatch = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
      if (!kvMatch) {
        i++
        continue
      }

      const key = kvMatch[1]
      let value = kvMatch[2].trim()

      // Block scalar indicators (| or >) — collect indented continuation
      if (value === '|' || value === '>') {
        const blockLines: string[] = []
        i++
        while (i < lines.length && /^[ \t]{2,}/.test(lines[i])) {
          blockLines.push(lines[i].trim())
          i++
        }
        value = blockLines.length > 0 ? blockLines.join(' ') : ''
        entries.push({ key, value })
        continue
      }

      // Empty value — peek ahead for nested structure (list/mapping)
      if (!value) {
        const startNext = i + 1
        let j = startNext
        while (j < lines.length && /^[ \t]{2,}/.test(lines[j])) {
          j++
        }
        if (j > startNext) {
          // Indented block follows — treat as complex value
          entries.push({ key, value: '(complex value)' })
          i = j
          continue
        }
        entries.push({ key, value })
        i++
        continue
      }

      entries.push({ key, value })
      i++
    }
  } catch {
    // Malformed — just skip front matter display
    return null
  }

  return { entries, body }
}
