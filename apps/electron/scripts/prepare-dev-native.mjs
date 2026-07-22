import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { rebuild } from '@electron/rebuild'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(electronDir, '..', '..')
const backendDir = path.join(repoRoot, 'apps', 'backend')
const cacheRoot = path.join(electronDir, '.dev-native', 'better-sqlite3')
const manifestPath = path.join(cacheRoot, 'manifest.json')
const BINDING_RELATIVE_PATH = path.join('build', 'Release', 'better_sqlite3.node')

const electronRequire = createRequire(path.join(electronDir, 'package.json'))
const backendRequire = createRequire(path.join(backendDir, 'package.json'))

export async function prepareElectronBetterSqlite3Binding() {
  const electronPackagePath = electronRequire.resolve('electron/package.json')
  const electronPackage = JSON.parse(await readFile(electronPackagePath, 'utf8'))
  const electronVersion = requireNonEmptyString(electronPackage.version, 'Electron package version')
  const electronExecutable = electronRequire('electron')

  const sqlitePackagePath = backendRequire.resolve('better-sqlite3/package.json')
  const sqlitePackageDir = path.dirname(sqlitePackagePath)
  const sqlitePackage = JSON.parse(await readFile(sqlitePackagePath, 'utf8'))
  const sqliteVersion = requireNonEmptyString(sqlitePackage.version, 'better-sqlite3 package version')
  const installedBindingPath = path.join(sqlitePackageDir, BINDING_RELATIVE_PATH)
  const installedBindingHash = await hashRequiredFile(
    installedBindingPath,
    'Host-Node better-sqlite3 binding. Run pnpm install before pnpm dev:electron.',
  )
  const sourceFingerprint = await hashSourceTree(sqlitePackageDir)
  const cacheKey = [
    `better-sqlite3-${sqliteVersion}`,
    `electron-${electronVersion}`,
    process.platform,
    process.arch,
    sourceFingerprint.slice(0, 16),
  ].join('-')
  const cachedBindingDir = path.join(cacheRoot, cacheKey)
  const cachedBindingPath = path.join(cachedBindingDir, 'better_sqlite3.node')

  await mkdir(cacheRoot, { recursive: true })

  if (await isFile(cachedBindingPath)) {
    try {
      await smokeTestBinding(electronExecutable, cachedBindingPath)
      await assertHostBindingUnchanged(installedBindingPath, installedBindingHash)
      await writeManifest({
        bindingPath: cachedBindingPath,
        electronVersion,
        moduleVersion: sqliteVersion,
        platform: process.platform,
        arch: process.arch,
        sourceFingerprint,
      })
      console.log(`[electron/dev-native] Reusing verified better-sqlite3 binding at ${cachedBindingPath}`)
      return cachedBindingPath
    } catch (error) {
      console.warn(`[electron/dev-native] Cached binding is invalid and will be rebuilt: ${toErrorMessage(error)}`)
      await rm(cachedBindingDir, { recursive: true, force: true })
    }
  }

  const stagingDir = path.join(cacheRoot, `.staging-${process.pid}-${Date.now()}`)
  const stagedModuleDir = path.join(stagingDir, 'better-sqlite3')

  try {
    await mkdir(stagingDir, { recursive: true })
    await cp(sqlitePackageDir, stagedModuleDir, {
      recursive: true,
      filter: (sourcePath) => shouldCopySourcePath(sqlitePackageDir, sourcePath),
    })

    const stagedBindingPath = path.join(stagedModuleDir, BINDING_RELATIVE_PATH)
    const downloadedPrebuild = await tryInstallPrebuiltBinding({
      electronVersion,
      sqlitePackagePath,
      stagedModuleDir,
    })

    if (!downloadedPrebuild || !(await isFile(stagedBindingPath))) {
      console.log('[electron/dev-native] Electron prebuild unavailable; rebuilding better-sqlite3 from source')
      await rebuild({
        buildPath: stagedModuleDir,
        electronVersion,
        platform: process.platform,
        arch: process.arch,
        force: true,
        buildFromSource: true,
      })
    }

    await hashRequiredFile(stagedBindingPath, 'Rebuilt Electron better-sqlite3 binding')
    await smokeTestBinding(electronExecutable, stagedBindingPath)
    await assertHostBindingUnchanged(installedBindingPath, installedBindingHash)

    await mkdir(cachedBindingDir, { recursive: true })
    const temporaryBindingPath = path.join(cachedBindingDir, `.better_sqlite3.node-${process.pid}.tmp`)
    await cp(stagedBindingPath, temporaryBindingPath)
    await rename(temporaryBindingPath, cachedBindingPath)
    await smokeTestBinding(electronExecutable, cachedBindingPath)

    await writeManifest({
      bindingPath: cachedBindingPath,
      electronVersion,
      moduleVersion: sqliteVersion,
      platform: process.platform,
      arch: process.arch,
      sourceFingerprint,
    })
    console.log(`[electron/dev-native] Prepared verified better-sqlite3 binding at ${cachedBindingPath}`)
    return cachedBindingPath
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
    await assertHostBindingUnchanged(installedBindingPath, installedBindingHash)
  }
}

async function tryInstallPrebuiltBinding({ electronVersion, sqlitePackagePath, stagedModuleDir }) {
  const sqliteRequire = createRequire(sqlitePackagePath)
  let prebuildPackagePath

  try {
    prebuildPackagePath = sqliteRequire.resolve('prebuild-install/package.json')
  } catch (error) {
    console.warn(`[electron/dev-native] Unable to resolve prebuild-install: ${toErrorMessage(error)}`)
    return false
  }

  const prebuildPackage = JSON.parse(await readFile(prebuildPackagePath, 'utf8'))
  const relativeBinPath = resolvePackageBin(prebuildPackage.bin, 'prebuild-install')
  const prebuildBinPath = path.resolve(path.dirname(prebuildPackagePath), relativeBinPath)

  try {
    await run(process.execPath, [
      prebuildBinPath,
      '--runtime=electron',
      `--target=${electronVersion}`,
      `--platform=${process.platform}`,
      `--arch=${process.arch}`,
    ], { cwd: stagedModuleDir })
    return true
  } catch (error) {
    console.warn(`[electron/dev-native] Electron prebuild download failed: ${toErrorMessage(error)}`)
    return false
  }
}

async function smokeTestBinding(electronExecutable, bindingPath) {
  const smokeSource = [
    "const Database = require('better-sqlite3')",
    "const database = new Database(':memory:', { nativeBinding: process.env.FORGE_SQLITE_SMOKE_BINDING })",
    "const row = database.prepare('SELECT 1 AS value').get()",
    'database.close()',
    "if (row?.value !== 1) throw new Error('Unexpected SQLite smoke result')",
  ].join(';')

  await run(electronExecutable, ['-e', smokeSource], {
    cwd: backendDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FORGE_SQLITE_SMOKE_BINDING: bindingPath,
    },
  })
}

async function writeManifest(manifest) {
  const temporaryManifestPath = path.join(cacheRoot, `.manifest-${process.pid}.tmp`)
  await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rm(manifestPath, { force: true })
  await rename(temporaryManifestPath, manifestPath)
}

async function hashSourceTree(rootDir) {
  const hash = createHash('sha256')
  await addDirectoryToHash(hash, rootDir, rootDir)
  return hash.digest('hex')
}

async function addDirectoryToHash(hash, rootDir, currentDir) {
  const entries = await readdir(currentDir, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name)
    const relativePath = path.relative(rootDir, absolutePath)
    if (!shouldCopySourcePath(rootDir, absolutePath)) {
      continue
    }

    hash.update(relativePath)
    if (entry.isDirectory()) {
      await addDirectoryToHash(hash, rootDir, absolutePath)
    } else if (entry.isFile()) {
      hash.update(await readFile(absolutePath))
    }
  }
}

function shouldCopySourcePath(rootDir, sourcePath) {
  const relativePath = path.relative(rootDir, sourcePath)
  if (!relativePath) {
    return true
  }

  const firstSegment = relativePath.split(path.sep)[0]
  return firstSegment !== 'build' && firstSegment !== 'node_modules'
}

async function hashRequiredFile(filePath, description) {
  if (!(await isFile(filePath))) {
    throw new Error(`${description} was not found at ${filePath}`)
  }

  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function assertHostBindingUnchanged(installedBindingPath, expectedHash) {
  const currentHash = await hashRequiredFile(installedBindingPath, 'Host-Node better-sqlite3 binding')
  if (currentHash !== expectedHash) {
    throw new Error(`Electron preparation modified the shared Host-Node binding at ${installedBindingPath}`)
  }
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile()
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function resolvePackageBin(bin, commandName) {
  if (typeof bin === 'string' && bin.trim()) {
    return bin
  }
  if (bin && typeof bin === 'object' && typeof bin[commandName] === 'string' && bin[commandName].trim()) {
    return bin[commandName]
  }
  throw new Error(`Package does not declare a ${commandName} executable`)
}

function requireNonEmptyString(value, description) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${description} is missing`)
  }
  return value.trim()
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with code=${String(code)} signal=${String(signal)}`))
    })
  })
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareElectronBetterSqlite3Binding().catch((error) => {
    console.error(`[electron/dev-native] ${toErrorMessage(error)}`)
    process.exitCode = 1
  })
}
