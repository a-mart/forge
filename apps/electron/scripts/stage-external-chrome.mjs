import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(electronDir, '..', '..')
const execFileAsync = promisify(execFile)

export async function stageExternalChromeResources({
  outputRoot = path.join(electronDir, '.stage', 'external-chrome'),
  platform = process.platform,
  architecture = process.arch,
  requireExecutable = true,
  extensionPackageRoot = path.join(repoRoot, 'apps', 'chrome-extension', 'dist'),
  nativePackageRoot = path.join(repoRoot, 'apps', 'native-messaging-host', 'dist'),
  electronManifestPath = path.join(electronDir, 'package.json'),
  verifyExecutable = verifyReleaseExecutable,
} = {}) {
  const extensionRoot = path.join(extensionPackageRoot, 'extension')
  const extensionManifest = JSON.parse(await readFile(path.join(extensionPackageRoot, 'package-manifest.json'), 'utf8'))
  const selector = JSON.parse(await readFile(path.join(extensionRoot, 'current.json'), 'utf8'))
  const nativeManifestPath = path.join(nativePackageRoot, 'package-manifest.json')
  const nativeManifest = JSON.parse(await readFile(nativeManifestPath, 'utf8'))
  const electronManifest = JSON.parse(await readFile(electronManifestPath, 'utf8'))

  if (!nativeManifest.executable) {
    const reason = nativeManifest.sea?.reason ?? 'the native package did not produce an executable'
    if (requireExecutable) throw new Error(`External Chrome packaged release requires a SEA executable: ${reason}`)
    return { staged: false, reason, nativeManifest }
  }
  if (nativeManifest.platform !== platform || nativeManifest.architecture !== architecture) {
    throw new Error(`External Chrome native package targets ${nativeManifest.platform}/${nativeManifest.architecture}, expected ${platform}/${architecture}`)
  }
  if (JSON.stringify(nativeManifest.nativeProtocol) !== JSON.stringify(extensionManifest.nativeProtocol)) {
    throw new Error('External Chrome native and extension protocol metadata disagree')
  }

  const shellFiles = {}
  const payloadFiles = {}
  const payloadPrefix = `payloads/${selector.payloadDirectory}/`
  for (const [relative, digest] of Object.entries(extensionManifest.extension.fileHashes)) {
    if (relative === 'current.json') continue
    if (relative.startsWith(payloadPrefix)) payloadFiles[relative.slice(payloadPrefix.length)] = digest
    else shellFiles[relative] = digest
  }
  if (Object.keys(shellFiles).length === 0 || Object.keys(payloadFiles).length === 0) {
    throw new Error('External Chrome extension package manifest has an incomplete inventory')
  }

  const executableSource = path.resolve(nativePackageRoot, '..', nativeManifest.executable.file)
  const executableName = path.basename(nativeManifest.executable.file)
  await verifyExecutable(executableSource, platform)
  const nextRoot = `${outputRoot}.tmp`
  await rm(nextRoot, { recursive: true, force: true })
  const shellRoot = path.join(nextRoot, 'extension-shell')
  const payloadRoot = path.join(nextRoot, 'payload', selector.payloadDirectory)
  const nativeTargetRoot = path.join(nextRoot, 'native-host', `${platform}-${architecture}`)
  await Promise.all([
    copyInventory(extensionRoot, shellRoot, shellFiles),
    copyInventory(path.join(extensionRoot, 'payloads', selector.payloadDirectory), payloadRoot, payloadFiles),
    mkdir(nativeTargetRoot, { recursive: true }),
  ])
  await cp(executableSource, path.join(nativeTargetRoot, executableName))

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
      protocol: nativeManifest.nativeProtocol,
      version: nativeManifest.version,
      platform,
      architecture,
      executable: executableName,
      sha256: nativeManifest.executable.sha256,
      required: true,
      signature: {
        scheme: platform === 'darwin' ? 'developer-id' : platform === 'win32' ? 'authenticode' : 'packaged-resource-hash',
        verified: true,
      },
    },
    compatibility: {
      desktop: { min: '0.22.0', max: '0.22.999' },
      shellAbi: { min: extensionManifest.extension.shellAbi, max: extensionManifest.extension.shellAbi },
    },
  }
  await writeFile(path.join(nextRoot, 'package-manifest.json'), `${stableJson(packageManifest)}\n`, 'utf8')
  await rm(outputRoot, { recursive: true, force: true })
  await rename(nextRoot, outputRoot)
  return { staged: true, manifest: packageManifest, sha256: sha256(Buffer.from(stableJson(packageManifest))) }
}

export async function verifyReleaseExecutable(executable, platform) {
  if (platform === 'darwin') {
    await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', executable])
    return
  }
  if (platform === 'win32') {
    const command = `(Get-AuthenticodeSignature -LiteralPath '${executable.replaceAll("'", "''")}').Status`
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
    if (stdout.trim() !== 'Valid') throw new Error('External Chrome native host Authenticode signature is not valid')
    return
  }
  const info = await stat(executable)
  if ((info.mode & 0o111) === 0) throw new Error('External Chrome Linux native host is not executable')
}

async function copyInventory(sourceRoot, targetRoot, inventory) {
  for (const relative of Object.keys(inventory).sort()) {
    const source = path.join(sourceRoot, ...relative.split('/'))
    const target = path.join(targetRoot, ...relative.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    const bytes = await readFile(source)
    if (sha256(bytes) !== inventory[relative]) throw new Error(`External Chrome staging hash mismatch: ${relative}`)
    await writeFile(target, bytes)
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageExternalChromeResources().then(
    (result) => process.stdout.write(`${result.sha256 ?? result.reason}\n`),
    (error) => { console.error(error); process.exitCode = 1 },
  )
}
