import gracefulFs from 'graceful-fs'
import fs, { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import { prepareElectronBetterSqlite3Binding } from './prepare-dev-native.mjs'

gracefulFs.gracefulify(fs)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(electronDir, '..', '..')
const backendWorkspaceDir = path.join(repoRoot, 'apps', 'backend')
const backendWorkspaceManifestPath = path.join(backendWorkspaceDir, 'package.json')
const backendBuildEntry = path.join(backendWorkspaceDir, 'dist', 'index.js')
const uiWorkspaceDir = path.join(repoRoot, 'apps', 'ui')
const uiBuildOutputDir = path.join(uiWorkspaceDir, '.output')
const uiPublicOutputDir = path.join(uiBuildOutputDir, 'public')
const cliWorkspaceDir = path.join(repoRoot, 'packages', 'cli')
const cliBuiltEntry = path.join(cliWorkspaceDir, 'dist', 'cli.js')
const stageDir = path.join(electronDir, '.stage')
const releaseDir = path.join(electronDir, 'release')
const backendStageDir = path.join(stageDir, 'backend')
const backendStageBundlePath = path.join(backendStageDir, 'dist', 'index.mjs')
const backendStageMetafilePath = path.join(backendStageDir, 'dist', 'index.meta.json')
const backendStageNodeModulesDir = path.join(backendStageDir, 'node_modules')
const uiStageDir = path.join(stageDir, 'ui')
const cliStageDir = path.join(stageDir, 'cli')
const cliStagedEntry = path.join(cliStageDir, 'cli.js')
const forgeResourcesDir = path.join(stageDir, 'forge-resources')
const stagedBuiltinSkillsDir = path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'skills', 'builtins')
const stagedBuiltinArchetypesDir = path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'archetypes', 'builtins')
const stagedBuiltinSpecialistsDir = path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'specialists', 'builtins')
const pnpmCommand = 'pnpm'
const useShell = process.platform === 'win32'

export const BACKEND_BUNDLE_EXTERNAL_PACKAGES = [
  {
    name: 'sharp',
    optional: false,
    validateLoadedModule: (loadedModule) =>
      typeof loadedModule === 'function' && typeof loadedModule.versions === 'object'
        ? null
        : 'expected a callable export with versions metadata',
  },
  {
    name: 'node-pty',
    optional: false,
    validateLoadedModule: (loadedModule) =>
      typeof loadedModule?.spawn === 'function' ? null : 'expected a spawn() export',
  },
  {
    name: 'better-sqlite3',
    optional: false,
    validateWithElectronOnly: true,
    validateStagedPackageDir: (stagedPackageDir) => validateStagedBetterSqlite3PackageDir(stagedPackageDir),
  },
  {
    name: '@anthropic-ai/claude-agent-sdk',
    optional: false,
    validateLoadedModule: (loadedModule) =>
      typeof loadedModule?.query === 'function' ? null : 'expected a query() export',
    validateStagedPackageDir: (stagedPackageDir) => validateStagedClaudeSdkPackageDir(stagedPackageDir),
  },
  {
    name: '@cursor/sdk',
    optional: false,
    validateLoadedModule: (loadedModule) =>
      typeof loadedModule?.Agent?.create === 'function' ? null : 'expected an Agent.create() export',
    validateStagedPackageDir: (stagedPackageDir) => validateStagedCursorSdkPackageDir(stagedPackageDir),
  },
  {
    name: 'koffi',
    optional: false,
    validateLoadedModule: (loadedModule) =>
      typeof loadedModule?.struct === 'function' ? null : 'expected a struct() export',
  },
  {
    name: '@mariozechner/clipboard',
    optional: true,
    validateLoadedModule: (loadedModule) =>
      typeof loadedModule?.getText === 'function' && typeof loadedModule?.setText === 'function'
        ? null
        : 'expected getText()/setText() exports',
  },
  {
    name: '@earendil-works/pi-ai',
    optional: false,
    validateLoadedModule: (loadedModule) =>
      typeof loadedModule?.createProvider === 'function' ? null : 'expected a createProvider() export',
    validateStagedPackageDir: (stagedPackageDir) => validateStagedPiAiPackageDir(stagedPackageDir),
  },
  {
    name: '@earendil-works/pi-coding-agent',
    optional: false,
    validateLoadedModule: (loadedModule) =>
      typeof loadedModule?.compact === 'function' ? null : 'expected a compact() export',
    validateStagedPackageDir: (stagedPackageDir) => validateStagedPiCodingAgentPackageDir(stagedPackageDir),
  },
]
const PACKAGE_METADATA_DIRS_TO_PRUNE = new Set([
  '.github',
  '.vscode',
  '__tests__',
  'benchmark',
  'benchmarks',
  'doc',
  'docs',
  'example',
  'examples',
  'node_modules',
  'test',
  'tests',
])
const PACKAGE_SPECIFIC_DIRS_TO_PRUNE = new Map([
  ['koffi', new Set(['src', 'vendor'])],
  ['sharp', new Set(['install', 'src'])],
])
const PACKAGES_KEEP_DECLARATION_FILES = new Set(['@anthropic-ai/claude-agent-sdk', '@cursor/sdk'])
const declarationSuffixes = ['.d.ts', '.d.mts', '.d.cts']
const declarationMapSuffixes = ['.d.ts.map', '.d.mts.map', '.d.cts.map']
const docsPrefixes = ['license', 'changelog', 'readme']
const docsPrunableExtensions = new Set(['', '.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc', '.rtf'])
const NODE_BUILTIN_MODULES = new Set([...builtinModules, ...builtinModules.map((moduleName) => `node:${moduleName}`)])

export async function cleanReleaseDir(targetDir = releaseDir) {
  await mkdir(targetDir, { recursive: true })

  const entries = await fs.promises.readdir(targetDir)
  await Promise.all(entries.map((entry) => rm(path.join(targetDir, entry), { recursive: true, force: true })))

  console.log(`[electron/build-all] Cleaned release output directory ${targetDir} (${entries.length} entries removed)`)
}

async function main() {
  await cleanReleaseDir()
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })
  await cleanUiBuildOutput()

  await run(pnpmCommand, ['--dir', repoRoot, '--filter', '@forge/protocol', 'build'])
  await run(pnpmCommand, ['--dir', repoRoot, '--filter', '@forge/backend', 'build'])
  await run(pnpmCommand, ['--dir', repoRoot, '--filter', '@forge/ui', 'build'])
  await run(pnpmCommand, ['--dir', repoRoot, '--filter', '@forge/cli', 'build'])
  await run(pnpmCommand, ['--dir', electronDir, 'build'])

  await stageBundledBackend()
  await stageRendererAssets()
  await stageBackendResources()
  await stageCliArtifact()

  await assertExists(backendStageBundlePath, 'staged backend bundle entry')
  await assertExists(path.join(uiStageDir, 'index.html'), 'staged renderer entry')
  await assertExists(stagedBuiltinSkillsDir, 'staged built-in skills')
  await assertExists(stagedBuiltinArchetypesDir, 'staged built-in archetypes')
  await assertExists(stagedBuiltinSpecialistsDir, 'staged built-in specialists')
  await assertExists(cliStagedEntry, 'staged CLI entry')

  await validatePackagedRuntimePreflight()
  await validateStagedCliPreflight()
}

async function stageBundledBackend() {
  await mkdir(path.dirname(backendStageBundlePath), { recursive: true })

  const metafile = await esbuild({
    entryPoints: [backendBuildEntry],
    outfile: backendStageBundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node22'],
    external: BACKEND_BUNDLE_EXTERNAL_PACKAGES.map((pkg) => pkg.name),
    define: {
      'process.env.FORGE_BUNDLED_BACKEND': '"1"',
    },
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'info',
    legalComments: 'none',
    metafile: true,
  })
  await writeFile(backendStageMetafilePath, JSON.stringify(metafile, null, 2), 'utf8')

  // Stage backend package.json — needed at runtime by bundled dependencies
  // that walk up the directory tree looking for package.json (e.g. pi-coding-agent
  // reads version and piConfig from it).
  await cp(backendWorkspaceManifestPath, path.join(backendStageDir, 'package.json'))
  await stageBundledDependencyRuntimeAssets()

  const runtimePackages = await collectRuntimePackageClosure(
    BACKEND_BUNDLE_EXTERNAL_PACKAGES.map((pkg) => ({ packageName: pkg.name, optional: pkg.optional }))
  )
  await stageRuntimePackages(runtimePackages)
  await stageElectronBetterSqlite3Binding()

  const fileCount = await countFiles(backendStageDir)
  const stagedCount = runtimePackages.hoisted.length + runtimePackages.nested.length
  const nestedNote =
    runtimePackages.nested.length > 0
      ? ` (${runtimePackages.nested.length} nested versioned installs preserved)`
      : ''
  console.log(
    `[electron/build-all] Staged bundled backend with ${stagedCount} runtime packages${nestedNote} (${fileCount} files)`,
  )
}

export async function validatePackagedRuntimePreflight() {
  const stagedRequire = createRequire(backendStageBundlePath)
  const verifiedPackages = []

  for (const runtimePackage of BACKEND_BUNDLE_EXTERNAL_PACKAGES) {
    const stagedPackageDir = path.join(backendStageNodeModulesDir, ...runtimePackage.name.split('/'))
    if (!existsSync(stagedPackageDir)) {
      if (runtimePackage.optional) {
        console.log(`[electron/build-all] Packaged-runtime preflight skipped optional package ${runtimePackage.name} (not staged)`)
        continue
      }

      throw new Error(
        `Packaged-runtime preflight failed: staged runtime package directory is missing for ${runtimePackage.name} (${stagedPackageDir})`,
      )
    }

    const stagedPackageValidationFailure = runtimePackage.validateStagedPackageDir?.(stagedPackageDir)
    if (stagedPackageValidationFailure) {
      throw new Error(
        `Packaged-runtime preflight failed: staged runtime package directory for "${runtimePackage.name}" is invalid: ${stagedPackageValidationFailure}`,
      )
    }

    let resolvedEntry
    try {
      resolvedEntry = resolveStagedRuntimePackageEntry(stagedRequire, runtimePackage.name, stagedPackageDir)
    } catch (error) {
      throw new Error(
        `Packaged-runtime preflight failed: unable to resolve staged runtime package "${runtimePackage.name}" from ${backendStageBundlePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    assertPathIsWithinDirectory(
      resolvedEntry,
      backendStageNodeModulesDir,
      `Packaged-runtime preflight failed: runtime package "${runtimePackage.name}" resolved outside the staged node_modules directory`,
    )

    if (runtimePackage.validateWithElectronOnly) {
      verifiedPackages.push(
        `${runtimePackage.name} -> ${path.relative(backendStageDir, resolvedEntry)} (deferred to Electron-as-Node validation)`,
      )
      continue
    }

    let loadedModule
    try {
      loadedModule = await loadRuntimeModuleFromEntry(stagedRequire, resolvedEntry)
    } catch (error) {
      throw new Error(
        `Packaged-runtime preflight failed: unable to load staged runtime package "${runtimePackage.name}" from ${resolvedEntry}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    const validationFailure = runtimePackage.validateLoadedModule?.(loadedModule)
    if (validationFailure) {
      throw new Error(
        `Packaged-runtime preflight failed: staged runtime package "${runtimePackage.name}" loaded from ${resolvedEntry} but ${validationFailure}`,
      )
    }

    verifiedPackages.push(
      `${runtimePackage.name} -> ${path.relative(backendStageDir, resolvedEntry)} (${describeLoadedModule(loadedModule)})`,
    )
  }

  validateBackendMetafileHasNoEmbeddedPiAiImplementation()
  await validateStagedBetterSqlite3Runtime()
  await validateStagedCursorSdkRuntime(stagedRequire)
  await validateStagedPiSingletonRuntime(stagedRequire)
  await assertStagedPiPackageRelativeAssets()
  await validateStagedPiFunctionalSmoke(stagedRequire)

  console.log(`[electron/build-all] Packaged-runtime preflight resolved and loaded ${verifiedPackages.length} staged runtime packages`)
  for (const resolution of verifiedPackages) {
    console.log(`[electron/build-all]   ${resolution}`)
  }
}

export function validateStagedBetterSqlite3PackageDir(stagedPackageDir) {
  const requiredPaths = [
    'package.json',
    path.join('lib', 'database.js'),
    path.join('build', 'Release', 'better_sqlite3.node'),
  ]

  for (const relativePath of requiredPaths) {
    if (!existsSync(path.join(stagedPackageDir, relativePath))) {
      return `missing required asset ${relativePath}`
    }
  }

  return null
}

async function stageElectronBetterSqlite3Binding() {
  const stagedPackageDir = path.join(backendStageNodeModulesDir, 'better-sqlite3')
  if (!existsSync(stagedPackageDir)) {
    throw new Error(`Unable to stage Electron better-sqlite3 binding: package is missing at ${stagedPackageDir}`)
  }

  const preparedBindingPath = await prepareElectronBetterSqlite3Binding()
  const stagedBuildDir = path.join(stagedPackageDir, 'build')
  const stagedBindingDir = path.join(stagedBuildDir, 'Release')
  const stagedBindingPath = path.join(stagedBindingDir, 'better_sqlite3.node')

  await rm(stagedBuildDir, { recursive: true, force: true })
  await mkdir(stagedBindingDir, { recursive: true })
  await cp(preparedBindingPath, stagedBindingPath)
  console.log(`[electron/build-all] Staged Electron better-sqlite3 binding at ${path.relative(electronDir, stagedBindingPath)}`)
}

async function validateStagedBetterSqlite3Runtime() {
  const electronRequire = createRequire(path.join(electronDir, 'package.json'))
  const electronExecutable = electronRequire('electron')
  const smokeSource = [
    "const Database = require('better-sqlite3')",
    "const database = new Database(':memory:')",
    "const row = database.prepare('SELECT 1 AS value').get()",
    'database.close()',
    "if (row?.value !== 1) throw new Error('Unexpected SQLite smoke result')",
  ].join(';')

  const child = spawn(electronExecutable, ['-e', smokeSource], {
    cwd: backendStageDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000,
  })

  await new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(
        `Packaged-runtime preflight failed: staged better-sqlite3 Electron smoke exited with code=${String(code)} signal=${String(signal)}${stderr ? `: ${stderr.trim()}` : ''}`,
      ))
    })
  })

  console.log('[electron/build-all] Packaged-runtime preflight verified staged better-sqlite3 with Electron-as-Node')
}

async function stageCliArtifact() {
  if (!existsSync(cliBuiltEntry)) {
    throw new Error(
      `CLI build artifact not found at ${cliBuiltEntry}. Ensure @forge/cli was built before staging.`,
    )
  }

  await mkdir(cliStageDir, { recursive: true })
  await cp(cliBuiltEntry, cliStagedEntry)

  // The CLI bundle uses ESM syntax (import/import.meta), but the nearest
  // ancestor package.json (apps/electron/package.json) declares "type": "commonjs".
  // Without an explicit ESM marker, Node treats the .js file as CJS and fails.
  // Drop a minimal package.json so both the build-time preflight and the
  // packaged Electron app (resources/cli/) resolve the correct module type.
  await writeFile(
    path.join(cliStageDir, 'package.json'),
    JSON.stringify({ type: 'module' }) + '\n',
    'utf8',
  )

  console.log(`[electron/build-all] Staged CLI artifact at ${path.relative(electronDir, cliStagedEntry)}`)
}

async function validateStagedCliPreflight() {
  if (!existsSync(cliStagedEntry)) {
    throw new Error(
      `Staged CLI preflight failed: staged entry not found at ${cliStagedEntry}`,
    )
  }

  // Run the staged CLI entry with Node to verify the bundle is self-contained
  // and produces valid version output. This uses the build-time Node process;
  // the full ELECTRON_RUN_AS_NODE verification happens post-packaging.
  try {
    const result = spawn(process.execPath, [cliStagedEntry, '--version'], {
      cwd: electronDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 15_000,
    })

    const output = await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''

      result.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
      result.stderr?.on('data', (chunk) => { stderr += chunk.toString() })

      result.once('exit', (code) => {
        if (code === 0) {
          resolve(stdout.trim())
        } else {
          reject(new Error(
            `Staged CLI exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
          ))
        }
      })

      result.once('error', reject)
    })

    if (typeof output !== 'string' || output.length === 0) {
      throw new Error('Staged CLI --version produced no output')
    }

    console.log(`[electron/build-all] Staged CLI preflight: ${output}`)
  } catch (error) {
    throw new Error(
      `Staged CLI preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function pickPackageEntryFromExports(exportsField) {
  if (typeof exportsField === 'string') {
    return exportsField
  }

  if (!exportsField || typeof exportsField !== 'object') {
    return null
  }

  return exportsField.import ?? exportsField.default ?? exportsField.node ?? exportsField.require ?? null
}

export function resolveStagedPackageEntryFromManifest(stagedPackageDir) {
  const manifestPath = path.join(stagedPackageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    return null
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }

  const relativeEntry =
    pickPackageEntryFromExports(manifest.exports?.['.']) ??
    pickPackageEntryFromExports(manifest.exports) ??
    (typeof manifest.main === 'string' ? manifest.main : null)

  if (!relativeEntry) {
    return null
  }

  const resolvedEntry = path.resolve(stagedPackageDir, relativeEntry)
  return existsSync(resolvedEntry) ? resolvedEntry : null
}

export function resolveStagedPackageSubpathFromManifest(stagedPackageDir, subpath) {
  const manifestPath = path.join(stagedPackageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    return null
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }

  const relativeEntry = pickPackageEntryFromExports(manifest.exports?.[subpath])
  if (!relativeEntry) {
    return null
  }

  const resolvedEntry = path.resolve(stagedPackageDir, relativeEntry)
  return existsSync(resolvedEntry) ? resolvedEntry : null
}

function resolveStagedRuntimePackageEntry(stagedRequire, packageName, stagedPackageDir) {
  try {
    return stagedRequire.resolve(packageName)
  } catch (error) {
    if (!isStagedPackageManifestResolutionError(error)) {
      throw error
    }
  }

  const manifestResolvedEntry = resolveStagedPackageEntryFromManifest(stagedPackageDir)
  if (!manifestResolvedEntry) {
    throw new Error(
      `unable to resolve staged runtime package "${packageName}" via require or package.json exports/main`,
    )
  }

  return manifestResolvedEntry
}

export async function loadRuntimeModuleFromEntry(stagedRequire, resolvedEntry) {
  try {
    return stagedRequire(resolvedEntry)
  } catch (error) {
    if (!isRequireEsmError(error)) {
      throw error
    }

    const importedModule = await import(pathToFileURL(resolvedEntry).href)
    return importedModule.default ?? importedModule
  }
}

async function loadRuntimeModule(stagedRequire, packageName, resolvedEntry) {
  try {
    return stagedRequire(packageName)
  } catch (error) {
    if (!isRequireEsmError(error) && !isStagedPackageManifestResolutionError(error)) {
      throw error
    }

    return loadRuntimeModuleFromEntry(stagedRequire, resolvedEntry)
  }
}

function describeLoadedModule(loadedModule) {
  if (typeof loadedModule === 'function') {
    const functionKeys = Object.keys(loadedModule).slice(0, 5)
    return functionKeys.length > 0 ? `function export; keys=${functionKeys.join(', ')}` : 'function export'
  }

  if (loadedModule && typeof loadedModule === 'object') {
    const objectKeys = Object.keys(loadedModule).slice(0, 5)
    return objectKeys.length > 0 ? `object export; keys=${objectKeys.join(', ')}` : 'object export'
  }

  return `${typeof loadedModule} export`
}

function assertPathIsWithinDirectory(targetPath, parentDirectory, failurePrefix) {
  const resolvedParentDirectory = path.resolve(parentDirectory)
  const resolvedTargetPath = path.resolve(targetPath)
  const normalizedParentPrefix = `${resolvedParentDirectory}${path.sep}`

  if (resolvedTargetPath === resolvedParentDirectory || resolvedTargetPath.startsWith(normalizedParentPrefix)) {
    return
  }

  throw new Error(`${failurePrefix}: ${resolvedTargetPath}`)
}

async function stageBundledDependencyRuntimeAssets() {
  // Theme + export-html resolve package-relative via pi-coding-agent getThemesDir /
  // getExportTemplateDir (dist/modes/interactive/theme, dist/core/export-html under the
  // staged package). Do not stage redundant bundle-relative copies under backend/dist.
  // photon-node is optional (platform-specific WASM) — skip if not installed
  const photonNode = await resolveInstalledPackage('@silvia-odwyer/photon-node', backendWorkspaceManifestPath, true)
  if (photonNode) {
    await copyRuntimeAsset(
      path.join(photonNode.packageRoot, 'photon_rs_bg.wasm'),
      path.join(backendStageDir, 'dist', 'photon_rs_bg.wasm'),
    )
  }
}

async function copyRuntimeAsset(from, to) {
  if (!existsSync(from)) {
    console.warn(`[electron/build-all] Warning: runtime asset not found (skipping): ${from}`)
    return
  }

  await mkdir(path.dirname(to), { recursive: true })
  await cp(from, to, { recursive: true })
}

const PI_SINGLETON_RUNTIME_PACKAGES = new Set([
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-tui',
])

/**
 * Collect the packaged-runtime dependency closure.
 * Pi-family packages must resolve to a single realpath/version (fail-closed).
 * Non-Pi packages may resolve multiple versions; secondary installs are staged
 * nested under the requesting parent install (by realpath) so nothing is silently discarded.
 */
export async function collectRuntimePackageClosure(rootPackages) {
  const queuedPackages = rootPackages.map(({ packageName, optional }) => ({
    packageName,
    resolveFromManifestPath: backendWorkspaceManifestPath,
    optional,
    parentPackageName: null,
    parentPackageRoot: null,
  }))
  const hoistedByName = new Map()
  const nestedPackages = []
  const seenRealpaths = new Set()
  const installsByRealpath = new Map()

  while (queuedPackages.length > 0) {
    const next = queuedPackages.shift()
    if (!next) {
      continue
    }

    const resolved = await resolveInstalledPackage(next.packageName, next.resolveFromManifestPath, next.optional)
    if (!resolved) {
      continue
    }

    const resolvedRealpath = await fs.promises.realpath(resolved.packageRoot)
    const existingByName = hoistedByName.get(resolved.name)
    if (existingByName) {
      const existingRealpath = await fs.promises.realpath(existingByName.packageRoot)
      if (existingRealpath === resolvedRealpath && existingByName.manifest.version === resolved.manifest.version) {
        seenRealpaths.add(resolvedRealpath)
        installsByRealpath.set(resolvedRealpath, existingByName)
        continue
      }
      if (PI_SINGLETON_RUNTIME_PACKAGES.has(resolved.name)) {
        throw new Error(
          `Runtime package closure resolved conflicting Pi singleton ${resolved.name}: ${existingRealpath}@${existingByName.manifest.version} vs ${resolvedRealpath}@${resolved.manifest.version}`,
        )
      }
      if (!next.parentPackageName || !next.parentPackageRoot) {
        throw new Error(
          `Runtime package closure resolved conflicting ${resolved.name} at the bundle root with no nest parent: ${existingRealpath}@${existingByName.manifest.version} vs ${resolvedRealpath}@${resolved.manifest.version}`,
        )
      }
      if (seenRealpaths.has(resolvedRealpath)) {
        continue
      }
      seenRealpaths.add(resolvedRealpath)
      const nested = {
        ...resolved,
        nestUnderPackageName: next.parentPackageName,
        nestUnderPackageRoot: next.parentPackageRoot,
      }
      nestedPackages.push(nested)
      installsByRealpath.set(resolvedRealpath, nested)
      for (const dependency of collectRuntimeDependencyDescriptors(resolved.manifest)) {
        queuedPackages.push({
          packageName: dependency.packageName,
          resolveFromManifestPath: resolved.manifestPath,
          optional: dependency.optional,
          parentPackageName: resolved.name,
          parentPackageRoot: resolvedRealpath,
        })
      }
      continue
    }

    if (seenRealpaths.has(resolvedRealpath)) {
      // Alias of an already-staged physical install (e.g. string-width-cjs -> string-width).
      hoistedByName.set(resolved.name, resolved)
      continue
    }

    seenRealpaths.add(resolvedRealpath)
    hoistedByName.set(resolved.name, resolved)
    installsByRealpath.set(resolvedRealpath, resolved)

    for (const dependency of collectRuntimeDependencyDescriptors(resolved.manifest)) {
      queuedPackages.push({
        packageName: dependency.packageName,
        resolveFromManifestPath: resolved.manifestPath,
        optional: dependency.optional,
        parentPackageName: resolved.name,
        parentPackageRoot: resolvedRealpath,
      })
    }
  }

  const hoisted = Array.from(hoistedByName.values()).sort((left, right) => left.name.localeCompare(right.name))
  nestedPackages.sort((left, right) => {
    const byParent = left.nestUnderPackageName.localeCompare(right.nestUnderPackageName)
    if (byParent !== 0) return byParent
    const byName = left.name.localeCompare(right.name)
    if (byName !== 0) return byName
    return String(left.manifest.version).localeCompare(String(right.manifest.version))
  })
  return { hoisted, nested: nestedPackages, installsByRealpath }
}

function collectRuntimeDependencyDescriptors(manifest) {
  const descriptors = []

  for (const packageName of Object.keys(manifest.dependencies ?? {})) {
    if (!NODE_BUILTIN_MODULES.has(packageName)) {
      descriptors.push({ packageName, optional: false })
    }
  }

  for (const packageName of Object.keys(manifest.optionalDependencies ?? {})) {
    if (!NODE_BUILTIN_MODULES.has(packageName)) {
      descriptors.push({ packageName, optional: true })
    }
  }

  return descriptors
}

async function resolveInstalledPackage(packageName, resolveFromManifestPath, optional) {
  const packageRequire = createRequire(resolveFromManifestPath)
  let resolvedEntryPath

  try {
    try {
      resolvedEntryPath = packageRequire.resolve(`${packageName}/package.json`)
    } catch {
      resolvedEntryPath = packageRequire.resolve(packageName)
    }
  } catch (error) {
    const resolvedPackageRoot = await findInstalledPackageRoot(packageName, path.dirname(resolveFromManifestPath))
    if (resolvedPackageRoot) {
      return await findResolvedPackageInfo(packageName, resolvedPackageRoot)
    }

    if (optional && isModuleNotFoundError(error)) {
      return null
    }

    throw new Error(
      `Failed to resolve runtime package "${packageName}" from ${resolveFromManifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  return await findResolvedPackageInfo(packageName, resolvedEntryPath)
}

async function findResolvedPackageInfo(expectedPackageName, resolvedEntryPath) {
  let currentPath = path.extname(resolvedEntryPath) ? path.dirname(resolvedEntryPath) : resolvedEntryPath
  let aliasFallback = null

  while (true) {
    const manifestPath = path.join(currentPath, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.name === expectedPackageName) {
        return {
          name: expectedPackageName,
          manifest,
          manifestPath,
          packageRoot: currentPath,
        }
      }
      // pnpm alias packages (e.g. string-width-cjs -> string-width) resolve into a
      // package root whose manifest.name differs from the required specifier.
      if (!aliasFallback) {
        aliasFallback = {
          name: expectedPackageName,
          manifest,
          manifestPath,
          packageRoot: currentPath,
        }
      }
    }

    const parentPath = path.dirname(currentPath)
    if (parentPath === currentPath) {
      if (aliasFallback) {
        return aliasFallback
      }
      throw new Error(`Unable to locate package root for ${expectedPackageName} from ${resolvedEntryPath}`)
    }

    currentPath = parentPath
  }
}

async function findInstalledPackageRoot(packageName, startDirectory) {
  const packageRelativePath = path.join('node_modules', ...packageName.split('/'))
  let currentDirectory = startDirectory

  while (true) {
    const candidatePath = path.join(currentDirectory, packageRelativePath)
    if (existsSync(candidatePath)) {
      return await fs.promises.realpath(candidatePath)
    }

    const parentDirectory = path.dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      return null
    }

    currentDirectory = parentDirectory
  }
}

function isModuleNotFoundError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND'),
  )
}

function isRequireEsmError(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ERR_REQUIRE_ESM')
}

function isStagedPackageManifestResolutionError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ERR_REQUIRE_ESM' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'),
  )
}

async function stageRuntimePackages(runtimePackages) {
  const hoisted = Array.isArray(runtimePackages) ? runtimePackages : runtimePackages.hoisted
  const nested = Array.isArray(runtimePackages) ? [] : runtimePackages.nested
  if (hoisted.length === 0 && nested.length === 0) {
    return
  }

  await mkdir(backendStageNodeModulesDir, { recursive: true })
  const stagedTargetByRealpath = new Map()

  for (const runtimePackage of hoisted) {
    const packageTargetDir = path.join(backendStageNodeModulesDir, ...runtimePackage.name.split('/'))
    await copyRuntimePackage(runtimePackage, packageTargetDir)
    stagedTargetByRealpath.set(await fs.promises.realpath(runtimePackage.packageRoot), packageTargetDir)
  }

  // Parents may themselves be nested; stage in waves until all nests are placed.
  const pending = [...nested]
  let guard = 0
  while (pending.length > 0) {
    guard += 1
    if (guard > pending.length + nested.length + 32) {
      const unresolved = pending
        .map((pkg) => `${pkg.name}@${pkg.manifest.version} under ${pkg.nestUnderPackageName}`)
        .join(', ')
      throw new Error(`Unable to resolve nested runtime package parents for staging: ${unresolved}`)
    }

    let progressed = false
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const runtimePackage = pending[index]
      const parentTarget = stagedTargetByRealpath.get(runtimePackage.nestUnderPackageRoot)
      if (!parentTarget) {
        continue
      }
      const packageTargetDir = path.join(parentTarget, 'node_modules', ...runtimePackage.name.split('/'))
      await copyRuntimePackage(runtimePackage, packageTargetDir)
      stagedTargetByRealpath.set(await fs.promises.realpath(runtimePackage.packageRoot), packageTargetDir)
      console.log(
        `[electron/build-all] Nested ${runtimePackage.name}@${runtimePackage.manifest.version} under ${runtimePackage.nestUnderPackageName}`,
      )
      pending.splice(index, 1)
      progressed = true
    }
    if (!progressed) {
      const unresolved = pending
        .map((pkg) => `${pkg.name}@${pkg.manifest.version} under ${pkg.nestUnderPackageName}`)
        .join(', ')
      throw new Error(`Unable to resolve nested runtime package parents for staging: ${unresolved}`)
    }
  }
}

async function copyRuntimePackage(runtimePackage, targetDir) {
  await mkdir(path.dirname(targetDir), { recursive: true })
  await cp(runtimePackage.packageRoot, targetDir, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => shouldCopyRuntimePackagePath(runtimePackage.name, runtimePackage.packageRoot, sourcePath),
  })
}

export function validateStagedPiCodingAgentPackageDir(stagedPackageDir) {
  const requiredPaths = [
    'package.json',
    path.join('dist', 'index.js'),
    path.join('dist', 'core', 'export-html'),
    path.join('dist', 'modes', 'interactive', 'theme'),
  ]

  for (const relativePath of requiredPaths) {
    if (!existsSync(path.join(stagedPackageDir, relativePath))) {
      return `missing required asset ${relativePath}`
    }
  }

  return null
}

export function validateStagedPiAiPackageDir(stagedPackageDir) {
  const requiredPaths = [
    'package.json',
    path.join('dist', 'index.js'),
    path.join('dist', 'compat.js'),
    path.join('dist', 'api'),
  ]

  for (const relativePath of requiredPaths) {
    if (!existsSync(path.join(stagedPackageDir, relativePath))) {
      return `missing required asset ${relativePath}`
    }
  }

  return null
}

function validateBackendMetafileHasNoEmbeddedPiAiImplementation() {
  const metafile = JSON.parse(readFileSync(backendStageMetafilePath, 'utf8'))
  const embeddedPiAiInputs = Object.keys(metafile.inputs ?? {}).filter(
    (input) => input.includes('node_modules/@earendil-works/pi-ai/') || input.includes('node_modules/@earendil-works+pi-ai@'),
  )
  if (embeddedPiAiInputs.length > 0) {
    throw new Error(
      `Packaged-runtime preflight failed: backend bundle embedded pi-ai implementation modules: ${embeddedPiAiInputs.join(', ')}`,
    )
  }
}

/**
 * Fail-closed Pi-family version check for staged roots.
 * Used by packaged preflight and unit tests with duplicate/skew fixtures.
 */
export function assertPiFamilySingletonManifests(packageDirsByName, expectedVersion = '0.80.6') {
  const required = [
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
  ]
  for (const packageName of required) {
    const packageDir = packageDirsByName.get(packageName)
    if (!packageDir || !existsSync(path.join(packageDir, 'package.json'))) {
      throw new Error(`Packaged-runtime preflight failed: missing staged Pi package ${packageName}`)
    }
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    if (manifest.version !== expectedVersion) {
      throw new Error(
        `Packaged-runtime preflight failed: expected ${packageName}@${expectedVersion}, got ${manifest.version}`,
      )
    }
  }
}

export async function validateStagedPiSingletonRuntime(stagedRequire) {
  const piPackageDirs = new Map([
    ['@earendil-works/pi-agent-core', path.join(backendStageNodeModulesDir, '@earendil-works', 'pi-agent-core')],
    ['@earendil-works/pi-ai', path.join(backendStageNodeModulesDir, '@earendil-works', 'pi-ai')],
    ['@earendil-works/pi-coding-agent', path.join(backendStageNodeModulesDir, '@earendil-works', 'pi-coding-agent')],
    ['@earendil-works/pi-tui', path.join(backendStageNodeModulesDir, '@earendil-works', 'pi-tui')],
  ])
  assertPiFamilySingletonManifests(piPackageDirs)

  const piAiPackageDir = piPackageDirs.get('@earendil-works/pi-ai')
  const piCodingAgentPackageDir = piPackageDirs.get('@earendil-works/pi-coding-agent')
  const forgePiAiRoot = await findInstalledPackageRoot('@earendil-works/pi-ai', path.dirname(backendStageBundlePath))
  const codingAgentPiAiRoot = await findInstalledPackageRoot('@earendil-works/pi-ai', piCodingAgentPackageDir)
  if (!forgePiAiRoot || !codingAgentPiAiRoot) {
    throw new Error('Packaged-runtime preflight failed: unable to resolve staged pi-ai roots for singleton check')
  }
  const forgeCompatPath = await fs.promises.realpath(path.join(forgePiAiRoot, 'dist', 'compat.js'))
  const codingAgentCompatPath = await fs.promises.realpath(path.join(codingAgentPiAiRoot, 'dist', 'compat.js'))
  if (forgeCompatPath !== codingAgentCompatPath) {
    throw new Error(
      `Packaged-runtime preflight failed: Forge and coding-agent resolved different pi-ai/compat realpaths (${forgeCompatPath} vs ${codingAgentCompatPath})`,
    )
  }

  const forgePiAiEntry = resolveStagedPackageEntryFromManifest(piAiPackageDir)
  const codingAgentPiAiEntry = resolveStagedPackageEntryFromManifest(
    await findInstalledPackageRoot('@earendil-works/pi-ai', piCodingAgentPackageDir),
  )
  const [forgeCompat, codingAgentCompat, forgeRoot, codingRoot] = await Promise.all([
    import(pathToFileURL(forgeCompatPath).href),
    import(pathToFileURL(codingAgentCompatPath).href),
    import(pathToFileURL(forgePiAiEntry).href),
    import(pathToFileURL(codingAgentPiAiEntry).href),
  ])
  if (forgeCompat.registerFauxProvider !== codingAgentCompat.registerFauxProvider || forgeRoot.createProvider !== codingRoot.createProvider) {
    throw new Error('Packaged-runtime preflight failed: pi-ai ESM identity is not shared')
  }

  const registration = forgeCompat.registerFauxProvider({
    api: 'packaged-singleton-api',
    provider: 'packaged-singleton',
    models: [{ id: 'singleton-model' }],
  })
  try {
    if (codingAgentCompat.getApiProvider(registration.api)?.api !== registration.api) {
      throw new Error('Packaged-runtime preflight failed: pi-ai shared faux provider state is not visible from coding-agent parent')
    }
    const reverse = codingAgentCompat.registerFauxProvider({
      api: 'packaged-singleton-reverse-api',
      provider: 'packaged-singleton-reverse',
      models: [{ id: 'singleton-reverse-model' }],
    })
    try {
      if (forgeCompat.getApiProvider(reverse.api)?.api !== reverse.api) {
        throw new Error('Packaged-runtime preflight failed: pi-ai shared faux provider state is not visible from Forge parent')
      }
    } finally {
      reverse.unregister()
    }
  } finally {
    registration.unregister()
  }

  void stagedRequire
}

async function assertStagedPiPackageRelativeAssets() {
  const packageDir = path.join(backendStageNodeModulesDir, '@earendil-works', 'pi-coding-agent')
  const configModule = await import(pathToFileURL(path.join(packageDir, 'dist', 'config.js')).href)
  const themesDir = configModule.getThemesDir()
  const exportTemplateDir = configModule.getExportTemplateDir()

  assertPathIsWithinDirectory(
    themesDir,
    packageDir,
    'Packaged-runtime preflight failed: getThemesDir resolved outside staged pi-coding-agent package',
  )
  assertPathIsWithinDirectory(
    exportTemplateDir,
    packageDir,
    'Packaged-runtime preflight failed: getExportTemplateDir resolved outside staged pi-coding-agent package',
  )

  for (const relativePath of [
    path.join(themesDir, 'dark.json'),
    path.join(themesDir, 'light.json'),
    path.join(exportTemplateDir, 'template.html'),
    path.join(exportTemplateDir, 'template.css'),
  ]) {
    if (!existsSync(relativePath)) {
      throw new Error(`Packaged-runtime preflight failed: missing package-relative Pi asset ${relativePath}`)
    }
  }

  for (const redundantRelative of [
    path.join('dist', 'modes', 'interactive', 'theme'),
    path.join('dist', 'core', 'export-html'),
  ]) {
    const redundantPath = path.join(backendStageDir, redundantRelative)
    if (existsSync(redundantPath)) {
      throw new Error(
        `Packaged-runtime preflight failed: redundant bundle-relative ${redundantRelative} must not be staged; package-relative assets under node_modules/@earendil-works/pi-coding-agent are authoritative`,
      )
    }
  }
}

async function validateStagedPiFunctionalSmoke(stagedRequire) {
  const pi = await import(pathToFileURL(resolveStagedRuntimePackageEntry(stagedRequire, '@earendil-works/pi-coding-agent', path.join(backendStageNodeModulesDir, '@earendil-works', 'pi-coding-agent'))).href)
  const compat = await import(pathToFileURL(resolveStagedPackageSubpathFromManifest(path.join(backendStageNodeModulesDir, '@earendil-works', 'pi-ai'), './compat')).href)
  const root = await fs.promises.mkdtemp(path.join(stageDir, 'pi-smoke-'))
  const agentDir = path.join(root, 'agent')
  const sessionFile = path.join(root, 'session.jsonl')
  const marker = path.join(root, 'trusted-extension-marker.txt')
  const extensionPath = path.join(root, '.forge', 'pi', 'extensions', 'trusted.js')
  const legacySupportedPath = path.join(root, '.forge', 'pi', 'extensions', 'legacy-supported.js')
  const legacyUnsupportedPath = path.join(root, '.forge', 'pi', 'extensions', 'legacy-unsupported.js')
  await mkdir(path.dirname(extensionPath), { recursive: true })
  await writeFile(path.join(root, 'README.md'), 'staged smoke read-only content\n', 'utf8')
  await writeFile(
    extensionPath,
    `import { writeFileSync } from 'node:fs'; export default function setup() { writeFileSync(${JSON.stringify(marker)}, 'loaded', 'utf8'); }\n`,
    'utf8',
  )
  await writeFile(
    legacySupportedPath,
    `import { getModel } from '@mariozechner/pi-ai';\nimport { writeFileSync } from 'node:fs';\nexport default function setup() { writeFileSync(${JSON.stringify(path.join(root, 'legacy-supported-marker.txt'))}, typeof getModel === 'function' ? 'ok' : 'missing', 'utf8'); }\n`,
    'utf8',
  )
  await writeFile(
    legacyUnsupportedPath,
    `import '@mariozechner/pi-ai/private-subpath';\nexport default function setup() {}\n`,
    'utf8',
  )
  await writeFile(
    path.join(root, '.forge', 'pi', 'settings.json'),
    JSON.stringify({ extensions: ['./extensions/trusted.js'] }),
    'utf8',
  )
  await writeFile(sessionFile, '', 'utf8')

  const faux = compat.registerFauxProvider({
    api: 'packaged-smoke-api',
    provider: 'packaged-smoke',
    models: [{ id: 'packaged-smoke-model', name: 'Packaged Smoke', contextWindow: 32000, maxTokens: 1024 }],
  })
  faux.setResponses([
    compat.fauxAssistantMessage(compat.fauxToolCall('read', { path: 'README.md' }, { id: 'smoke-read-1' }), { stopReason: 'tool_use' }),
    'cached request reconnect ok',
  ])

  const authStorage = pi.AuthStorage.inMemory({})
  authStorage.setRuntimeApiKey('packaged-smoke', 'faux-test-key')

  const deniedStorage = {
    withLock(scope, fn) {
      fn(scope === 'global' ? undefined : JSON.stringify({ extensions: ['!*'], packages: [], skills: [], prompts: [], themes: [] }))
    },
  }
  const deniedSettingsManager = pi.SettingsManager.fromStorage(deniedStorage, { projectTrusted: false })
  const deniedResourceLoader = new pi.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: deniedSettingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
  await deniedResourceLoader.reload({ resolveProjectTrust: async () => false })
  const deniedSessionFile = path.join(root, 'denied-session.jsonl')
  await writeFile(deniedSessionFile, '', 'utf8')
  const deniedCreated = await pi.createAgentSession({
    cwd: root,
    agentDir,
    authStorage,
    modelRegistry: pi.ModelRegistry.inMemory(authStorage),
    model: faux.getModel(),
    thinkingLevel: 'off',
    sessionManager: pi.SessionManager.open(deniedSessionFile, undefined, root),
    resourceLoader: deniedResourceLoader,
    settingsManager: deniedSettingsManager,
    noTools: 'all',
  })
  await deniedCreated.session.bindExtensions({})
  deniedCreated.session.dispose()
  if (existsSync(marker)) {
    throw new Error('Packaged-runtime preflight failed: denied-trust project extension executed in staged smoke')
  }

  const storage = {
    withLock(scope, fn) {
      const current = scope === 'global'
        ? undefined
        : JSON.stringify({ extensions: ['!*', './extensions/trusted.js', extensionPath, `+${extensionPath}`], packages: [], skills: [], prompts: [], themes: [] })
      fn(current)
    },
  }
  // Creator-path contract: construct untrusted, elevate only via resolveProjectTrust.
  const settingsManager = pi.SettingsManager.fromStorage(storage, { projectTrusted: false })
  if (settingsManager.isProjectTrusted()) {
    throw new Error('Packaged-runtime preflight failed: SettingsManager must start projectTrusted:false')
  }
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
  await resourceLoader.reload({ resolveProjectTrust: async () => true })
  if (!settingsManager.isProjectTrusted()) {
    throw new Error('Packaged-runtime preflight failed: resolveProjectTrust did not elevate SettingsManager.projectTrusted')
  }
  const { session } = await pi.createAgentSession({
    cwd: root,
    agentDir,
    authStorage,
    modelRegistry: pi.ModelRegistry.inMemory(authStorage),
    model: faux.getModel(),
    thinkingLevel: 'off',
    sessionManager: pi.SessionManager.open(sessionFile, undefined, root),
    resourceLoader,
    settingsManager,
    tools: ['read'],
  })

  try {
    await session.bindExtensions({})
    await session.prompt('read README.md')
    session.dispose()
    const restarted = pi.SessionManager.open(sessionFile, undefined, root)
    const context = restarted.buildSessionContext()
    if (!JSON.stringify(context.messages).includes('staged smoke read-only content')) {
      throw new Error('Packaged-runtime preflight failed: safe read-only tool result was not replayable from staged session')
    }
    if (!existsSync(marker)) {
      throw new Error('Packaged-runtime preflight failed: trusted project extension did not load in staged smoke')
    }
    faux.appendResponses(['cached request reconnect ok'])
    const secondSessionFile = path.join(root, 'session-2.jsonl')
    await writeFile(secondSessionFile, '', 'utf8')
    const second = await pi.createAgentSession({
      cwd: root,
      agentDir,
      authStorage,
      modelRegistry: pi.ModelRegistry.inMemory(authStorage),
      model: faux.getModel(),
      thinkingLevel: 'off',
      sessionManager: pi.SessionManager.open(secondSessionFile, undefined, root),
      resourceLoader,
      settingsManager,
      noTools: 'all',
    })
    await second.session.prompt('cached reconnect')
    second.session.dispose()
    if (faux.state.callCount < 2) {
      throw new Error('Packaged-runtime preflight failed: staged faux provider did not observe repeated requests')
    }

    await assertStagedLegacyExtensionMigrationCases({
      pi,
      authStorage,
      faux,
      root,
      agentDir,
      legacySupportedPath,
      legacyUnsupportedPath,
    })
  } finally {
    faux.unregister()
    session.dispose()
  }
}

async function assertStagedLegacyExtensionMigrationCases({
  pi,
  authStorage,
  faux,
  root,
  agentDir,
  legacySupportedPath,
  legacyUnsupportedPath,
}) {
  const supportedMarker = path.join(root, 'legacy-supported-marker.txt')
  const supportedStorage = {
    withLock(scope, fn) {
      fn(
        scope === 'global'
          ? undefined
          : JSON.stringify({
              extensions: ['!*', './extensions/legacy-supported.js', legacySupportedPath, `+${legacySupportedPath}`],
              packages: [],
              skills: [],
              prompts: [],
              themes: [],
            }),
      )
    },
  }
  const supportedSettings = pi.SettingsManager.fromStorage(supportedStorage, { projectTrusted: false })
  const supportedLoader = new pi.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: supportedSettings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
  await supportedLoader.reload({ resolveProjectTrust: async () => true })
  const supportedSessionFile = path.join(root, 'legacy-supported-session.jsonl')
  await writeFile(supportedSessionFile, '', 'utf8')
  const supportedCreated = await pi.createAgentSession({
    cwd: root,
    agentDir,
    authStorage,
    modelRegistry: pi.ModelRegistry.inMemory(authStorage),
    model: faux.getModel(),
    thinkingLevel: 'off',
    sessionManager: pi.SessionManager.open(supportedSessionFile, undefined, root),
    resourceLoader: supportedLoader,
    settingsManager: supportedSettings,
    noTools: 'all',
  })
  const supportedErrors = (supportedCreated.extensionsResult?.errors ?? [])
    .map((entry) => String(entry?.error ?? entry?.message ?? entry ?? ''))
    .join('\n')
  await supportedCreated.session.bindExtensions({})
  supportedCreated.session.dispose()
  const supportedLoaded = existsSync(supportedMarker)
  const supportedDiagnostic = /@mariozechner\/pi-ai|earendil-works\/pi-ai\/compat|does not ship @mariozechner/i.test(supportedErrors)
  if (!supportedLoaded && !supportedDiagnostic) {
    throw new Error(
      'Packaged-runtime preflight failed: legacy @mariozechner/pi-ai extension neither loaded via upstream alias nor produced migration diagnostic',
    )
  }

  const unsupportedStorage = {
    withLock(scope, fn) {
      fn(
        scope === 'global'
          ? undefined
          : JSON.stringify({
              extensions: ['!*', './extensions/legacy-unsupported.js', legacyUnsupportedPath, `+${legacyUnsupportedPath}`],
              packages: [],
              skills: [],
              prompts: [],
              themes: [],
            }),
      )
    },
  }
  const unsupportedSettings = pi.SettingsManager.fromStorage(unsupportedStorage, { projectTrusted: false })
  const unsupportedLoader = new pi.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: unsupportedSettings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
  await unsupportedLoader.reload({ resolveProjectTrust: async () => true })
  const unsupportedErrors = unsupportedLoader
    .getExtensions()
    .errors
    .map((entry) => entry?.error ?? entry?.message ?? entry)
  if (unsupportedErrors.length === 0) {
    throw new Error('Packaged-runtime preflight failed: unsupported legacy subpath produced no resourceLoader errors')
  }
  const { formatPiExtensionLoadError } = await import(
    pathToFileURL(path.join(repoRoot, 'apps/backend/dist/swarm/pi-extension-migration-diagnostics.js')).href,
  )
  const diagnosed = unsupportedErrors.map((error) => {
    const rawMessage = error instanceof Error ? error.message : String(error ?? '')
    return formatPiExtensionLoadError(error, rawMessage)
  })
  if (
    !diagnosed.some((message) =>
      String(message).includes('Unsupported legacy Pi extension import @mariozechner/pi-ai/private-subpath'),
    )
  ) {
    throw new Error(
      `Packaged-runtime preflight failed: unsupported legacy subpath did not produce Forge migration guidance (raw=${JSON.stringify(unsupportedErrors.map(String))} diagnosed=${JSON.stringify(diagnosed)})`,
    )
  }
}

function validateStagedCursorSdkPackageDir(stagedPackageDir) {
  const requiredPaths = [
    'package.json',
    path.join('dist', 'cjs', 'index.js'),
    path.join('dist', 'esm', 'index.js'),
  ]

  for (const relativePath of requiredPaths) {
    if (!existsSync(path.join(stagedPackageDir, relativePath))) {
      return `missing required asset ${relativePath}`
    }
  }

  return null
}

async function validateStagedCursorSdkRuntime(stagedRequire) {
  const sqlite3Entry = stagedRequire.resolve('sqlite3')
  assertPathIsWithinDirectory(
    sqlite3Entry,
    backendStageNodeModulesDir,
    'Packaged-runtime preflight failed: sqlite3 resolved outside the staged node_modules directory',
  )
  const sqlite3 = stagedRequire('sqlite3')
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (openError) => {
      if (openError) {
        reject(openError)
        return
      }

      db.close((closeError) => {
        if (closeError) {
          reject(closeError)
          return
        }
        resolve()
      })
    })
  })

  const platformPackageName = getCurrentCursorSdkPlatformPackageName()
  const platformPackageDir = path.join(backendStageNodeModulesDir, ...platformPackageName.split('/'))
  const executableSuffix = process.platform === 'win32' ? '.exe' : ''
  const requiredBinaries = [
    path.join('bin', `rg${executableSuffix}`),
    path.join('bin', `cursorsandbox${executableSuffix}`),
  ]
  for (const relativePath of requiredBinaries) {
    const binaryPath = path.join(platformPackageDir, relativePath)
    if (!existsSync(binaryPath)) {
      throw new Error(
        `Packaged-runtime preflight failed: staged Cursor SDK platform package ${platformPackageName} is missing ${relativePath}`,
      )
    }
  }

  const platformPackageManifest = path.join(platformPackageDir, 'package.json')
  if (!existsSync(platformPackageManifest)) {
    throw new Error(
      `Packaged-runtime preflight failed: staged Cursor SDK platform package ${platformPackageName} is missing package.json`,
    )
  }
  assertPathIsWithinDirectory(
    platformPackageManifest,
    backendStageNodeModulesDir,
    `Packaged-runtime preflight failed: Cursor SDK platform package "${platformPackageName}" resolved outside the staged node_modules directory`,
  )

  console.log(
    `[electron/build-all] Packaged-runtime preflight verified Cursor SDK sqlite3 and ${platformPackageName} binaries`,
  )
}

function getCurrentCursorSdkPlatformPackageName() {
  const platformByNodePlatform = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'win32',
  }
  const archByNodeArch = {
    arm64: 'arm64',
    x64: 'x64',
  }

  const platform = platformByNodePlatform[process.platform]
  const arch = archByNodeArch[process.arch]
  if (!platform || !arch) {
    throw new Error(`Unsupported Cursor SDK packaged-runtime platform: ${process.platform}/${process.arch}`)
  }

  return `@cursor/sdk-${platform}-${arch}`
}

function validateStagedClaudeSdkPackageDir(stagedPackageDir) {
  const requiredPaths = [
    'package.json',
    'sdk.mjs',
    'sdk.d.ts',
    'cli.js',
    'manifest.json',
    'manifest.zst.json',
    path.join('vendor', 'audio-capture'),
    path.join('vendor', 'ripgrep'),
  ]

  for (const relativePath of requiredPaths) {
    if (!existsSync(path.join(stagedPackageDir, relativePath))) {
      return `missing required asset ${relativePath}`
    }
  }

  return null
}

function shouldCopyRuntimePackagePath(packageName, packageRoot, sourcePath) {
  const relativePath = path.relative(packageRoot, sourcePath)
  if (relativePath.length === 0) {
    return true
  }

  const relativeSegments = relativePath.split(path.sep)
  const topLevelSegment = relativeSegments[0]?.toLowerCase()
  if (!topLevelSegment) {
    return true
  }

  if (PACKAGE_METADATA_DIRS_TO_PRUNE.has(topLevelSegment)) {
    return false
  }

  const packageSpecificDirs = PACKAGE_SPECIFIC_DIRS_TO_PRUNE.get(packageName)
  if (packageSpecificDirs?.has(topLevelSegment)) {
    return false
  }

  return !shouldPruneNodeModulesFile(packageName, sourcePath)
}

function shouldPruneNodeModulesFile(packageName, sourcePath) {
  const normalizedFileName = path.basename(sourcePath).toLowerCase()

  if (declarationMapSuffixes.some((suffix) => normalizedFileName.endsWith(suffix))) {
    return true
  }

  if (declarationSuffixes.some((suffix) => normalizedFileName.endsWith(suffix))) {
    return !PACKAGES_KEEP_DECLARATION_FILES.has(packageName)
  }

  if (normalizedFileName.endsWith('.md')) {
    return true
  }

  if (normalizedFileName.endsWith('.ts') && !normalizedFileName.endsWith('.d.ts')) {
    return true
  }

  if (docsPrefixes.some((prefix) => normalizedFileName.startsWith(prefix))) {
    const extension = path.extname(normalizedFileName)
    if (docsPrunableExtensions.has(extension)) {
      return true
    }
  }

  return false
}

async function countFiles(rootDir) {
  if (!existsSync(rootDir)) {
    return 0
  }

  let fileCount = 0
  const directoriesToVisit = [rootDir]

  while (directoriesToVisit.length > 0) {
    const currentDirectory = directoriesToVisit.pop()
    const entries = await fs.promises.readdir(currentDirectory, { withFileTypes: true })

    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name)

      if (entry.isDirectory()) {
        directoriesToVisit.push(entryPath)
        continue
      }

      if (entry.isFile()) {
        fileCount += 1
      }
    }
  }

  return fileCount
}

async function cleanUiBuildOutput() {
  await rm(uiBuildOutputDir, { recursive: true, force: true })
  console.log(`[electron/build-all] Cleaned UI build output directory ${uiBuildOutputDir}`)
}

async function stageRendererAssets() {
  const nextUiStageDir = `${uiStageDir}.tmp`
  await rm(nextUiStageDir, { recursive: true, force: true })
  await copyDirectory(uiPublicOutputDir, nextUiStageDir)

  const shellPath = path.join(nextUiStageDir, '_shell.html')
  if (existsSync(shellPath)) {
    await cp(shellPath, path.join(nextUiStageDir, 'index.html'))
  }

  await synchronizeStagedRendererIndex(nextUiStageDir)
  await assertStagedRendererAssetReferences(nextUiStageDir)
  await rm(uiStageDir, { recursive: true, force: true })
  await fs.promises.rename(nextUiStageDir, uiStageDir)
}

async function synchronizeStagedRendererIndex(stagedRendererDir) {
  const indexPath = path.join(stagedRendererDir, 'index.html')
  const shellPath = path.join(stagedRendererDir, '_shell.html')
  const stagedAssetsDir = path.join(stagedRendererDir, 'assets')
  const stagedAssetEntries = existsSync(stagedAssetsDir) ? await fs.promises.readdir(stagedAssetsDir) : []
  const selectedAssets = {
    mainJs: selectUniqueStagedRendererAsset(stagedAssetEntries, /^main-[A-Za-z0-9_-]+\.js$/, 'main JavaScript bundle'),
    mainCss: selectUniqueStagedRendererAsset(stagedAssetEntries, /^main-[A-Za-z0-9_-]+\.css$/, 'main stylesheet bundle'),
    stylesCss: selectUniqueStagedRendererAsset(stagedAssetEntries, /^styles-[A-Za-z0-9_-]+\.css$/, 'styles stylesheet bundle'),
  }

  let html = await readFile(indexPath, 'utf8')
  html = html
    .replace(/((?:\.\/|\/\.\/|\/)?assets\/)main-[A-Za-z0-9_-]+\.js/g, `$1${selectedAssets.mainJs}`)
    .replace(/((?:\.\/|\/\.\/|\/)?assets\/)main-[A-Za-z0-9_-]+\.css/g, `$1${selectedAssets.mainCss}`)
    .replace(/((?:\.\/|\/\.\/|\/)?assets\/)styles-[A-Za-z0-9_-]+\.css/g, `$1${selectedAssets.stylesCss}`)

  await writeFile(indexPath, html, 'utf8')
  if (existsSync(shellPath)) {
    await writeFile(shellPath, html, 'utf8')
  }
}

function selectUniqueStagedRendererAsset(stagedAssetEntries, pattern, label) {
  const matches = stagedAssetEntries.filter((entry) => pattern.test(entry)).sort()

  if (matches.length !== 1) {
    throw new Error(
      `Packaged renderer synchronization failed: expected exactly one ${label} in staged assets but found ${matches.length} (${matches.join(', ') || 'none'})`,
    )
  }

  return matches[0]
}

async function assertStagedRendererAssetReferences(stagedRendererDir) {
  const indexPath = path.join(stagedRendererDir, 'index.html')
  const html = await readFile(indexPath, 'utf8')
  const assetReferenceRegex = /(?:\.\/|\/\.\/|\/)?assets\/[^"'()?#\s\\]+/g
  const referencedAssetPaths = Array.from(
    new Set((html.match(assetReferenceRegex) ?? []).map((reference) => normalizeRendererAssetReference(reference))),
  ).sort()

  if (referencedAssetPaths.length === 0) {
    throw new Error(`Packaged renderer validation failed: no staged asset references were found in ${indexPath}`)
  }

  const missingAssetPaths = []
  for (const relativeAssetPath of referencedAssetPaths) {
    const resolvedAssetPath = path.resolve(stagedRendererDir, relativeAssetPath)
    assertPathIsWithinDirectory(
      resolvedAssetPath,
      stagedRendererDir,
      'Packaged renderer validation failed: staged renderer asset reference resolved outside the staged UI directory',
    )

    if (!existsSync(resolvedAssetPath)) {
      missingAssetPaths.push(relativeAssetPath)
    }
  }

  if (missingAssetPaths.length > 0) {
    const stagedAssetsDir = path.join(stagedRendererDir, 'assets')
    const stagedAssetEntries = existsSync(stagedAssetsDir) ? (await fs.promises.readdir(stagedAssetsDir)).sort() : []
    throw new Error(
      `Packaged renderer validation failed: ${path.relative(repoRoot, indexPath)} references missing staged asset(s): ${missingAssetPaths.join(', ')}. Available staged assets: ${stagedAssetEntries.join(', ') || '(none)'}`,
    )
  }

  console.log(
    `[electron/build-all] Verified staged renderer asset references in ${path.relative(repoRoot, indexPath)} (${referencedAssetPaths.length} files)`,
  )
}

function normalizeRendererAssetReference(reference) {
  if (reference.startsWith('/./')) {
    return reference.slice(3)
  }

  if (reference.startsWith('./')) {
    return reference.slice(2)
  }

  if (reference.startsWith('/')) {
    return reference.slice(1)
  }

  return reference
}

async function stageBackendResources() {
  await mkdir(forgeResourcesDir, { recursive: true })

  await writeFile(
    path.join(forgeResourcesDir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    'utf8',
  )

  await copyDirectory(
    path.join(repoRoot, 'apps', 'backend', 'src', 'swarm', 'archetypes'),
    path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'archetypes'),
  )
  await copyDirectory(
    path.join(repoRoot, 'apps', 'backend', 'src', 'swarm', 'operational'),
    path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'operational'),
  )
  await copyDirectory(
    path.join(repoRoot, 'apps', 'backend', 'src', 'swarm', 'skills', 'builtins'),
    path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'skills', 'builtins'),
  )
  await copyDirectory(
    path.join(repoRoot, 'apps', 'backend', 'src', 'swarm', 'specialists', 'builtins'),
    path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'specialists', 'builtins'),
  )
  await copyDirectory(
    path.join(repoRoot, 'apps', 'backend', 'static'),
    path.join(forgeResourcesDir, 'apps', 'backend', 'static'),
  )

  const repoSwarmDir = path.join(repoRoot, '.swarm')
  if (existsSync(repoSwarmDir)) {
    await copyDirectory(repoSwarmDir, path.join(forgeResourcesDir, '.swarm'))
  }
}

async function copyDirectory(from, to) {
  await mkdir(path.dirname(to), { recursive: true })
  await cp(from, to, {
    recursive: true,
    filter: (source) => shouldCopyPackagedResource(from, source),
  })
}

function shouldCopyPackagedResource(root, source) {
  const relativePath = path.relative(root, source)
  if (!relativePath) {
    return true
  }

  return !relativePath.split(path.sep).includes('node_modules')
}

async function assertExists(targetPath, label) {
  try {
    await stat(targetPath)
  } catch {
    throw new Error(`Missing ${label}: ${targetPath}`)
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
      shell: useShell,
    })

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${command} ${args.join(' ')} failed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
    })
  })
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntrypoint) {
  main().catch((error) => {
    console.error('[electron/build-all] Failed to assemble packaged app resources')
    console.error(error)
    process.exit(1)
  })
}
