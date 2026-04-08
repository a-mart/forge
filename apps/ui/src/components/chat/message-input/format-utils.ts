const BULLET_RE = /^- /
const NUMBERED_RE = /^(\d+)\. /

/** Returns the line containing the cursor and its start/end offsets within the full text. */
function getCurrentLine(text: string, cursorPos: number): { line: string; lineStart: number; lineEnd: number } {
  const lineStart = text.lastIndexOf('\n', cursorPos - 1) + 1
  let lineEnd = text.indexOf('\n', cursorPos)
  if (lineEnd === -1) lineEnd = text.length
  return { line: text.slice(lineStart, lineEnd), lineStart, lineEnd }
}

/**
 * Toggle a bullet-list prefix (`- `) on the current line.
 * Returns the updated text and new cursor position.
 */
export function toggleBulletList(
  text: string,
  cursorPos: number,
): { text: string; cursor: number } {
  const { line, lineStart, lineEnd } = getCurrentLine(text, cursorPos)

  if (BULLET_RE.test(line)) {
    // Remove bullet prefix
    const newLine = line.slice(2)
    return {
      text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
      cursor: Math.max(lineStart, cursorPos - 2),
    }
  }

  // If it has a numbered prefix, replace it
  const numMatch = NUMBERED_RE.exec(line)
  if (numMatch) {
    const prefixLen = numMatch[0].length
    const newLine = '- ' + line.slice(prefixLen)
    return {
      text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
      cursor: lineStart + 2 + Math.max(0, cursorPos - lineStart - prefixLen),
    }
  }

  // Add bullet prefix
  const newLine = '- ' + line
  return {
    text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
    cursor: cursorPos + 2,
  }
}

/**
 * Toggle a numbered-list prefix (`N. `) on the current line.
 * Auto-numbers based on preceding numbered lines.
 */
export function toggleNumberedList(
  text: string,
  cursorPos: number,
): { text: string; cursor: number } {
  const { line, lineStart, lineEnd } = getCurrentLine(text, cursorPos)

  const numMatch = NUMBERED_RE.exec(line)
  if (numMatch) {
    // Remove numbered prefix
    const prefixLen = numMatch[0].length
    const newLine = line.slice(prefixLen)
    return {
      text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
      cursor: Math.max(lineStart, cursorPos - prefixLen),
    }
  }

  // Determine the next number by looking at preceding lines
  let nextNumber = 1
  const textBefore = text.slice(0, lineStart)
  const linesBefore = textBefore.split('\n')
  for (let i = linesBefore.length - 1; i >= 0; i--) {
    const prevMatch = NUMBERED_RE.exec(linesBefore[i]!)
    if (prevMatch) {
      nextNumber = Number(prevMatch[1]) + 1
      break
    }
    // Stop if the previous line is non-empty and not a numbered list
    if (linesBefore[i]!.trim() !== '') break
  }

  const prefix = `${nextNumber}. `

  // If it has a bullet prefix, replace it
  if (BULLET_RE.test(line)) {
    const newLine = prefix + line.slice(2)
    return {
      text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
      cursor: lineStart + prefix.length + Math.max(0, cursorPos - lineStart - 2),
    }
  }

  // Add numbered prefix
  const newLine = prefix + line
  return {
    text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
    cursor: cursorPos + prefix.length,
  }
}
