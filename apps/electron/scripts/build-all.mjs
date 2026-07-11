import gracefulFs from 'graceful-fs'
import fs, { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'

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

  await esbuild({
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
  })

  // Stage backend package.json — needed at runtime by bundled dependencies
  // that walk up the directory tree looking for package.json (e.g. pi-coding-agent
  // reads version and piConfig from it).
  await cp(backendWorkspaceManifestPath, path.join(backendStageDir, 'package.json'))
  await stageBundledDependencyRuntimeAssets()

  const runtimePackages = await collectRuntimePackageClosure(
    BACKEND_BUNDLE_EXTERNAL_PACKAGES.map((pkg) => ({ packageName: pkg.name, optional: pkg.optional }))
  )
  await stageRuntimePackages(runtimePackages)

  const fileCount = await countFiles(backendStageDir)
  console.log(`[electron/build-all] Staged bundled backend with ${runtimePackages.length} runtime packages (${fileCount} files)`)
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

  await validateStagedCursorSdkRuntime(stagedRequire)
  await validateStagedPiCompactionMeasurement(stagedRequire)

  console.log(`[electron/build-all] Packaged-runtime preflight resolved and loaded ${verifiedPackages.length} staged runtime packages`)
  for (const resolution of verifiedPackages) {
    console.log(`[electron/build-all]   ${resolution}`)
  }
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
  const piCodingAgent = await resolveInstalledPackage('@earendil-works/pi-coding-agent', backendWorkspaceManifestPath, false)

  await copyRuntimeAsset(
    path.join(piCodingAgent.packageRoot, 'dist', 'modes', 'interactive', 'theme'),
    path.join(backendStageDir, 'dist', 'modes', 'interactive', 'theme'),
  )
  await copyRuntimeAsset(
    path.join(piCodingAgent.packageRoot, 'dist', 'core', 'export-html'),
    path.join(backendStageDir, 'dist', 'core', 'export-html'),
  )

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

async function collectRuntimePackageClosure(rootPackages) {
  const queuedPackages = rootPackages.map(({ packageName, optional }) => ({
    packageName,
    resolveFromManifestPath: backendWorkspaceManifestPath,
    optional,
  }))
  const discoveredPackages = new Map()

  while (queuedPackages.length > 0) {
    const next = queuedPackages.shift()
    if (!next) {
      continue
    }

    const resolved = await resolveInstalledPackage(next.packageName, next.resolveFromManifestPath, next.optional)
    if (!resolved || discoveredPackages.has(resolved.name)) {
      continue
    }

    discoveredPackages.set(resolved.name, resolved)

    for (const dependency of collectRuntimeDependencyDescriptors(resolved.manifest)) {
      queuedPackages.push({
        packageName: dependency.packageName,
        resolveFromManifestPath: resolved.manifestPath,
        optional: dependency.optional,
      })
    }
  }

  return Array.from(discoveredPackages.values()).sort((left, right) => left.name.localeCompare(right.name))
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
    resolvedEntryPath = packageRequire.resolve(packageName)
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

  while (true) {
    const manifestPath = path.join(currentPath, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.name === expectedPackageName) {
        return {
          name: manifest.name,
          manifest,
          manifestPath,
          packageRoot: currentPath,
        }
      }
    }

    const parentPath = path.dirname(currentPath)
    if (parentPath === currentPath) {
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
  if (runtimePackages.length === 0) {
    return
  }

  await mkdir(backendStageNodeModulesDir, { recursive: true })

  for (const runtimePackage of runtimePackages) {
    const packageTargetDir = path.join(backendStageNodeModulesDir, ...runtimePackage.name.split('/'))
    await copyRuntimePackage(runtimePackage, packageTargetDir)
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
    path.join('dist', 'core', 'messages.js'),
    path.join('dist', 'core', 'compaction', 'utils.js'),
  ]

  for (const relativePath of requiredPaths) {
    if (!existsSync(path.join(stagedPackageDir, relativePath))) {
      return `missing required asset ${relativePath}`
    }
  }

  return null
}

async function validateStagedPiCompactionMeasurement(stagedRequire) {
  const stagedPackageDir = path.join(backendStageNodeModulesDir, '@earendil-works', 'pi-coding-agent')
  const stagedPackageValidationFailure = validateStagedPiCodingAgentPackageDir(stagedPackageDir)
  if (stagedPackageValidationFailure) {
    throw new Error(
      `Packaged-runtime preflight failed: staged Pi compaction measurement package is invalid: ${stagedPackageValidationFailure}`,
    )
  }

  const messagesPath = path.join(stagedPackageDir, 'dist', 'core', 'messages.js')
  const utilsPath = path.join(stagedPackageDir, 'dist', 'core', 'compaction', 'utils.js')

  for (const [label, modulePath] of [
    ['messages', messagesPath],
    ['compaction utils', utilsPath],
  ]) {
    assertPathIsWithinDirectory(
      modulePath,
      backendStageNodeModulesDir,
      `Packaged-runtime preflight failed: Pi compaction ${label} module resolved outside staged node_modules`,
    )

    let loadedModule
    try {
      loadedModule = await loadRuntimeModuleFromEntry(stagedRequire, modulePath)
    } catch (error) {
      throw new Error(
        `Packaged-runtime preflight failed: unable to load Pi compaction ${label} module from ${modulePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    const exportName = label === 'messages' ? 'convertToLlm' : 'serializeConversation'
    if (typeof loadedModule?.[exportName] !== 'function') {
      throw new Error(
        `Packaged-runtime preflight failed: Pi compaction ${label} module at ${modulePath} is missing ${exportName}() export`,
      )
    }
  }

  console.log('[electron/build-all] Packaged-runtime preflight verified Pi compaction measurement modules')
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
