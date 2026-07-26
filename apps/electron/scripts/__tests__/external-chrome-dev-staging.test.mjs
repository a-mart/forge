import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalChromeDeployer } from '../../src/external-chrome/deployer.js'
import { prepareExternalChromeDevelopmentResources } from '../prepare-external-chrome-dev.mjs'

const roots = []
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const treeHash = (files) => {
  const hash = createHash('sha256')
  for (const relative of Object.keys(files).sort()) {
    const bytes = files[relative]
    hash.update(`${relative}\0${bytes.byteLength}\0`).update(bytes)
  }
  return hash.digest('hex')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('External Chrome development resource staging', () => {
  it('creates a deterministic opt-in Node host alongside complete extension inventories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-external-chrome-dev-stage-'))
    roots.push(root)
    const extensionRoot = path.join(root, 'extension')
    const publicKey = (await readFile(new URL('../../../chrome-extension/identity/production-public-key.b64', import.meta.url), 'utf8')).trim()
    const shell = Buffer.from(`${JSON.stringify({ manifest_version: 3, key: publicKey })}\n`)
    const payload = Buffer.from('payload\n')
    const payloadDirectory = `dev-${treeHash({ 'worker.js': payload })}`
    await mkdir(path.join(extensionRoot, 'payloads', payloadDirectory), { recursive: true })
    await writeFile(path.join(extensionRoot, 'manifest.json'), shell)
    await writeFile(path.join(extensionRoot, 'payloads', payloadDirectory, 'worker.js'), payload)
    await writeFile(path.join(extensionRoot, 'current.json'), JSON.stringify({
      schemaVersion: 1, shellAbi: 1, payloadVersion: 'dev', payloadSha256: treeHash({ 'worker.js': payload }), payloadDirectory,
    }))
    const extensionManifestPath = path.join(root, 'extension-package.json')
    await writeFile(extensionManifestPath, JSON.stringify({
      extension: {
        extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd',
        publicKeySha256: '522752d0309e495182b876bac125709358fd32fd1d105bcd5fce42966eb25b93',
        minimumChromeVersion: '125', shellAbi: 1,
        shellSha256: treeHash({ 'manifest.json': shell }), payloadVersion: 'dev',
        payloadSha256: treeHash({ 'worker.js': payload }),
        fileHashes: {
          'manifest.json': sha256(shell),
          [`payloads/${payloadDirectory}/worker.js`]: sha256(payload),
          'current.json': sha256(Buffer.from('ignored')),
        },
      },
      nativeProtocol: { min: 1, max: 1, maxMessageBytes: 1_048_576 },
    }))
    const nativeBundlePath = path.join(root, 'host.cjs')
    await writeFile(nativeBundlePath, 'process.exitCode = 1\n')
    const electronManifestPath = path.join(root, 'electron-package.json')
    await writeFile(electronManifestPath, JSON.stringify({ version: '0.22.5' }))
    const smoke = vi.fn().mockResolvedValue(undefined)
    const outputRoot = path.join(root, 'prepared')

    const result = await prepareExternalChromeDevelopmentResources({
      outputRoot, extensionRoot, extensionManifestPath, nativeBundlePath, electronManifestPath,
      nodeExecutable: '/usr/bin/node', platform: 'darwin', architecture: 'arm64', smoke,
    })

    const executable = path.join(outputRoot, 'native-host', 'darwin-arm64', 'forge-external-chrome-native-host')
    expect((await readFile(executable, 'utf8')).startsWith('#!/usr/bin/node\n')).toBe(true)
    expect(smoke).toHaveBeenCalledWith(
      path.join(`${outputRoot}.tmp`, 'native-host', 'darwin-arm64', 'forge-external-chrome-native-host'),
      'chrome-extension://fcchfcnadajoejfbiclihglkmbcfhajd/',
    )
    expect(result.manifest.nativeHost.signature).toEqual({
      scheme: 'node-shebang', mode: 'development', verified: false, signer: null, teamId: null,
    })
    expect(JSON.parse(await readFile(path.join(outputRoot, 'package-manifest.json'), 'utf8'))).toEqual(result.manifest)

    const dataRoot = path.join(root, 'forge-data')
    await expect(new ExternalChromeDeployer({
      dataRoot, resourcesRoot: outputRoot, desktopVersion: '0.22.5', platform: 'darwin', architecture: 'arm64',
    }).deploy()).rejects.toThrow('not release-verified')
    const deployer = new ExternalChromeDeployer({
      dataRoot, resourcesRoot: outputRoot, desktopVersion: '0.22.5', platform: 'darwin', architecture: 'arm64',
      allowDevelopmentHost: true,
    })
    await deployer.deploy()
    expect(await deployer.verifyDeployment()).toMatchObject({ state: 'ready' })
    expect(deployer.paths.extension).toBe(path.join(dataRoot, 'integrations', 'external-chrome', 'extension'))
  })

  it('fails closed on Windows rather than producing an unusable Chrome launcher', async () => {
    await expect(prepareExternalChromeDevelopmentResources({ platform: 'win32' }))
      .rejects.toThrow('Windows dev host preparation is unsupported')
  })
})
