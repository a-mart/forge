import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { externalChromeBuildMode, verifyReleaseSignature } from '../../native-messaging-host/scripts/release-signing.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(electronDir, '..', '..')

export async function stageExternalChromeResources({
  outputRoot = path.join(electronDir, '.stage', 'external-chrome'),
  platform = process.platform,
  architecture = process.arch,
  requireExecutable = true,
  extensionPackageRoot = path.join(repoRoot, 'apps', 'chrome-extension', 'dist'),
  nativePackageRoot = path.join(repoRoot, 'apps', 'native-messaging-host', 'dist'),
  electronManifestPath = path.join(electronDir, 'package.json'),
  verifyExecutable = verifyReleaseExecutable,
  buildMode = externalChromeBuildMode(),
  /** Credential-free SEA artifact accepted only by the unpacked Windows dev preparation path. */
  developmentHost = false,
} = {}) {
  const extensionRoot = path.join(extensionPackageRoot, 'extension')
  const extensionManifest = JSON.parse(await readFile(path.join(extensionPackageRoot, 'package-manifest.json'), 'utf8'))
  const selector = JSON.parse(await readFile(path.join(extensionRoot, 'current.json'), 'utf8'))
  const nativeManifestPath = path.join(nativePackageRoot, 'package-manifest.json')
  const nativeManifest = JSON.parse(await readFile(nativeManifestPath, 'utf8'))
  const electronManifest = JSON.parse(await readFile(electronManifestPath, 'utf8'))

  if (!nativeManifest.executable) {
    const reason = nativeManifest.sea?.reason ?? 'the native package did not produce an executable'
    if (requireExecutable) {
      const label = developmentHost ? 'External Chrome Windows development requires a validation SEA executable' : 'External Chrome packaged release requires a SEA executable'
      throw new Error(`${label}: ${reason}`)
    }
    return { staged: false, reason, nativeManifest }
  }
  if (developmentHost) assertWindowsDevelopmentSea(nativeManifest, platform, buildMode)
  if (nativeManifest.platform !== platform || nativeManifest.architecture !== architecture) {
    throw new Error(`External Chrome native package targets ${nativeManifest.platform}/${nativeManifest.architecture}, expected ${platform}/${architecture}`)
  }
  if (JSON.stringify(nativeManifest.nativeProtocol) !== JSON.stringify(extensionManifest.nativeProtocol)) {
    throw new Error('External Chrome native and extension protocol metadata disagree')
  }

  const { shellFiles, payloadFiles } = verifiedExtensionInventories(extensionManifest, selector)

  const executableSource = path.resolve(nativePackageRoot, '..', nativeManifest.executable.file)
  const executableName = path.basename(nativeManifest.executable.file)
  const executableBytes = await readFile(executableSource)
  if (sha256(executableBytes) !== nativeManifest.executable.sha256) {
    throw new Error('External Chrome signed native executable hash does not match its package manifest')
  }
  const signature = nativeManifest.executable.signature
  await verifyExecutable(executableSource, platform, signature, { allowValidation: buildMode === 'validation' })
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
      signature,
      ...(developmentHost ? { development: developmentSeaProvenance(nativeManifest) } : {}),
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

export async function verifyReleaseExecutable(executable, platform, signature, { allowValidation = false } = {}) {
  return verifyReleaseSignature(executable, signature, { platform, allowValidation })
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

function assertWindowsDevelopmentSea(nativeManifest, platform, buildMode) {
  const signature = nativeManifest.executable?.signature
  if (platform !== 'win32' || buildMode !== 'validation') {
    throw new Error('External Chrome validation SEA development staging is Windows-only and requires validation build mode')
  }
  if (
    nativeManifest.package !== '@forge/external-chrome-native-host' ||
    nativeManifest.bundle?.file !== 'dist/host.cjs' || !isSha256(nativeManifest.bundle?.sha256) ||
    nativeManifest.seaConfig?.file !== 'dist/sea-config.current.json' || !isSha256(nativeManifest.seaConfig?.sha256) ||
    nativeManifest.smoke !== 'desktop-unavailable' ||
    signature?.scheme !== 'authenticode' || signature.mode !== 'validation' || signature.verified !== false ||
    signature.signer !== null || signature.teamId !== null
  ) {
    throw new Error('External Chrome Windows development requires the native host package validation SEA manifest')
  }
}

function developmentSeaProvenance(nativeManifest) {
  return {
    source: 'validation-sea',
    package: '@forge/external-chrome-native-host',
    bundleSha256: nativeManifest.bundle.sha256,
    seaConfigSha256: nativeManifest.seaConfig.sha256,
  }
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function verifiedExtensionInventories(extensionManifest, selector) {
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
  ) throw new Error('External Chrome extension selector and package inventories disagree')
  return { shellFiles, payloadFiles }
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
