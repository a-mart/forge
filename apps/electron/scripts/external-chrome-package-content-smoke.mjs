import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(process.argv[2] ?? path.join(electronDir, '.stage', 'external-chrome'))
const manifest = JSON.parse(await readFile(path.join(root, 'package-manifest.json'), 'utf8'))

if (manifest.schemaVersion !== 1 || manifest.nativeHost?.required !== true) fail('native executable is not marked required')
if (manifest.nativeHost.signature?.verified !== true) fail('native executable signature is not marked verified')
if (manifest.nativeHost.platform !== process.platform || manifest.nativeHost.architecture !== process.arch) {
  fail(`metadata targets ${manifest.nativeHost.platform}/${manifest.nativeHost.architecture}, expected ${process.platform}/${process.arch}`)
}

await verifyInventory(path.join(root, 'extension-shell'), manifest.extension.shellFiles)
await verifyInventory(path.join(root, 'payload', manifest.extension.payloadDirectory), manifest.extension.payloadFiles)
await verifyInventory(path.join(root, 'native-host', `${manifest.nativeHost.platform}-${manifest.nativeHost.architecture}`), {
  [manifest.nativeHost.executable]: manifest.nativeHost.sha256,
})
process.stdout.write(`[external-chrome-package] verified ${manifest.packageVersion} for ${manifest.nativeHost.platform}/${manifest.nativeHost.architecture}\n`)

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
