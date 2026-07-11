import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  loadRuntimeModuleFromEntry,
  pickPackageEntryFromExports,
  resolveStagedPackageEntryFromManifest,
  validateStagedPiAiPackageDir,
  validateStagedPiCodingAgentPackageDir,
  BACKEND_BUNDLE_EXTERNAL_PACKAGES,
} from '../../apps/electron/scripts/build-all.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

function satisfiesNodeFloor(version, minimum = '22.19.0') {
  const parse = (value) => {
    const match = String(value).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
    if (!match) return null
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
  }
  const left = parse(version)
  const right = parse(minimum)
  if (!left || !right) return false
  if (left.major !== right.major) return left.major > right.major
  if (left.minor !== right.minor) return left.minor > right.minor
  return left.patch >= right.patch
}

describe('BACKEND_BUNDLE_EXTERNAL_PACKAGES packaging', () => {
  it('requires koffi and the coherent Pi family in packaged-runtime preflight', () => {
    const names = BACKEND_BUNDLE_EXTERNAL_PACKAGES.map((pkg) => pkg.name)
    const koffi = BACKEND_BUNDLE_EXTERNAL_PACKAGES.find((pkg) => pkg.name === 'koffi')
    expect(koffi).toBeTruthy()
    expect(koffi?.optional).toBe(false)
    expect(names).toContain('@earendil-works/pi-ai')
    expect(names).toContain('@earendil-works/pi-coding-agent')
    expect(names).toContain('@mariozechner/clipboard')
  })
})

describe('Node engine floor for packaged Electron child', () => {
  it('pins package.json engines.node to >=22.19.0', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    expect(pkg.engines?.node).toBe('>=22.19.0')
  })

  it('requires host Node to satisfy >=22.19.0', () => {
    expect(satisfiesNodeFloor(process.version)).toBe(true)
  })

  it('asserts Electron bundled Node satisfies >=22.19.0 when electron is available', async () => {
    const electronBin = join(repoRoot, 'apps/electron/node_modules/.bin/electron')
    try {
      await access(electronBin)
    } catch {
      return
    }

    const result = spawnSync(electronBin, ['-p', 'process.versions.node'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    })
    if (result.status !== 0) {
      return
    }
    const bundledNode = String(result.stdout || '').trim()
    expect(bundledNode.length).toBeGreaterThan(0)
    expect(satisfiesNodeFloor(bundledNode)).toBe(true)
  })
})

describe('validateStagedPiCodingAgentPackageDir', () => {
  it('accepts staged pi-coding-agent dirs with public package assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-pi-coding-agent-'))

    await mkdir(join(root, 'dist', 'core', 'export-html'), { recursive: true })
    await mkdir(join(root, 'dist', 'modes', 'interactive', 'theme'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'dist', 'index.js'), 'export class AgentSession {}')

    expect(validateStagedPiCodingAgentPackageDir(root)).toBeNull()
  })

  it('reports missing public package assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-pi-coding-agent-missing-'))

    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')

    expect(validateStagedPiCodingAgentPackageDir(root)).toContain('index.js')
  })
})

describe('validateStagedPiAiPackageDir', () => {
  it('accepts staged pi-ai dirs with compat and api subpaths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-pi-ai-'))

    await mkdir(join(root, 'dist', 'api'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.80.6' }))
    await writeFile(join(root, 'dist', 'index.js'), 'export function createProvider() {}')
    await writeFile(join(root, 'dist', 'compat.js'), 'export function registerFauxProvider() {}')

    expect(validateStagedPiAiPackageDir(root)).toBeNull()
  })

  it('reports missing compat/api assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-pi-ai-missing-'))

    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'dist', 'index.js'), 'export function createProvider() {}')

    expect(validateStagedPiAiPackageDir(root)).toContain('compat.js')
  })
})

describe('resolveStagedPackageEntryFromManifest', () => {
  it('resolves import-only package exports to the staged entry path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-esm-only-package-'))

    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        type: 'module',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
          },
        },
      }),
    )
    await writeFile(join(root, 'dist', 'index.js'), 'export function compact() {}')

    expect(pickPackageEntryFromExports({ import: './dist/index.js' })).toBe('./dist/index.js')
    expect(resolveStagedPackageEntryFromManifest(root)).toBe(join(root, 'dist', 'index.js'))
  })

  it('loads import-only staged package entries via dynamic import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-esm-only-load-'))
    const packageDir = join(root, 'node_modules', '@example', 'esm-only')

    await mkdir(join(packageDir, 'dist'), { recursive: true })
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@example/esm-only',
        type: 'module',
        exports: {
          '.': {
            import: './dist/index.js',
          },
        },
      }),
    )
    await writeFile(join(packageDir, 'dist', 'index.js'), 'export function compact() { return true }')
    await writeFile(join(root, 'bundle.cjs'), 'module.exports = {};\n')

    const resolvedEntry = resolveStagedPackageEntryFromManifest(packageDir)
    expect(resolvedEntry).toBe(join(packageDir, 'dist', 'index.js'))

    const stagedRequire = createRequire(join(root, 'bundle.cjs'))
    expect(() => stagedRequire.resolve('@example/esm-only')).toThrow(/No "exports" main defined/)

    const loadedModule = await loadRuntimeModuleFromEntry(stagedRequire, resolvedEntry)
    expect(typeof loadedModule.compact).toBe('function')
    expect(loadedModule.compact()).toBe(true)
  })

  it('loads staged package modules from public dist paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-pi-public-load-'))

    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'index.js'), 'export class AgentSession {}')

    const stagedRequire = createRequire(join(root, 'package.json'))
    const publicModule = await loadRuntimeModuleFromEntry(stagedRequire, join(root, 'dist', 'index.js'))

    expect(typeof publicModule.AgentSession).toBe('function')
  })
})
