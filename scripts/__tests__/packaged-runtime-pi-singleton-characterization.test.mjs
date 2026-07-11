/**
 * Electron / packaged-runtime Pi singleton characterization (post-0.80.6 pin).
 * Documents the current split risk: pi-coding-agent is externalized; pi-ai is not (WP-9).
 */
import { realpathSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BACKEND_BUNDLE_EXTERNAL_PACKAGES } from '../../apps/electron/scripts/build-all.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

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
  it('externalizes pi-coding-agent but not pi-ai (known Electron split risk; WP-9)', () => {
    const names = BACKEND_BUNDLE_EXTERNAL_PACKAGES.map((pkg) => pkg.name)
    expect(names).toContain('@earendil-works/pi-coding-agent')
    expect(names).not.toContain('@earendil-works/pi-ai')
    expect(names).not.toContain('@earendil-works/pi-ai/compat')
    expect(names).toContain('@mariozechner/clipboard')
  })

  it('source install resolves one pi-ai/compat realpath for Forge and coding-agent parents', async () => {
    const codingAgentIndex = findPackageFile('@earendil-works/pi-coding-agent', 'dist/index.js')
    const compatFromBackendTree = findPackageFile('@earendil-works/pi-ai', 'dist/compat.js')
    const nestedCandidate = join(
      dirname(dirname(codingAgentIndex)),
      'node_modules',
      '@earendil-works',
      'pi-ai',
      'dist',
      'compat.js',
    )
    const fromCoding = existsSync(nestedCandidate)
      ? realpathSync(nestedCandidate)
      : realpathSync(compatFromBackendTree)
    const fromBackend = realpathSync(compatFromBackendTree)
    expect(fromBackend).toBe(fromCoding)

    const backendMod = await import(pathToFileURL(fromBackend).href)
    const codingMod = await import(pathToFileURL(fromCoding).href)
    expect(backendMod.registerFauxProvider).toBe(codingMod.registerFauxProvider)
    expect(backendMod.getModel).toBe(codingMod.getModel)
  })

  it('records that WP-9 must externalize every pi-ai subpath after the earendil pin', () => {
    const external = BACKEND_BUNDLE_EXTERNAL_PACKAGES.find(
      (pkg) => pkg.name === '@earendil-works/pi-coding-agent',
    )
    expect(external?.optional).toBe(false)
    expect(BACKEND_BUNDLE_EXTERNAL_PACKAGES.some((pkg) => pkg.name.includes('pi-ai'))).toBe(false)
  })
})
