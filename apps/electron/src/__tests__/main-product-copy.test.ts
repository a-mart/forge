import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const mainSourceUrl = new URL('../main.ts', import.meta.url)

describe('Desktop browser product copy', () => {
  it('uses Automatic Browser in surfaced copy and embedded-browser terminology for adapter isolation', async () => {
    const source = await readFile(mainSourceUrl, 'utf8')

    expect(source).toContain("title: 'Forge Automatic Browser'")
    expect(source).toContain("label: 'Pop Out / Dock Automatic Browser'")
    expect(source).toContain("console.error('Failed to dock Automatic Browser', error)")
    expect(source.match(/'Automatic Browser host is unavailable'/g)).toHaveLength(2)
    expect(source).toContain("'Automatic Browser pop-out viewport was not physically ready'")
    expect(source).toContain("'Automatic Browser dock viewport was not physically ready'")
    expect(source).toContain('`Automatic Browser ${owner} viewport did not become ready`')
    expect(source).toContain(
      '// External Chrome is optional; deployment failure must not disable the embedded browser or Desktop.',
    )
  })

  it('rejects retired product wording in runtime strings and comments', async () => {
    const source = await readFile(mainSourceUrl, 'utf8')
    const retiredCopy = source
      .split('\n')
      .map((line, index) => ({ line: index + 1, source: line.trim() }))
      .filter(({ source: line }) => /\bManaged Browser\b/.test(line) && /['"`]|\/\/|\/\*|^\*/.test(line))

    expect(retiredCopy).toEqual([])
  })

  it('preserves deliberate internal identifiers and the persisted window-state key', async () => {
    const source = await readFile(mainSourceUrl, 'utf8')

    expect(source).toContain('ManagedBrowserViewHost')
    expect(source).toContain('popOutManagedBrowser')
    expect(source).toContain('dockManagedBrowser')
    expect(source.match(/'managed-browser-window-state'/g)).toHaveLength(2)
  })
})
