import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8')

function blockAfter(source: string, prelude: string): string {
  const start = source.indexOf(prelude)
  if (start === -1) return ''
  const open = source.indexOf('{', start)
  if (open === -1) return ''
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  return ''
}

describe('global theme-consistent scrollbars', () => {
  it('makes native Chromium/Electron/Firefox chrome follow the Forge class theme', () => {
    expect(blockAfter(css, ':root {')).toMatch(/color-scheme:\s*light;/)
    expect(blockAfter(css, '.dark {')).toMatch(/color-scheme:\s*dark;/)
  })

  it('does not force classic webkit chrome or inherited scrollbar-color on the root', () => {
    expect(blockAfter(css, ':root {')).not.toMatch(/scrollbar-color/)
    expect(blockAfter(css, '.dark {')).not.toMatch(/scrollbar-color/)
    expect(css).not.toMatch(/(^|\n)::-webkit-scrollbar/)
  })

  it('gives Firefox a theme-token scrollbar color without affecting Chromium', () => {
    expect(css).toMatch(
      /@supports not selector\(\s*::-webkit-scrollbar\s*\)\s*\{\s*html\s*\{[^}]*scrollbar-color:\s*var\(--border\)\s+transparent;/,
    )
  })
})
