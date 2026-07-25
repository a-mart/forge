import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashTree, sha256, sortedFiles, stableJson } from './deterministic.mjs'
import { verifyIdentity } from './verify-identity.mjs'

export async function createPackageManifest({ packageRoot, sourceRoot, payloadVersion, payloadSha256, payloadDirectory }) {
  const extensionRoot = path.join(packageRoot, 'extension')
  const files = await sortedFiles(extensionRoot)
  const fileHashes = Object.fromEntries(await Promise.all(files.map(async (relative) => [relative, sha256(await readFile(path.join(extensionRoot, relative)))])))
  const shellFiles = files.filter((relative) => !relative.startsWith('payloads/') && relative !== 'current.json')
  const shellHash = await hashTree(extensionRoot, shellFiles)
  const identity = await verifyIdentity(sourceRoot)
  return {
    schemaVersion: 1,
    extension: {
      extensionId: identity.extensionId,
      publicKeySha256: identity.publicKeySha256,
      minimumChromeVersion: '125',
      shellAbi: 1,
      shellSha256: shellHash,
      payloadVersion,
      payloadSha256,
      payloadDirectory,
      fileHashes,
      treeSha256: await hashTree(extensionRoot, files),
    },
    nativeProtocol: { min: 1, max: 1, maxMessageBytes: 1048576 },
    capabilities: {
      desktopIntegration: false,
      resize: false,
      recording: false,
      downloadArtifacts: false,
      downloadOpen: false,
      testSideLoadOnly: true,
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packageRoot = path.resolve(process.argv[2] ?? 'dist')
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const selector = JSON.parse(await readFile(path.join(packageRoot, 'extension/current.json'), 'utf8'))
  const manifest = await createPackageManifest({
    packageRoot,
    sourceRoot,
    payloadVersion: selector.payloadVersion,
    payloadSha256: selector.payloadSha256,
    payloadDirectory: selector.payloadDirectory,
  })
  await writeFile(path.join(packageRoot, 'package-manifest.json'), stableJson(manifest))
}
