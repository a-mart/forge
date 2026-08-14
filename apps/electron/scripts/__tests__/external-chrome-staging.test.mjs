import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageExternalChromeResources } from '../stage-external-chrome.mjs'
import { verifyPackagedExternalChromeResources } from '../external-chrome-package-content-smoke.mjs'
import { restorePreSignedWindowsResources } from '../electron-builder-external-chrome.mjs'
import { ExternalChromeDeployer } from '../../src/external-chrome/deployer.js'

const roots = []
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const treeHash = (files) => {
  const digest = createHash('sha256')
  for (const [file, bytes] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    digest.update(`${file}\0${bytes.byteLength}\0`).update(bytes)
  }
  return digest.digest('hex')
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'external-stage-'))
  roots.push(root)
  const extensionPackageRoot = path.join(root, 'extension-dist')
  const extension = path.join(extensionPackageRoot, 'extension')
  const publicKey = (await readFile(new URL('../../../chrome-extension/identity/production-public-key.b64', import.meta.url), 'utf8')).trim()
  const shell = Buffer.from(`${JSON.stringify({ manifest_version: 3, key: publicKey })}\n`)
  const payloadContents = {
    'content-script.js': Buffer.from('content payload'),
    'service-worker.js': Buffer.from('service worker payload'),
  }
  const payloadFiles = Object.fromEntries(Object.entries(payloadContents).map(([file, bytes]) => [file, hash(bytes)]))
  const payloadSha = createHash('sha256')
  for (const [file, bytes] of Object.entries(payloadContents)) payloadSha.update(`${file}\0${bytes.byteLength}\0`).update(bytes)
  const payloadSha256 = payloadSha.digest('hex')
  const payloadDirectory = `1.0.0-${payloadSha256}`
  await mkdir(path.join(extension, 'shell'), { recursive: true })
  await mkdir(path.join(extension, 'payloads', payloadDirectory), { recursive: true })
  await writeFile(path.join(extension, 'manifest.json'), shell)
  await Promise.all(Object.entries(payloadContents).map(([file, bytes]) => writeFile(path.join(extension, 'payloads', payloadDirectory, file), bytes)))
  await writeFile(path.join(extension, 'current.json'), JSON.stringify({
    schemaVersion: 1, shellAbi: 1, payloadVersion: '1.0.0', payloadSha256, payloadDirectory, payloadFiles,
  }))
  await writeFile(path.join(extensionPackageRoot, 'package-manifest.json'), JSON.stringify({
    extension: {
      extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', publicKeySha256: '522752d0309e495182b876bac125709358fd32fd1d105bcd5fce42966eb25b93',
      minimumChromeVersion: '125', shellAbi: 1, shellSha256: treeHash({ 'manifest.json': shell }), payloadVersion: '1.0.0', payloadSha256, payloadDirectory,
      shellFiles: { 'manifest.json': hash(shell) }, payloadFiles,
      fileHashes: {
        'manifest.json': hash(shell),
        ...Object.fromEntries(Object.entries(payloadFiles).map(([file, digest]) => [`payloads/${payloadDirectory}/${file}`, digest])),
        'current.json': hash(Buffer.from('ignored')),
      },
    },
    nativeProtocol: { min: 1, max: 1, maxMessageBytes: 1048576 },
  }))
  const nativePackageRoot = path.join(root, 'native', 'dist')
  const executable = process.platform === 'win32' ? 'host.exe' : 'host'
  const native = Buffer.from('native')
  await mkdir(nativePackageRoot, { recursive: true })
  await writeFile(path.join(nativePackageRoot, executable), native)
  await writeFile(path.join(nativePackageRoot, 'package-manifest.json'), JSON.stringify({
    version: '1.0.0', nativeProtocol: { min: 1, max: 1, maxMessageBytes: 1048576 },
    platform: process.platform, architecture: process.arch,
    executable: {
      file: `dist/${executable}`, sha256: hash(native),
      signature: { scheme: process.platform === 'darwin' ? 'developer-id' : process.platform === 'win32' ? 'authenticode' : 'packaged-resource-hash', mode: 'validation', verified: false, signer: null, teamId: null },
    },
  }))
  const electronManifestPath = path.join(root, 'electron-package.json')
  await writeFile(electronManifestPath, JSON.stringify({ version: '0.23.0' }))
  return { root, extensionPackageRoot, nativePackageRoot, electronManifestPath }
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('External Chrome packaged staging', () => {
  it('is deterministic and passes complete platform inventory smoke', async () => {
    const input = await fixture()
    const outputRoot = path.join(input.root, 'output')
    const options = { ...input, outputRoot, buildMode: 'validation', verifyExecutable: async () => undefined }
    const first = await stageExternalChromeResources(options)
    const firstBytes = await readFile(path.join(outputRoot, 'package-manifest.json'))
    const second = await stageExternalChromeResources(options)
    const secondBytes = await readFile(path.join(outputRoot, 'package-manifest.json'))
    expect(first.sha256).toBe(second.sha256)
    expect(firstBytes).toEqual(secondBytes)
    expect(first.manifest.nativeHost).toMatchObject({ platform: process.platform, architecture: process.arch, required: true })
    expect(first.manifest.compatibility.desktop).toEqual({ min: '0.23.0', max: '0.23.999' })
    const workerPath = path.join(outputRoot, 'payload', first.manifest.extension.payloadDirectory, 'service-worker.js')
    expect(hash(await readFile(workerPath))).toBe(first.manifest.extension.payloadFiles['service-worker.js'])
    execFileSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'external-chrome-package-content-smoke.mjs'), outputRoot], {
      env: { ...process.env, FORGE_EXTERNAL_CHROME_BUILD_MODE: 'validation' },
    })

    const deployableManifest = JSON.parse(await readFile(path.join(outputRoot, 'package-manifest.json'), 'utf8'))
    deployableManifest.nativeHost.signature = {
      scheme: process.platform === 'darwin' ? 'developer-id' : process.platform === 'win32' ? 'authenticode' : 'packaged-resource-hash',
      mode: 'release', verified: true,
      signer: process.platform === 'darwin' ? 'Developer ID Application: Fixture (TEAM123456)' : process.platform === 'win32' ? 'CN=Forge Fixture' : null,
      teamId: process.platform === 'darwin' ? 'TEAM123456' : null,
    }
    await writeFile(path.join(outputRoot, 'package-manifest.json'), JSON.stringify(deployableManifest))
    const deployer = new ExternalChromeDeployer({
      dataRoot: path.join(input.root, 'forge-data'), resourcesRoot: outputRoot,
      desktopVersion: '0.23.0', platform: process.platform, architecture: process.arch,
    })
    await deployer.deploy()
    expect(await deployer.verifyDeployment()).toMatchObject({ state: 'ready' })
    await expect(new ExternalChromeDeployer({
      dataRoot: path.join(input.root, 'forge-data-old'), resourcesRoot: outputRoot,
      desktopVersion: '0.22.9', platform: process.platform, architecture: process.arch,
    }).deploy()).rejects.toThrow('incompatible with Desktop 0.22.9')
    await expect(new ExternalChromeDeployer({
      dataRoot: path.join(input.root, 'forge-data-next'), resourcesRoot: outputRoot,
      desktopVersion: '0.24.0', platform: process.platform, architecture: process.arch,
    }).deploy()).rejects.toThrow('incompatible with Desktop 0.24.0')
    const selector = JSON.parse(await readFile(path.join(deployer.paths.extension, 'current.json'), 'utf8'))
    const deployedWorker = path.join(deployer.paths.extension, 'payloads', selector.payloadDirectory, 'service-worker.js')
    expect(hash(await readFile(deployedWorker))).toBe(selector.payloadFiles['service-worker.js'])
  })

  it('stages explicit unsigned Windows release metadata while retaining post-package SHA-256 tamper detection', async () => {
    const input = await fixture()
    const native = Buffer.from('unsigned Windows native')
    const executable = 'host.exe'
    await writeFile(path.join(input.nativePackageRoot, executable), native)
    await writeFile(path.join(input.nativePackageRoot, 'package-manifest.json'), JSON.stringify({
      version: '1.0.0', nativeProtocol: { min: 1, max: 1, maxMessageBytes: 1048576 },
      platform: 'win32', architecture: 'x64',
      executable: {
        file: `dist/${executable}`, sha256: hash(native),
        signature: { scheme: 'unsigned', mode: 'release', verified: false, signer: null, teamId: null },
      },
    }))
    const outputRoot = path.join(input.root, 'windows-output')
    await stageExternalChromeResources({
      ...input, outputRoot, platform: 'win32', architecture: 'x64', buildMode: 'release', verifyExecutable: async () => undefined,
    })
    await expect(verifyPackagedExternalChromeResources({ root: outputRoot, platform: 'win32', architecture: 'x64' }))
      .resolves.toMatchObject({ nativeHost: { signature: { scheme: 'unsigned', mode: 'release', verified: false } } })

    await writeFile(path.join(outputRoot, 'native-host', 'win32-x64', executable), 'tampered')
    await expect(verifyPackagedExternalChromeResources({ root: outputRoot, platform: 'win32', architecture: 'x64' }))
      .rejects.toThrow('hash mismatch')
  })

  it('fails post-package smoke on mutation and restores the manifest-hashed Windows resource tree', async () => {
    const input = await fixture()
    const outputRoot = path.join(input.root, 'output')
    await stageExternalChromeResources({ ...input, outputRoot, buildMode: 'validation', verifyExecutable: async () => undefined })
    const manifest = JSON.parse(await readFile(path.join(outputRoot, 'package-manifest.json'), 'utf8'))
    const executable = path.join(outputRoot, 'native-host', `${process.platform}-${process.arch}`, manifest.nativeHost.executable)
    await writeFile(executable, 'electron-builder mutated fixture')
    const smokeOptions = {
      platform: process.platform, architecture: process.arch, allowValidation: true,
      verifySignature: async () => undefined,
    }
    await expect(verifyPackagedExternalChromeResources({ root: outputRoot, ...smokeOptions })).rejects.toThrow('hash mismatch')

    // Use a fresh deterministic stage as the pristine afterPack source fixture.
    const pristineRoot = path.join(input.root, 'pristine')
    await stageExternalChromeResources({ ...input, outputRoot: pristineRoot, buildMode: 'validation', verifyExecutable: async () => undefined })
    await restorePreSignedWindowsResources({ sourceRoot: pristineRoot, packagedRoot: outputRoot })
    await expect(verifyPackagedExternalChromeResources({ root: outputRoot, ...smokeOptions })).resolves.toMatchObject({ schemaVersion: 1 })
  })

  it('fails release staging when the required SEA executable is absent', async () => {
    const input = await fixture()
    await writeFile(path.join(input.nativePackageRoot, 'package-manifest.json'), JSON.stringify({
      platform: process.platform, architecture: process.arch,
      sea: { status: 'unsupported-toolchain', reason: 'NODE_SEA_FUSE is absent' },
    }))
    await expect(stageExternalChromeResources({ ...input, outputRoot: path.join(input.root, 'output'), buildMode: 'validation', verifyExecutable: async () => undefined }))
      .rejects.toThrow('requires a SEA executable')
    await expect(stageExternalChromeResources({ ...input, outputRoot: path.join(input.root, 'output'), requireExecutable: false, buildMode: 'validation', verifyExecutable: async () => undefined }))
      .resolves.toMatchObject({ staged: false, reason: 'NODE_SEA_FUSE is absent' })
  })
})
