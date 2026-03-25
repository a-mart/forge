import gracefulFs from 'graceful-fs'
import fs, { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

gracefulFs.gracefulify(fs)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(electronDir, '..', '..')
const backendWorkspaceDir = path.join(repoRoot, 'apps', 'backend')
const backendWorkspaceManifestPath = path.join(backendWorkspaceDir, 'package.json')
const backendBuildEntry = path.join(backendWorkspaceDir, 'dist', 'index.js')
const stageDir = path.join(electronDir, '.stage')
const backendStageDir = path.join(stageDir, 'backend')
const backendStageBundlePath = path.join(backendStageDir, 'dist', 'index.mjs')
const backendStageNodeModulesDir = path.join(backendStageDir, 'node_modules')
const uiStageDir = path.join(stageDir, 'ui')
const forgeResourcesDir = path.join(stageDir, 'forge-resources')
const pnpmCommand = 'pnpm'
const useShell = process.platform === 'win32'

const BACKEND_BUNDLE_EXTERNAL_PACKAGES = ['sharp', 'koffi', '@mariozechner/clipboard']
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
const declarationSuffixes = ['.d.ts', '.d.mts', '.d.cts']
const declarationMapSuffixes = ['.d.ts.map', '.d.mts.map', '.d.cts.map']
const docsPrefixes = ['license', 'changelog', 'readme']
const docsPrunableExtensions = new Set(['', '.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc', '.rtf'])

async function main() {
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })

  await run(pnpmCommand, ['--dir', repoRoot, '--filter', '@forge/protocol', 'build'])
  await run(pnpmCommand, ['--dir', repoRoot, '--filter', '@forge/backend', 'build'])
  await run(pnpmCommand, ['--dir', repoRoot, '--filter', '@forge/ui', 'build'])
  await run(pnpmCommand, ['--dir', electronDir, 'build'])

  await stageBundledBackend()
  await stageRendererAssets()
  await stageBackendResources()

  await assertExists(backendStageBundlePath, 'staged backend bundle entry')
  await assertExists(path.join(uiStageDir, 'index.html'), 'staged renderer entry')
  await assertExists(
    path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'skills', 'builtins'),
    'staged built-in skills',
  )
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
    external: BACKEND_BUNDLE_EXTERNAL_PACKAGES,
    define: {
      'process.env.FORGE_BUNDLED_BACKEND': '"1"',
    },
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'info',
    legalComments: 'none',
  })

  const runtimePackages = await collectRuntimePackageClosure(BACKEND_BUNDLE_EXTERNAL_PACKAGES)
  await stageRuntimePackages(runtimePackages)

  const fileCount = await countFiles(backendStageDir)
  console.log(`[electron/build-all] Staged bundled backend with ${runtimePackages.length} runtime packages (${fileCount} files)`)
}

async function collectRuntimePackageClosure(rootPackageNames) {
  const queuedPackages = rootPackageNames.map((packageName) => ({
    packageName,
    resolveFromManifestPath: backendWorkspaceManifestPath,
    optional: false,
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
    descriptors.push({ packageName, optional: false })
  }

  for (const packageName of Object.keys(manifest.optionalDependencies ?? {})) {
    descriptors.push({ packageName, optional: true })
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

  return !shouldPruneNodeModulesFile(path.basename(sourcePath))
}

function shouldPruneNodeModulesFile(fileName) {
  const normalizedFileName = fileName.toLowerCase()

  if (declarationMapSuffixes.some((suffix) => normalizedFileName.endsWith(suffix))) {
    return true
  }

  if (declarationSuffixes.some((suffix) => normalizedFileName.endsWith(suffix))) {
    return true
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

async function stageRendererAssets() {
  await copyDirectory(path.join(repoRoot, 'apps', 'ui', '.output', 'public'), uiStageDir)

  const shellPath = path.join(uiStageDir, '_shell.html')
  if (existsSync(shellPath)) {
    await cp(shellPath, path.join(uiStageDir, 'index.html'))
  }
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
  await cp(from, to, { recursive: true })
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

main().catch((error) => {
  console.error('[electron/build-all] Failed to assemble packaged app resources')
  console.error(error)
  process.exit(1)
})
