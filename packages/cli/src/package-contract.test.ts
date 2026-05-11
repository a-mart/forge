import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { CLI_VERSION } from './version.js'

interface PackageJson {
  name: string
  version: string
  private?: boolean
  bin?: Record<string, string>
  files?: string[]
  publishConfig?: { access?: string }
}

describe('@forge/cli package contract', () => {
  it('is publishable with a stable forge bin and curated files', async () => {
    const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as PackageJson
    expect(packageJson.name).toBe('@forge/cli')
    expect(packageJson.version).toBe(CLI_VERSION)
    expect(packageJson.private).not.toBe(true)
    expect(packageJson.bin?.forge).toBe('./dist/cli.js')
    expect(packageJson.files).toEqual(['dist/cli.js', 'README.md', 'LICENSE'])
    expect(packageJson.publishConfig?.access).toBe('public')
  })
})
