import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createElectronDevelopmentSetupCommands } from '../../../../scripts/dev-electron.mjs'

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('Electron development entrypoints', () => {
  it('stages Chrome resources in the root Windows launcher before the main-process build and UI startup', () => {
    const commands = createElectronDevelopmentSetupCommands({ environment: {}, platform: 'win32' })
    const chromeIndex = commands.findIndex(({ label }) => label === 'External Chrome development preparation')
    const nativeIndex = commands.findIndex(({ label }) => label === 'Electron native preparation')
    const buildIndex = commands.findIndex(({ label }) => label === 'Electron main-process build')
    expect(chromeIndex).toBeGreaterThan(nativeIndex)
    expect(chromeIndex).toBeLessThan(buildIndex)
    expect(commands[chromeIndex]).toEqual({
      label: 'External Chrome development preparation',
      command: process.execPath,
      args: [path.join(electronDir, 'scripts', 'prepare-external-chrome-dev.mjs')],
      cwd: electronDir,
    })
  })

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
