import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageExternalChromeResources } from '../stage-external-chrome.mjs'

const roots = []
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'external-stage-'))
  roots.push(root)
  const extensionPackageRoot = path.join(root, 'extension-dist')
  const extension = path.join(extensionPackageRoot, 'extension')
  const payloadSha = 'a'.repeat(64)
  const payloadDirectory = `1.0.0-${payloadSha}`
  const shell = Buffer.from('shell')
  const payload = Buffer.from('payload')
  await mkdir(path.join(extension, 'shell'), { recursive: true })
  await mkdir(path.join(extension, 'payloads', payloadDirectory), { recursive: true })
  await writeFile(path.join(extension, 'manifest.json'), shell)
  await writeFile(path.join(extension, 'payloads', payloadDirectory, 'worker.js'), payload)
  await writeFile(path.join(extension, 'current.json'), JSON.stringify({ payloadDirectory }))
  await writeFile(path.join(extensionPackageRoot, 'package-manifest.json'), JSON.stringify({
    extension: {
      extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', publicKeySha256: '522752d0309e495182b876bac125709358fd32fd1d105bcd5fce42966eb25b93',
      minimumChromeVersion: '125', shellAbi: 1, shellSha256: hash(shell), payloadVersion: '1.0.0', payloadSha256: payloadSha,
      fileHashes: { 'manifest.json': hash(shell), [`payloads/${payloadDirectory}/worker.js`]: hash(payload), 'current.json': hash(Buffer.from('ignored')) },
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
    executable: { file: `dist/${executable}`, sha256: hash(native) },
  }))
  const electronManifestPath = path.join(root, 'electron-package.json')
  await writeFile(electronManifestPath, JSON.stringify({ version: '0.22.0-beta.4' }))
  return { root, extensionPackageRoot, nativePackageRoot, electronManifestPath }
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('External Chrome packaged staging', () => {
  it('is deterministic and passes complete platform inventory smoke', async () => {
    const input = await fixture()
    const outputRoot = path.join(input.root, 'output')
    const options = { ...input, outputRoot, verifyExecutable: async () => undefined }
    const first = await stageExternalChromeResources(options)
    const firstBytes = await readFile(path.join(outputRoot, 'package-manifest.json'))
    const second = await stageExternalChromeResources(options)
    const secondBytes = await readFile(path.join(outputRoot, 'package-manifest.json'))
    expect(first.sha256).toBe(second.sha256)
    expect(firstBytes).toEqual(secondBytes)
    expect(first.manifest.nativeHost).toMatchObject({ platform: process.platform, architecture: process.arch, required: true })
    execFileSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'external-chrome-package-content-smoke.mjs'), outputRoot])
  })

  it('fails release staging when the required SEA executable is absent', async () => {
    const input = await fixture()
    await writeFile(path.join(input.nativePackageRoot, 'package-manifest.json'), JSON.stringify({
      platform: process.platform, architecture: process.arch,
      sea: { status: 'unsupported-toolchain', reason: 'NODE_SEA_FUSE is absent' },
    }))
    await expect(stageExternalChromeResources({ ...input, outputRoot: path.join(input.root, 'output'), verifyExecutable: async () => undefined }))
      .rejects.toThrow('requires a SEA executable')
    await expect(stageExternalChromeResources({ ...input, outputRoot: path.join(input.root, 'output'), requireExecutable: false, verifyExecutable: async () => undefined }))
      .resolves.toMatchObject({ staged: false, reason: 'NODE_SEA_FUSE is absent' })
  })
})
