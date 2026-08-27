import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8'))
}

describe('release version consistency', () => {
  it('keeps the displayed runtime version aligned with the Electron package version', () => {
    const runtimeVersion = readJson('version.json').version
    const electronVersion = readJson('apps/electron/package.json').version

    expect(typeof runtimeVersion).toBe('string')
    expect(runtimeVersion).not.toBe('')
    expect(electronVersion).toBe(runtimeVersion)
  })
})
