import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalChromeDeployer } from '../../src/external-chrome/deployer.js'
import { packageWindowsDevelopmentHost, prepareExternalChromeDevelopmentResources } from '../prepare-external-chrome-dev.mjs'

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

async function developmentInputs(root) {
  const extensionPackageRoot = path.join(root, 'extension-dist')
  const extensionRoot = path.join(extensionPackageRoot, 'extension')
  const publicKey = (await readFile(new URL('../../../chrome-extension/identity/production-public-key.b64', import.meta.url), 'utf8')).trim()
  const shell = Buffer.from(`${JSON.stringify({ manifest_version: 3, key: publicKey })}\n`)
  const payloadContents = {
    'content-script.js': Buffer.from('content payload\n'),
    'service-worker.js': Buffer.from('service worker payload\n'),
  }
  const payloadSha256 = treeHash(payloadContents)
  const payloadDirectory = `dev-${payloadSha256}`
  const payloadFiles = Object.fromEntries(Object.entries(payloadContents).map(([file, bytes]) => [file, sha256(bytes)]))
  await mkdir(path.join(extensionRoot, 'payloads', payloadDirectory), { recursive: true })
  await writeFile(path.join(extensionRoot, 'manifest.json'), shell)
  await Promise.all(Object.entries(payloadContents).map(([file, bytes]) => writeFile(path.join(extensionRoot, 'payloads', payloadDirectory, file), bytes)))
  await writeFile(path.join(extensionRoot, 'current.json'), JSON.stringify({
    schemaVersion: 1, shellAbi: 1, payloadVersion: 'dev', payloadSha256, payloadDirectory, payloadFiles,
  }))
  const extensionManifestPath = path.join(extensionPackageRoot, 'package-manifest.json')
  await writeFile(extensionManifestPath, JSON.stringify({
    extension: {
      extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd',
      publicKeySha256: '522752d0309e495182b876bac125709358fd32fd1d105bcd5fce42966eb25b93',
      minimumChromeVersion: '125', shellAbi: 1,
      shellSha256: treeHash({ 'manifest.json': shell }), payloadVersion: 'dev',
      payloadSha256, payloadDirectory,
      shellFiles: { 'manifest.json': sha256(shell) }, payloadFiles,
      fileHashes: {
        'manifest.json': sha256(shell),
        ...Object.fromEntries(Object.entries(payloadFiles).map(([file, digest]) => [`payloads/${payloadDirectory}/${file}`, digest])),
        'current.json': sha256(Buffer.from('ignored')),
      },
    },
    nativeProtocol: { min: 1, max: 1, maxMessageBytes: 1_048_576 },
  }))
  const nativePackageRoot = path.join(root, 'native', 'dist')
  await mkdir(nativePackageRoot, { recursive: true })
  const nativeBundlePath = path.join(nativePackageRoot, 'host.cjs')
  await writeFile(nativeBundlePath, 'process.exitCode = 1\n')
  const electronManifestPath = path.join(root, 'electron-package.json')
  await writeFile(electronManifestPath, JSON.stringify({ version: '0.22.5' }))
  return {
    extensionPackageRoot, extensionRoot, extensionManifestPath, nativePackageRoot, nativeBundlePath,
    seaConfigPath: path.join(nativePackageRoot, '..', 'sea-config.json'), electronManifestPath, payloadContents,
  }
}

async function validationSeaInput(input, platform = 'win32', architecture = 'x64') {
  const executable = 'forge-external-chrome-native-host.exe'
  const executablePath = path.join(input.nativePackageRoot, executable)
  const executableBytes = Buffer.from('validation sea executable')
  const seaConfig = Buffer.from(`{"main":"host.cjs","output":"dist/${executable}"}\n`)
  await writeFile(executablePath, executableBytes)
  await writeFile(path.join(input.nativePackageRoot, '..', 'sea-config.json'), JSON.stringify({ main: 'host.cjs', output: 'dist/ignored.exe' }))
  await writeFile(path.join(input.nativePackageRoot, 'sea-config.current.json'), seaConfig)
  await writeFile(path.join(input.nativePackageRoot, 'package-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    package: '@forge/external-chrome-native-host',
    version: '1.0.0',
    nativeProtocol: { min: 1, max: 1, maxMessageBytes: 1_048_576 },
    platform,
    architecture,
    executable: {
      file: `dist/${executable}`,
      sha256: sha256(executableBytes),
      signature: { scheme: 'authenticode', mode: 'validation', verified: false, signer: null, teamId: null },
    },
    bundle: { file: 'dist/host.cjs', sha256: sha256(await readFile(input.nativeBundlePath)) },
    seaConfig: { file: 'dist/sea-config.current.json', sha256: sha256(seaConfig) },
    smoke: 'desktop-unavailable',
  }))
  return { executable, executablePath }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('External Chrome development resource staging', () => {
  it('creates a deterministic opt-in Node host alongside complete extension inventories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-external-chrome-dev-stage-'))
    roots.push(root)
    const input = await developmentInputs(root)
    const smoke = vi.fn().mockResolvedValue(undefined)
    const outputRoot = path.join(root, 'prepared')

    const result = await prepareExternalChromeDevelopmentResources({
      outputRoot, ...input, nodeExecutable: '/usr/bin/node', platform: 'darwin', architecture: 'arm64', smoke,
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
    const deployedSelector = JSON.parse(await readFile(path.join(deployer.paths.extension, 'current.json'), 'utf8'))
    const workerPath = path.join(deployer.paths.extension, 'payloads', deployedSelector.payloadDirectory, 'service-worker.js')
    expect(await readFile(workerPath)).toEqual(input.payloadContents['service-worker.js'])
    expect(sha256(await readFile(workerPath))).toBe(deployedSelector.payloadFiles['service-worker.js'])
  })

  it('stages, reuses, and labels a Windows validation SEA instead of silently skipping External Chrome', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-external-chrome-dev-windows-'))
    roots.push(root)
    const input = await developmentInputs(root)
    const { executable, executablePath } = await validationSeaInput(input)
    const outputRoot = path.join(root, 'prepared')
    const packageWindowsNativeHost = vi.fn().mockResolvedValue(undefined)
    const verifyExecutable = vi.fn().mockResolvedValue(undefined)

    const result = await prepareExternalChromeDevelopmentResources({
      outputRoot, ...input, platform: 'win32', architecture: 'x64', packageWindowsNativeHost, verifyExecutable,
    })

    expect(packageWindowsNativeHost).toHaveBeenCalledOnce()
    expect(verifyExecutable).toHaveBeenCalledWith(
      executablePath, 'win32',
      { scheme: 'authenticode', mode: 'validation', verified: false, signer: null, teamId: null },
      { allowValidation: true },
    )
    expect(result.manifest.nativeHost).toMatchObject({
      executable,
      platform: 'win32',
      architecture: 'x64',
      signature: { scheme: 'authenticode', mode: 'validation', verified: false },
      development: {
        source: 'validation-sea',
        package: '@forge/external-chrome-native-host',
        bundleSha256: sha256(await readFile(input.nativeBundlePath)),
      },
    })
    expect(await readFile(path.join(outputRoot, 'native-host', 'win32-x64', executable))).toEqual(await readFile(executablePath))
    const deployer = new ExternalChromeDeployer({
      dataRoot: path.join(root, 'forge-data'), resourcesRoot: outputRoot, desktopVersion: '0.22.5',
      platform: 'win32', architecture: 'x64', allowDevelopmentHost: true,
    })
    await deployer.deploy()
    expect(await deployer.verifyDeployment()).toMatchObject({ state: 'ready' })
    expect(deployer.paths.nativeHostExecutable).toMatch(/forge-external-chrome-native-host\.exe$/u)

    const packageCachedHost = vi.fn().mockRejectedValue(new Error('must not package unchanged SEA'))
    await expect(prepareExternalChromeDevelopmentResources({
      outputRoot, ...input, platform: 'win32', architecture: 'x64', packageWindowsNativeHost: packageCachedHost,
    })).resolves.toEqual(result)
    expect(packageCachedHost).not.toHaveBeenCalled()
  })

  it('executes a spaced Windows Node path directly while forcing validation mode', async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined)
    await packageWindowsDevelopmentHost({ executable: 'C:\\Program Files\\nodejs\\node.exe', runCommand })
    expect(runCommand).toHaveBeenCalledWith(
      'C:\\Program Files\\nodejs\\node.exe',
      [expect.stringMatching(/apps[\\/]native-messaging-host[\\/]scripts[\\/]package-current\.mjs$/u)],
      expect.stringMatching(/apps[\\/]native-messaging-host$/u),
      expect.objectContaining({ FORGE_EXTERNAL_CHROME_BUILD_MODE: 'validation' }),
      false,
    )
  })

  it('makes a missing Windows SEA toolchain actionable instead of removing the optional adapter', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-external-chrome-dev-windows-failure-'))
    roots.push(root)
    await expect(prepareExternalChromeDevelopmentResources({
      outputRoot: path.join(root, 'prepared'),
      platform: 'win32',
      packageWindowsNativeHost: async () => { throw new Error('SEA build failed') },
    })).rejects.toThrow('official Node 25.6.1 executable with SEA support')
  })
})
