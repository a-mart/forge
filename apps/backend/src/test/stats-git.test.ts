import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readServerVersion } from '../stats/stats-git.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  delete process.env.FORGE_APP_VERSION
})

describe('readServerVersion', () => {
  it('prefers FORGE_APP_VERSION when present', async () => {
    const rootDir = await createTempRoot()
    process.env.FORGE_APP_VERSION = '9.9.9'
    await writeVersionFile(rootDir, '0.13.0')

    await expect(readServerVersion(rootDir)).resolves.toBe('9.9.9')
  })

  it('reads version.json when the env override is missing', async () => {
    const rootDir = await createTempRoot()
    await writeVersionFile(rootDir, '0.13.0')

    await expect(readServerVersion(rootDir)).resolves.toBe('0.13.0')
  })

  it('falls back to unknown when version.json is missing', async () => {
    const rootDir = await createTempRoot()

    await expect(readServerVersion(rootDir)).resolves.toBe('unknown')
  })
})

async function createTempRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'forge-version-'))
  tempRoots.push(rootDir)
  return rootDir
}

async function writeVersionFile(rootDir: string, version: string): Promise<void> {
  await writeFile(join(rootDir, 'version.json'), `${JSON.stringify({ version }, null, 2)}\n`, 'utf8')
}
