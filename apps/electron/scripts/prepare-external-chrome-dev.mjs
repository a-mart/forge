import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { endianness } from 'node:os'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(electronDir, '..', '..')
const extensionPackageRoot = path.join(repoRoot, 'apps', 'chrome-extension', 'dist')
const nativeHostRoot = path.join(repoRoot, 'apps', 'native-messaging-host')
const extensionOrigin = 'chrome-extension://fcchfcnadajoejfbiclihglkmbcfhajd/'

export async function prepareExternalChromeDevelopmentResources({
  outputRoot = path.join(electronDir, '.dev-external-chrome'),
  platform = process.platform,
  architecture = process.arch,
  nodeExecutable = process.execPath,
  extensionRoot = path.join(extensionPackageRoot, 'extension'),
  extensionManifestPath = path.join(extensionPackageRoot, 'package-manifest.json'),
  nativeBundlePath = path.join(nativeHostRoot, 'dist', 'host.cjs'),
  electronManifestPath = path.join(electronDir, 'package.json'),
  smoke = smokeDevelopmentHost,
} = {}) {
  if (platform === 'win32') {
    throw new Error('External Chrome development native host currently requires a POSIX shebang launcher; Windows dev host preparation is unsupported')
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

  const executableName = 'forge-external-chrome-native-host'
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

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
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
function readJson(file) { return readFile(file, 'utf8').then(JSON.parse) }
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildInputs()
    .then(() => prepareExternalChromeDevelopmentResources())
    .then(({ outputRoot }) => process.stdout.write(`[external-chrome-dev] prepared ${outputRoot}\n`))
    .catch((error) => { console.error(error); process.exitCode = 1 })
}
