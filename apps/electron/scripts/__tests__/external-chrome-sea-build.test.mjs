import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSeaExecutable } from '../../../native-messaging-host/scripts/package-current.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'forge-sea-build-'))
  roots.push(cwd)
  await mkdir(path.join(cwd, 'Program Files'))
  await mkdir(path.join(cwd, 'dist'))
  const nodeExecutable = path.join(cwd, 'Program Files', 'node.exe')
  await writeFile(nodeExecutable, 'synthetic Node executable')
  const currentConfigPath = path.join(cwd, 'dist', 'sea-config.current.json')
  const seaConfig = {
    main: 'dist/host.cjs', output: 'dist/host.exe',
    disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false,
  }
  await writeFile(currentConfigPath, JSON.stringify(seaConfig))
  return {
    cwd, nodeExecutable, currentConfigPath, seaConfig,
    executablePath: path.join(cwd, 'dist', 'host.exe'), platform: 'win32', mode: 'validation',
  }
}

const unsupportedDirectBuild = { status: 9, stderr: 'node.exe: bad option: --build-sea=C:\\repo\\dist\\sea-config.current.json' }

describe('Windows validation SEA build capabilities', () => {
  it.each(['22.19.0', '24.19.0'])('uses experimental blob injection for supported Node %s lacking --build-sea', async () => {
    const input = await fixture()
    const canonicalConfig = await readFile(input.currentConfigPath)
    const blobPath = path.join(input.cwd, 'dist', 'sea-prep.blob')
    // Simulate the experimental-config subprocess output without claiming Windows execution.
    await writeFile(blobPath, 'synthetic SEA blob')
    const run = vi.fn().mockReturnValueOnce(unsupportedDirectBuild).mockReturnValueOnce({ status: 0 })
    const inject = vi.fn().mockResolvedValue(undefined)
    await expect(buildSeaExecutable({ ...input, run, inject })).resolves.toEqual({ status: 0 })
    expect(run.mock.calls).toEqual([
      [input.nodeExecutable, [`--build-sea=${input.currentConfigPath}`], { cwd: input.cwd, encoding: 'utf8' }],
      [input.nodeExecutable, ['--experimental-sea-config', path.join(input.cwd, 'dist', 'sea-config.blob.json')], { cwd: input.cwd, encoding: 'utf8' }],
    ])
    expect(JSON.parse(await readFile(path.join(input.cwd, 'dist', 'sea-config.blob.json'), 'utf8')))
      .toEqual({ ...input.seaConfig, output: blobPath })
    expect(await readFile(input.currentConfigPath)).toEqual(canonicalConfig)
    expect(await readFile(input.executablePath)).toEqual(await readFile(input.nodeExecutable))
    expect(inject).toHaveBeenCalledWith(input.executablePath, 'NODE_SEA_BLOB', Buffer.from('synthetic SEA blob'), {
      sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    })
  })

  it('keeps newer direct-build Node on the existing path', async () => {
    const input = await fixture()
    const run = vi.fn().mockReturnValue({ status: 0 })
    const inject = vi.fn()
    await expect(buildSeaExecutable({ ...input, run, inject })).resolves.toEqual({ status: 0 })
    expect(run).toHaveBeenCalledOnce()
    expect(inject).not.toHaveBeenCalled()
  })

  it.each([
    { mode: 'release', platform: 'win32', result: unsupportedDirectBuild },
    { mode: 'validation', platform: 'darwin', result: unsupportedDirectBuild },
    { mode: 'validation', platform: 'win32', result: { status: 1, stderr: 'NODE_SEA_FUSE missing' } },
    { mode: 'validation', platform: 'win32', result: { status: 1, stderr: 'Permission denied' } },
    { mode: 'validation', platform: 'win32', result: { status: null, error: new Error('spawn failed') } },
  ])('does not broaden fallback for $mode $platform: $result', async ({ mode, platform, result }) => {
    const input = await fixture()
    const run = vi.fn().mockReturnValue(result)
    const inject = vi.fn()
    expect(await buildSeaExecutable({ ...input, mode, platform, run, inject })).toBe(result)
    expect(run).toHaveBeenCalledOnce()
    expect(inject).not.toHaveBeenCalled()
  })

  it('fails closed on blob generation errors', async () => {
    const input = await fixture()
    const run = vi.fn().mockReturnValueOnce(unsupportedDirectBuild).mockReturnValueOnce({ status: 1, stderr: 'invalid main' })
    const inject = vi.fn()
    await expect(buildSeaExecutable({ ...input, run, inject })).rejects.toThrow('SEA blob generation failed: invalid main')
    expect(inject).not.toHaveBeenCalled()
  })

  it('fails closed on injection errors, including missing sentinel', async () => {
    const input = await fixture()
    await writeFile(path.join(input.cwd, 'dist', 'sea-prep.blob'), 'synthetic SEA blob')
    const run = vi.fn().mockReturnValueOnce(unsupportedDirectBuild).mockReturnValueOnce({ status: 0 })
    const inject = vi.fn().mockRejectedValue(new Error('Could not find the sentinel NODE_SEA_FUSE'))
    await expect(buildSeaExecutable({ ...input, run, inject })).rejects.toThrow('Could not find the sentinel NODE_SEA_FUSE')
  })
})
