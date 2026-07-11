/**
 * Electron / packaged-runtime Pi singleton characterization (WP-9).
 */
import { realpathSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BACKEND_BUNDLE_EXTERNAL_PACKAGES,
  resolveStagedPackageSubpathFromManifest,
} from '../../apps/electron/scripts/build-all.mjs'

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
    const compatFromBackendTree = findPackageFile('@earendil-works/pi-ai', 'dist/compat.js')
    createRequire(codingAgentIndex)
    const fromCoding = realpathSync(resolveStagedPackageSubpathFromManifest(dirname(dirname(compatFromBackendTree)), './compat'))
    const fromBackend = realpathSync(compatFromBackendTree)
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
})
