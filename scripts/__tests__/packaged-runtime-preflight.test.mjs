import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  loadRuntimeModuleFromEntry,
  pickPackageEntryFromExports,
  resolveStagedPackageEntryFromManifest,
  validateStagedPiAiPackageDir,
  validateStagedPiCodingAgentPackageDir,
  validateStagedBetterSqlite3PackageDir,
  BACKEND_BUNDLE_EXTERNAL_PACKAGES,
} from '../../apps/electron/scripts/build-all.mjs'
import {
  assertNodePtySmokeResult,
  assertResolvedInsideStage,
  NODE_PTY_SMOKE_MARKER,
  NODE_PTY_SMOKE_SCRIPT,
  nodePtySmokeCommand,
  STAGED_ELECTRON_NATIVE_PACKAGES,
} from '../../apps/electron/scripts/staged-native-runtime-smoke.mjs'

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
    expect(names).toContain('better-sqlite3')
    expect(BACKEND_BUNDLE_EXTERNAL_PACKAGES.find((pkg) => pkg.name === 'better-sqlite3')?.validateWithElectronOnly).toBe(true)
  })
})

describe('staged Electron-as-Node native runtime smoke', () => {
  it('covers every native-capable packaged backend dependency', () => {
    expect(STAGED_ELECTRON_NATIVE_PACKAGES).toEqual([
      'better-sqlite3',
      'sqlite3',
      'node-pty',
      'sharp',
      'koffi',
    ])
  })

  it('uses cmd.exe for the Windows ConPTY smoke and enforces its marker/exit result', () => {
    expect(nodePtySmokeCommand('win32', 'C:\\Windows\\System32\\cmd.exe')).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', `echo ${NODE_PTY_SMOKE_MARKER}`],
    })
    expect(nodePtySmokeCommand('darwin').args).toEqual(['-e', NODE_PTY_SMOKE_SCRIPT])
    expect(() => assertNodePtySmokeResult(0, NODE_PTY_SMOKE_MARKER)).not.toThrow()
    expect(() => assertNodePtySmokeResult(0, '')).toThrow('node-pty smoke failed')
    expect(() => assertNodePtySmokeResult(1, NODE_PTY_SMOKE_MARKER)).toThrow('node-pty smoke failed')
  })

  it('accepts only entries physically inside staged node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-native-stage-'))
    const stagedNodeModules = join(root, 'stage', 'node_modules')
    const stagedEntry = join(stagedNodeModules, 'sharp', 'index.js')
    const repoFallback = join(root, 'node_modules', 'sharp', 'index.js')
    await mkdir(dirname(stagedEntry), { recursive: true })
    await mkdir(dirname(repoFallback), { recursive: true })
    await writeFile(stagedEntry, 'module.exports = {}')
    await writeFile(repoFallback, 'module.exports = {}')

    expect(assertResolvedInsideStage(stagedEntry, stagedNodeModules, 'sharp')).toBe(realpathSync(stagedEntry))
    expect(() => assertResolvedInsideStage(repoFallback, stagedNodeModules, 'sharp')).toThrow(
      'sharp resolved outside staged node_modules',
    )
  })
})

describe('validateStagedBetterSqlite3PackageDir', () => {
  it('requires the package implementation and Electron native binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-better-sqlite3-'))

    await mkdir(join(root, 'lib'), { recursive: true })
    await mkdir(join(root, 'build', 'Release'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'lib', 'database.js'), 'module.exports = function Database() {}')
    await writeFile(join(root, 'build', 'Release', 'better_sqlite3.node'), 'fixture')

    expect(validateStagedBetterSqlite3PackageDir(root)).toBeNull()
  })

  it('rejects staged packages without the native binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-better-sqlite3-missing-'))

    await mkdir(join(root, 'lib'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'lib', 'database.js'), 'module.exports = function Database() {}')

    expect(validateStagedBetterSqlite3PackageDir(root)).toContain('better_sqlite3.node')
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
      if (process.env.FORGE_REQUIRE_ELECTRON_NODE_GATE === '1') {
        throw new Error(
          'FORGE_REQUIRE_ELECTRON_NODE_GATE=1 but apps/electron/node_modules/.bin/electron is missing; install Electron workspace deps before this gate',
        )
      }
      return
    }

    const result = spawnSync(electronBin, ['-p', 'process.versions.node'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    })
    expect(result.status, `electron -p process.versions.node failed: ${result.stderr || result.error || ''}`).toBe(0)
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

describe('Pi package-relative theme/export assets (no bundle-relative duplicates)', () => {
  it('resolves getThemesDir and getExportTemplateDir inside the installed pi-coding-agent package', async () => {
    const { realpathSync } = await import('node:fs')
    const candidates = [
      join(repoRoot, 'apps/backend/node_modules/@earendil-works/pi-coding-agent'),
      join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent'),
    ]
    let packageDir
    for (const candidate of candidates) {
      try {
        await access(join(candidate, 'package.json'))
        packageDir = realpathSync(candidate)
        break
      } catch {
        // try next
      }
    }
    expect(packageDir, 'installed @earendil-works/pi-coding-agent').toBeTruthy()
    const config = await import(pathToFileURL(join(packageDir, 'dist', 'config.js')).href)
    const themesDir = realpathSync(config.getThemesDir())
    const exportDir = realpathSync(config.getExportTemplateDir())

    expect(themesDir.startsWith(packageDir)).toBe(true)
    expect(exportDir.startsWith(packageDir)).toBe(true)
    await access(join(themesDir, 'dark.json'))
    await access(join(exportDir, 'template.html'))
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
