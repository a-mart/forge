/**
 * Electron / packaged-runtime Pi singleton characterization (WP-9).
 */
import { realpathSync, existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BACKEND_BUNDLE_EXTERNAL_PACKAGES, assertPiFamilySingletonManifests } from '../../apps/electron/scripts/build-all.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

function findPackageRootFrom(packageName, startDirectory) {
  const parts = packageName.startsWith('@') ? packageName.split('/') : [packageName]
  let current = realpathSync(startDirectory)
  for (let i = 0; i < 12; i++) {
    const candidate = join(current, 'node_modules', ...parts)
    if (existsSync(candidate)) return realpathSync(candidate)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`Unable to locate ${packageName} from ${startDirectory}`)
}

function findPackageFile(packageName, relativeFile) {
  const parts = packageName.startsWith('@') ? packageName.split('/') : [packageName]
  let current = join(repoRoot, 'apps/backend')
  for (let i = 0; i < 8; i++) {
    const candidate = join(current, 'node_modules', ...parts, relativeFile)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`Unable to locate ${packageName}/${relativeFile} under ${repoRoot}`)
}

describe('packaged-runtime Pi singleton characterization (0.80.6 pin)', () => {
  it('externalizes one coherent Pi family while preserving clipboard', () => {
    const names = BACKEND_BUNDLE_EXTERNAL_PACKAGES.map((pkg) => pkg.name)
    expect(names).toContain('@earendil-works/pi-coding-agent')
    expect(names).toContain('@earendil-works/pi-ai')
    expect(names).toContain('@mariozechner/clipboard')
    expect(names.filter((name) => name === '@earendil-works/pi-ai')).toHaveLength(1)
    expect(names.filter((name) => name === '@earendil-works/pi-coding-agent')).toHaveLength(1)
  })

  it('source install resolves one pi-ai/compat realpath for Forge and coding-agent parents', async () => {
    const codingAgentIndex = findPackageFile('@earendil-works/pi-coding-agent', 'dist/index.js')
    createRequire(join(repoRoot, 'apps/backend/package.json'))
    createRequire(codingAgentIndex)
    const backendPiAiRoot = findPackageRootFrom('@earendil-works/pi-ai', join(repoRoot, 'apps/backend'))
    const codingPiAiRoot = findPackageRootFrom('@earendil-works/pi-ai', dirname(codingAgentIndex))
    const fromBackend = realpathSync(join(backendPiAiRoot, 'dist', 'compat.js'))
    const fromCoding = realpathSync(join(codingPiAiRoot, 'dist', 'compat.js'))
    expect(fromBackend).toBe(fromCoding)

    const backendMod = await import(pathToFileURL(fromBackend).href)
    const codingMod = await import(pathToFileURL(fromCoding).href)
    expect(backendMod.registerFauxProvider).toBe(codingMod.registerFauxProvider)
    expect(backendMod.getModel).toBe(codingMod.getModel)
  })

  it('externalizes pi-ai root so esbuild package externalization also covers /compat and /api subpaths', () => {
    const piAi = BACKEND_BUNDLE_EXTERNAL_PACKAGES.find((pkg) => pkg.name === '@earendil-works/pi-ai')
    expect(piAi?.optional).toBe(false)
    expect(typeof piAi?.validateStagedPackageDir).toBe('function')
  })

  it('four-family pins are exact 0.80.6 and reject version skew in manifests', () => {
    const codingAgentIndex = findPackageFile('@earendil-works/pi-coding-agent', 'dist/index.js')
    const codingAgentRoot = findPackageRootFrom('@earendil-works/pi-coding-agent', join(repoRoot, 'apps/backend'))
    const family = [
      findPackageRootFrom('@earendil-works/pi-ai', join(repoRoot, 'apps/backend')),
      codingAgentRoot,
      findPackageRootFrom('@earendil-works/pi-agent-core', dirname(codingAgentIndex)),
      findPackageRootFrom('@earendil-works/pi-tui', dirname(codingAgentIndex)),
    ]
    const versions = family.map((packageDir) => JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version)
    expect(versions.every((version) => version === '0.80.6')).toBe(true)
    expect(new Set(versions).size).toBe(1)

    const skewDir = mkdtempSync(join(tmpdir(), 'forge-pi-skew-'))
    try {
      const names = [
        '@earendil-works/pi-ai',
        '@earendil-works/pi-coding-agent',
        '@earendil-works/pi-agent-core',
        '@earendil-works/pi-tui',
      ]
      for (const [index, name] of names.entries()) {
        const dir = join(skewDir, 'node_modules', ...name.split('/'))
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: index === 0 ? '0.80.5' : '0.80.6' }))
      }
      const skewed = new Map(
        names.map((name) => [name, join(skewDir, 'node_modules', ...name.split('/'))]),
      )
      // Exported production validator hard-fails when any family member !== 0.80.6.
      expect(() => assertPiFamilySingletonManifests(skewed)).toThrow(
        /expected @earendil-works\/pi-ai@0\.80\.6, got 0\.80\.5/,
      )
    } finally {
      rmSync(skewDir, { recursive: true, force: true })
    }
  })

  it('assertPiFamilySingletonManifests rejects missing duplicate staged roots', () => {
    const incomplete = new Map([
      ['@earendil-works/pi-ai', '/tmp/missing-pi-ai'],
      ['@earendil-works/pi-coding-agent', '/tmp/missing-pi-coding-agent'],
    ])
    expect(() => assertPiFamilySingletonManifests(incomplete)).toThrow(/missing staged Pi package/)
  })
})
