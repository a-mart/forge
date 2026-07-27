import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const mainSourceUrl = new URL('../main.ts', import.meta.url)

describe('Desktop browser product copy', () => {
  it('uses Automatic Browser in the pop-out window and menu', async () => {
    const source = await readFile(mainSourceUrl, 'utf8')

    expect(source).toContain("title: 'Forge Automatic Browser'")
    expect(source).toContain("label: 'Pop Out / Dock Automatic Browser'")
    expect(source).not.toContain("title: 'Forge Managed Browser'")
    expect(source).not.toContain("label: 'Pop Out / Dock Managed Browser'")
  })
})
