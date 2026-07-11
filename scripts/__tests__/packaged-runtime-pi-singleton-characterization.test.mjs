/**
 * Electron / packaged-runtime Pi singleton characterization (pre-0.80.6 pin).
 * Documents the current split risk: pi-coding-agent is externalized; pi-ai is not.
 */
import { realpathSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BACKEND_BUNDLE_EXTERNAL_PACKAGES } from '../../apps/electron/scripts/build-all.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

function findPackageDistIndex(packageName) {
  const parts = packageName.startsWith('@') ? packageName.split('/') : [packageName]
  let current = join(repoRoot, 'apps/backend')
  for (let i = 0; i < 8; i++) {
    const candidate = join(current, 'node_modules', ...parts, 'dist', 'index.js')
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`Unable to locate ${packageName}/dist/index.js under ${repoRoot}`)
}

describe('packaged-runtime Pi singleton characterization (0.71.1 baseline)', () => {
  it('externalizes pi-coding-agent but not pi-ai (known Electron split risk)', () => {
    const names = BACKEND_BUNDLE_EXTERNAL_PACKAGES.map((pkg) => pkg.name)
    expect(names).toContain('@mariozechner/pi-coding-agent')
    expect(names).not.toContain('@mariozechner/pi-ai')
    expect(names).not.toContain('@earendil-works/pi-ai')
    expect(names).not.toContain('@earendil-works/pi-coding-agent')
  })

  it('source install resolves one pi-ai realpath beside coding-agent', async () => {
    const codingAgentIndex = findPackageDistIndex('@mariozechner/pi-coding-agent')
    const piAiFromBackendTree = findPackageDistIndex('@mariozechner/pi-ai')
    // Coding-agent's nested dependency should realpath to the same patched instance under pnpm.
    const nestedCandidate = join(
      dirname(dirname(codingAgentIndex)),
      'node_modules',
      '@mariozechner',
      'pi-ai',
      'dist',
      'index.js',
    )
    const fromCoding = existsSync(nestedCandidate)
      ? realpathSync(nestedCandidate)
      : realpathSync(piAiFromBackendTree)
    const fromBackend = realpathSync(piAiFromBackendTree)
    expect(fromBackend).toBe(fromCoding)

    const backendMod = await import(pathToFileURL(fromBackend).href)
    const codingMod = await import(pathToFileURL(fromCoding).href)
    expect(backendMod.registerFauxProvider).toBe(codingMod.registerFauxProvider)
    expect(backendMod.closeOpenAICodexWebSocketSessions).toBe(codingMod.closeOpenAICodexWebSocketSessions)
  })

  it('records that WP-9 must externalize every pi-ai subpath after the earendil pin', () => {
    const external = BACKEND_BUNDLE_EXTERNAL_PACKAGES.find(
      (pkg) => pkg.name === '@mariozechner/pi-coding-agent',
    )
    expect(external?.optional).toBe(false)
    expect(BACKEND_BUNDLE_EXTERNAL_PACKAGES.some((pkg) => pkg.name.includes('pi-ai'))).toBe(false)
  })
})
