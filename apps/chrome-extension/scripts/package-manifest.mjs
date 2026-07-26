import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashTree, sha256, sortedFiles, stableJson } from './deterministic.mjs'
import { verifyIdentity } from './verify-identity.mjs'

export async function createPackageManifest({ packageRoot, sourceRoot, payloadVersion, payloadSha256, payloadDirectory }) {
  const extensionRoot = path.join(packageRoot, 'extension')
  const files = await sortedFiles(extensionRoot)
  const fileHashes = Object.fromEntries(await Promise.all(files.map(async (relative) => [relative, sha256(await readFile(path.join(extensionRoot, relative)))])))
  const payloadPrefix = `payloads/${payloadDirectory}/`
  const shellFileNames = files.filter((relative) => !relative.startsWith('payloads/') && relative !== 'current.json')
  const payloadFileNames = files.filter((relative) => relative.startsWith(payloadPrefix))
  const unexpectedPayloadFiles = files.filter((relative) => relative.startsWith('payloads/') && !relative.startsWith(payloadPrefix))
  const shellFiles = Object.fromEntries(shellFileNames.map((relative) => [relative, fileHashes[relative]]))
  const payloadFiles = Object.fromEntries(payloadFileNames.map((relative) => [relative.slice(payloadPrefix.length), fileHashes[relative]]))
  const expectedPayloadFiles = ['content-script.js', 'service-worker.js', 'side-panel.js']
  if (unexpectedPayloadFiles.length > 0 || Object.keys(payloadFiles).sort().join('\0') !== expectedPayloadFiles.join('\0')) {
    throw new Error('extension payload inventory does not match the shell ABI')
  }
  const selector = JSON.parse(await readFile(path.join(extensionRoot, 'current.json'), 'utf8'))
  if (
    selector.payloadVersion !== payloadVersion || selector.payloadSha256 !== payloadSha256 || selector.payloadDirectory !== payloadDirectory
    || stableJson(selector.payloadFiles) !== stableJson(payloadFiles)
  ) throw new Error('extension selector and package payload inventory disagree')
  const shellHash = await hashTree(extensionRoot, shellFileNames)
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
      shellFiles,
      payloadFiles,
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
