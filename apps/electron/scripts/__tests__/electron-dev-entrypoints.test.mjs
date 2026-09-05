import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('Electron development entrypoints', () => {
  it('prepares External Chrome resources before start without launching Electron', async () => {
    const manifest = JSON.parse(await readFile(path.join(electronDir, 'package.json'), 'utf8'))
    const prepare = 'pnpm prepare:dev-external-chrome'
    expect(manifest.scripts.dev).toContain(prepare)
    expect(manifest.scripts.start).toContain(prepare)
    expect(manifest.scripts.start).toMatch(
      /^pnpm verify:runtime && pnpm prepare:dev-native && pnpm prepare:dev-external-chrome && node \.\/scripts\/run-electron-dev\.mjs$/,
    )
    expect(manifest.scripts.start.indexOf(prepare)).toBeLessThan(manifest.scripts.start.indexOf('run-electron-dev.mjs'))
  })
})
