import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyReleaseSignature } from '../../native-messaging-host/scripts/release-signing.mjs'

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function verifyPackagedExternalChromeResources({
  root = path.join(electronDir, '.stage', 'external-chrome'),
  platform = process.platform,
  architecture = process.arch,
  allowValidation = process.env.FORGE_EXTERNAL_CHROME_BUILD_MODE === 'validation',
  verifySignature = verifyReleaseSignature,
} = {}) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package-manifest.json'), 'utf8'))

  if (manifest.schemaVersion !== 1 || manifest.nativeHost?.required !== true) fail('native executable is not marked required')
  if (manifest.nativeHost.platform !== platform || manifest.nativeHost.architecture !== architecture) {
    fail(`metadata targets ${manifest.nativeHost.platform}/${manifest.nativeHost.architecture}, expected ${platform}/${architecture}`)
  }

  await verifyInventory(path.join(root, 'extension-shell'), manifest.extension.shellFiles)
  await verifyInventory(path.join(root, 'payload', manifest.extension.payloadDirectory), manifest.extension.payloadFiles)
  const nativeRoot = path.join(root, 'native-host', `${manifest.nativeHost.platform}-${manifest.nativeHost.architecture}`)
  await verifyInventory(nativeRoot, { [manifest.nativeHost.executable]: manifest.nativeHost.sha256 })
  await verifySignature(path.join(nativeRoot, manifest.nativeHost.executable), manifest.nativeHost.signature, {
    platform,
    allowValidation,
  })
  process.stdout.write(`[external-chrome-package] verified ${manifest.packageVersion} for ${manifest.nativeHost.platform}/${manifest.nativeHost.architecture} (${manifest.nativeHost.signature.mode})\n`)
  return manifest
}

async function verifyInventory(directory, inventory) {
  const files = await walk(directory)
  const expected = Object.keys(inventory).sort()
  if (files.join('\0') !== expected.join('\0')) fail(`inventory mismatch in ${directory}`)
  for (const relative of files) {
    const digest = createHash('sha256').update(await readFile(path.join(directory, relative))).digest('hex')
    if (digest !== inventory[relative]) fail(`hash mismatch for ${relative}`)
  }
}

async function walk(directory, root = directory) {
  const files = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) fail(`symlink found: ${absolute}`)
    if (info.isDirectory()) files.push(...await walk(absolute, root))
    else if (info.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'))
    else fail(`unsupported entry: ${absolute}`)
  }
  return files.sort()
}

function fail(message) {
  throw new Error(`[external-chrome-package] ${message}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(electronDir, '.stage', 'external-chrome'))
  verifyPackagedExternalChromeResources({ root }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
