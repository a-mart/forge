import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { endianness } from 'node:os'
import { fileURLToPath } from 'node:url'
import { stageExternalChromeResources } from './stage-external-chrome.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(electronDir, '..', '..')
const extensionPackageRoot = path.join(repoRoot, 'apps', 'chrome-extension', 'dist')
const nativeHostRoot = path.join(repoRoot, 'apps', 'native-messaging-host')
const extensionOrigin = 'chrome-extension://fcchfcnadajoejfbiclihglkmbcfhajd/'
const nativeHostPackage = '@forge/external-chrome-native-host'
const executableName = 'forge-external-chrome-native-host'

export async function prepareExternalChromeDevelopmentResources({
  outputRoot = path.join(electronDir, '.dev-external-chrome'),
  platform = process.platform,
  architecture = process.arch,
  nodeExecutable = process.execPath,
  extensionRoot = path.join(extensionPackageRoot, 'extension'),
  extensionManifestPath = path.join(extensionPackageRoot, 'package-manifest.json'),
  nativeBundlePath = path.join(nativeHostRoot, 'dist', 'host.cjs'),
  seaConfigPath = path.join(nativeHostRoot, 'sea-config.json'),
  electronManifestPath = path.join(electronDir, 'package.json'),
  smoke = smokeDevelopmentHost,
  packageWindowsNativeHost = packageWindowsDevelopmentHost,
  stageResources = stageExternalChromeResources,
  verifyExecutable,
} = {}) {
  if (platform === 'win32') {
    const cached = await reuseWindowsDevelopmentResources({
      outputRoot, platform, architecture, extensionRoot, extensionManifestPath, nativeBundlePath, seaConfigPath, electronManifestPath,
    })
    if (cached) return cached

    try {
      await packageWindowsNativeHost()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        'External Chrome Windows development requires the repository Node executable to support SEA (NODE_SEA_FUSE). ' +
        `Select an official SEA-capable Node build for this checkout and rerun prepare:dev-external-chrome. ${detail}`,
      )
    }

    const staged = await stageResources({
      outputRoot,
      platform,
      architecture,
      extensionPackageRoot: path.dirname(extensionRoot),
      nativePackageRoot: path.dirname(nativeBundlePath),
      electronManifestPath,
      buildMode: 'validation',
      developmentHost: true,
      ...(verifyExecutable ? { verifyExecutable } : {}),
    })
    if (!staged.staged || !staged.manifest) {
      throw new Error(`External Chrome Windows development SEA preparation did not produce a native host: ${staged.reason ?? 'unknown failure'}`)
    }
    return { outputRoot, manifest: staged.manifest }
  }

  if (nodeExecutable.includes('\n') || nodeExecutable.includes('\r') || nodeExecutable.includes(' ')) {
    throw new Error('External Chrome development native host requires a Node executable path without whitespace or line breaks')
  }

  const [extensionManifest, selector, electronManifest, nativeBundle] = await Promise.all([
    readJson(extensionManifestPath),
    readJson(path.join(extensionRoot, 'current.json')),
    readJson(electronManifestPath),
    readFile(nativeBundlePath),
  ])
  const { shellFiles, payloadFiles } = verifiedExtensionInventories(extensionManifest, selector, 'development')

  const executable = Buffer.concat([Buffer.from(`#!${nodeExecutable}\n`), nativeBundle])
  const nextRoot = `${outputRoot}.tmp`
  await rm(nextRoot, { recursive: true, force: true })
  const shellRoot = path.join(nextRoot, 'extension-shell')
  const payloadRoot = path.join(nextRoot, 'payload', selector.payloadDirectory)
  const nativeRoot = path.join(nextRoot, 'native-host', `${platform}-${architecture}`)
  await Promise.all([
    copyInventory(extensionRoot, shellRoot, shellFiles),
    copyInventory(path.join(extensionRoot, 'payloads', selector.payloadDirectory), payloadRoot, payloadFiles),
    mkdir(nativeRoot, { recursive: true }),
  ])
  const executablePath = path.join(nativeRoot, executableName)
  await writeFile(executablePath, executable, { mode: 0o755 })
  await chmod(executablePath, 0o755)
  await smoke(executablePath, extensionOrigin)

  const packageManifest = {
    schemaVersion: 1,
    packageVersion: electronManifest.version,
    extension: {
      extensionId: extensionManifest.extension.extensionId,
      publicKeySha256: extensionManifest.extension.publicKeySha256,
      minimumChromeVersion: extensionManifest.extension.minimumChromeVersion,
      shellAbi: extensionManifest.extension.shellAbi,
      shellSha256: extensionManifest.extension.shellSha256,
      payloadVersion: extensionManifest.extension.payloadVersion,
      payloadSha256: extensionManifest.extension.payloadSha256,
      payloadDirectory: selector.payloadDirectory,
      shellFiles,
      payloadFiles,
    },
    nativeHost: {
      protocol: extensionManifest.nativeProtocol,
      version: 'development',
      platform,
      architecture,
      executable: executableName,
      sha256: sha256(executable),
      required: true,
      signature: { scheme: 'node-shebang', mode: 'development', verified: false, signer: null, teamId: null },
    },
    compatibility: {
      desktop: { min: '0.22.0', max: '0.22.999' },
      shellAbi: { min: extensionManifest.extension.shellAbi, max: extensionManifest.extension.shellAbi },
    },
  }
  await writeFile(path.join(nextRoot, 'package-manifest.json'), `${stableJson(packageManifest)}\n`, 'utf8')
  await rm(outputRoot, { recursive: true, force: true })
  await rename(nextRoot, outputRoot)
  return { outputRoot, manifest: packageManifest }
}

/** Reuse an already hash-checked SEA stage when the bundled host and extension inventories are unchanged. */
async function reuseWindowsDevelopmentResources({
  outputRoot, platform, architecture, extensionRoot, extensionManifestPath, nativeBundlePath, seaConfigPath, electronManifestPath,
}) {
  try {
    const [manifest, extensionManifest, selector, electronManifest, nativeBundle, seaConfig] = await Promise.all([
      readJson(path.join(outputRoot, 'package-manifest.json')),
      readJson(extensionManifestPath),
      readJson(path.join(extensionRoot, 'current.json')),
      readJson(electronManifestPath),
      readFile(nativeBundlePath),
      readJson(seaConfigPath),
    ])
    const { shellFiles, payloadFiles } = verifiedExtensionInventories(extensionManifest, selector, 'development')
    const nativeHost = manifest?.nativeHost
    const extension = manifest?.extension
    const sourceExtension = extensionManifest.extension
    if (
      manifest?.schemaVersion !== 1 || manifest.packageVersion !== electronManifest.version ||
      extension?.extensionId !== sourceExtension.extensionId || extension.publicKeySha256 !== sourceExtension.publicKeySha256 ||
      extension.minimumChromeVersion !== sourceExtension.minimumChromeVersion || extension.shellAbi !== sourceExtension.shellAbi ||
      extension.shellSha256 !== sourceExtension.shellSha256 || extension.payloadVersion !== sourceExtension.payloadVersion ||
      extension.payloadSha256 !== sourceExtension.payloadSha256 || extension.payloadDirectory !== selector.payloadDirectory ||
      stableJson(extension.shellFiles) !== stableJson(shellFiles) || stableJson(extension.payloadFiles) !== stableJson(payloadFiles) ||
      nativeHost?.platform !== platform || nativeHost.architecture !== architecture ||
      nativeHost.executable !== `${executableName}.exe` ||
      nativeHost.signature?.scheme !== 'authenticode' || nativeHost.signature?.mode !== 'validation' ||
      nativeHost.signature?.verified !== false || nativeHost.signature?.signer !== null || nativeHost.signature?.teamId !== null ||
      nativeHost.development?.source !== 'validation-sea' || nativeHost.development?.package !== nativeHostPackage ||
      nativeHost.development?.bundleSha256 !== sha256(nativeBundle) ||
      nativeHost.development?.seaConfigSha256 !== currentWindowsSeaConfigHash(seaConfig)
    ) return null

    const nativeRoot = path.join(outputRoot, 'native-host', `${platform}-${architecture}`)
    const nativePath = path.join(nativeRoot, nativeHost.executable)
    if (sha256(await readFile(nativePath)) !== nativeHost.sha256) return null
    if (!(await inventoryMatches(path.join(outputRoot, 'extension-shell'), shellFiles))) return null
    if (!(await inventoryMatches(path.join(outputRoot, 'payload', selector.payloadDirectory), payloadFiles))) return null
    return { outputRoot, manifest }
  } catch {
    return null
  }
}

export async function smokeDevelopmentHost(executable, origin) {
  const args = [origin, ...(process.platform === 'win32' ? ['--parent-window=0'] : [])]
  const result = spawnSync(executable, args, { input: Buffer.alloc(0), maxBuffer: 64 * 1_024 })
  if (result.status !== 1) throw new Error(`development native host smoke returned ${String(result.status)}: ${result.stderr.toString('utf8')}`)
  if (result.stdout.byteLength < 5) throw new Error('development native host smoke did not emit a native message')
  const length = endianness() === 'LE' ? result.stdout.readUInt32LE(0) : result.stdout.readUInt32BE(0)
  const message = JSON.parse(result.stdout.subarray(4).toString('utf8'))
  if (length !== result.stdout.byteLength - 4 || message?.type !== 'desktop-unavailable') {
    throw new Error('development native host smoke emitted an unexpected response')
  }
}

async function buildInputs() {
  await run('pnpm', ['--filter', '@forge/chrome-extension', 'build'], repoRoot)
  await run('pnpm', ['--filter', '@forge/external-chrome-native-host', 'build'], repoRoot)
}

export async function packageWindowsDevelopmentHost({
  executable = process.execPath,
  runCommand = run,
} = {}) {
  // Directly execute node.exe: shell interpolation breaks valid paths such as Program Files.
  await runCommand(executable, [path.join(nativeHostRoot, 'scripts', 'package-current.mjs')], nativeHostRoot, {
    ...process.env,
    // Never source release signing credentials for a dev host, even when a shell inherited them.
    FORGE_EXTERNAL_CHROME_BUILD_MODE: 'validation',
  }, false)
}

async function run(command, args, cwd, env = process.env, shell = process.platform === 'win32') {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell })
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`)))
  })
}

async function copyInventory(sourceRoot, targetRoot, inventory) {
  for (const relative of Object.keys(inventory).sort()) {
    const bytes = await readFile(path.join(sourceRoot, ...relative.split('/')))
    if (sha256(bytes) !== inventory[relative]) throw new Error(`External Chrome development staging hash mismatch: ${relative}`)
    const target = path.join(targetRoot, ...relative.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
}

async function inventoryMatches(root, inventory) {
  const found = []
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const relative = path.relative(root, target).split(path.sep).join('/')
      const info = await lstat(target)
      if (info.isSymbolicLink()) return false
      if (info.isDirectory()) {
        if (!(await visit(target))) return false
      } else if (info.isFile()) {
        found.push(relative)
        if (sha256(await readFile(target)) !== inventory[relative]) return false
      } else return false
    }
    return true
  }
  try {
    if (!(await visit(root))) return false
    return found.sort().join('\0') === Object.keys(inventory).sort().join('\0')
  } catch {
    return false
  }
}

function verifiedExtensionInventories(extensionManifest, selector, label) {
  const extension = extensionManifest?.extension
  const shellFiles = extension?.shellFiles
  const payloadFiles = extension?.payloadFiles
  const expectedPayloadFiles = ['content-script.js', 'service-worker.js']
  if (
    extension?.payloadVersion !== selector.payloadVersion || extension?.payloadSha256 !== selector.payloadSha256
    || extension?.payloadDirectory !== selector.payloadDirectory
    || stableJson(payloadFiles) !== stableJson(selector.payloadFiles)
    || Object.keys(payloadFiles ?? {}).sort().join('\0') !== expectedPayloadFiles.join('\0')
    || Object.keys(shellFiles ?? {}).length === 0
  ) throw new Error(`External Chrome ${label} selector and package inventories disagree`)
  return { shellFiles, payloadFiles }
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function currentWindowsSeaConfigHash(seaConfig) {
  return sha256(Buffer.from(`${stableJson({ ...seaConfig, output: `dist/${executableName}.exe` })}\n`))
}
function readJson(file) { return readFile(file, 'utf8').then(JSON.parse) }
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildInputs().then(() => prepareExternalChromeDevelopmentResources())
    .then((result) => process.stdout.write(`[external-chrome-dev] prepared ${result.outputRoot}\n`))
    .catch((error) => { console.error(error); process.exitCode = 1 })
}
