import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertReleaseEnvironment,
  assertSeaToolchain,
  macReleaseEntitlementsPath,
  prepareExecutableForInitialSmoke,
  prepareReleaseExecutable,
  verifyReleaseSignature,
} from '../../../native-messaging-host/scripts/release-signing.mjs'
import {
  inspectSeaBuildCapability,
  prepareAndSmokeExecutable,
} from '../../../native-messaging-host/scripts/package-current.mjs'

const roots = []

async function executableFixture(name = 'host') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'external-sign-'))
  roots.push(root)
  const executable = path.join(root, name)
  await writeFile(executable, 'synthetic executable fixture')
  return { root, executable }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('External Chrome release signing policy', () => {
  it('fails release credential gates closed while validation remains credential-free', async () => {
    await expect(assertReleaseEnvironment({ platform: 'darwin', env: { FORGE_EXTERNAL_CHROME_BUILD_MODE: 'release' } }))
      .rejects.toThrow('FORGE_SEA_NODE')
    await expect(assertReleaseEnvironment({ platform: 'win32', env: { FORGE_EXTERNAL_CHROME_BUILD_MODE: 'validation' } }))
      .resolves.toMatchObject({ mode: 'validation' })
  })

  it('accepts repository Node 24 validation only after the direct SEA capability probe succeeds', () => {
    expect(() => assertSeaToolchain({
      nodeVersion: '24.18.0', execPath: 'C:\\Program Files\\nodejs\\node.exe',
      env: { FORGE_EXTERNAL_CHROME_BUILD_MODE: 'validation' },
    })).not.toThrow()
    expect(inspectSeaBuildCapability({ status: 0 }, { nodeVersion: '24.18.0' }))
      .toEqual({ supported: true })
    expect(inspectSeaBuildCapability({
      status: 1,
      stderr: 'Error: NODE_SEA_FUSE is absent',
      stdout: '',
    }, { nodeVersion: '24.18.0' })).toEqual({
      supported: false,
      reason: 'Node 24.18.0 executable lacks the NODE_SEA_FUSE sentinel required by --build-sea',
    })
  })

  it('pins release SEA packaging to the declared official Node executable and version', () => {
    expect(() => assertSeaToolchain({
      nodeVersion: '25.5.0', execPath: '/official/node',
      env: { FORGE_EXTERNAL_CHROME_BUILD_MODE: 'release', FORGE_SEA_NODE: '/official/node' },
    })).toThrow('official Node 25.6.1')
    expect(() => assertSeaToolchain({
      nodeVersion: '25.6.1', execPath: '/other/node',
      env: { FORGE_EXTERNAL_CHROME_BUILD_MODE: 'release', FORGE_SEA_NODE: '/official/node' },
    })).toThrow('must run with FORGE_SEA_NODE')
  })

  it('ad-hoc signs macOS SEA output before its first validation smoke', async () => {
    const { executable } = await executableFixture()
    const events = []
    const runCommand = vi.fn(async (_command, args) => {
      events.push(args.includes('--sign') ? `sign:${args[args.indexOf('--sign') + 1]}` : 'verify')
      return { stdout: '', stderr: '' }
    })
    const prepareRelease = vi.fn(async () => {
      events.push('prepare-release')
      return { scheme: 'developer-id', mode: 'validation', verified: false, signer: null, teamId: null }
    })
    const smokeExecutable = vi.fn(() => events.push('smoke'))

    const signature = await prepareAndSmokeExecutable(executable, ['chrome-extension://fixture/'], {
      platform: 'darwin', runCommand, prepareRelease, smokeExecutable,
    })

    expect(events).toEqual(['sign:-', 'verify', 'smoke', 'prepare-release', 'smoke'])
    expect(runCommand.mock.calls[0]).toEqual([
      '/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', macReleaseEntitlementsPath, executable],
    ])
    expect(signature).toMatchObject({ mode: 'validation', verified: false })
  })

  it('does not alter non-macOS SEA output before the first smoke', async () => {
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await prepareExecutableForInitialSmoke('host.exe', { platform: 'win32', runCommand })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('signs macOS before staging and verifies the exact Developer ID identity and team', async () => {
    const { executable } = await executableFixture()
    const identity = 'Developer ID Application: Forge Fixture (TEAM123456)'
    const runCommand = vi.fn(async (_command, args) => {
      if (args.includes('--display')) return { stdout: '', stderr: `Authority=${identity}\nTeamIdentifier=TEAM123456\n` }
      return { stdout: '', stderr: '' }
    })
    const signature = await prepareReleaseExecutable(executable, {
      platform: 'darwin', runCommand,
      env: {
        FORGE_EXTERNAL_CHROME_BUILD_MODE: 'release', FORGE_SEA_NODE: process.execPath,
        APPLE_ID: 'fixture@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'synthetic',
        APPLE_TEAM_ID: 'TEAM123456', FORGE_MACOS_SIGNING_IDENTITY: identity,
      },
    })
    expect(signature).toEqual({ scheme: 'developer-id', mode: 'release', verified: true, signer: identity, teamId: 'TEAM123456' })
    expect(runCommand.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--sign', identity, '--entitlements', macReleaseEntitlementsPath,
    ]))
  })

  it('rejects a structurally valid macOS signature from the wrong team', async () => {
    const { executable } = await executableFixture()
    const identity = 'Developer ID Application: Forge Fixture (TEAM123456)'
    const runCommand = vi.fn(async (_command, args) => args.includes('--display')
      ? { stdout: '', stderr: `Authority=${identity}\nTeamIdentifier=OTHERTEAM00\n` }
      : { stdout: '', stderr: '' })
    await expect(prepareReleaseExecutable(executable, {
      platform: 'darwin', runCommand,
      env: {
        FORGE_EXTERNAL_CHROME_BUILD_MODE: 'release', FORGE_SEA_NODE: process.execPath,
        APPLE_ID: 'fixture@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'synthetic',
        APPLE_TEAM_ID: 'TEAM123456', FORGE_MACOS_SIGNING_IDENTITY: identity,
      },
    })).rejects.toThrow('team mismatch')
  })

  it('Authenticode-signs Windows before hashing and verifies the expected signer subject', async () => {
    const { root, executable } = await executableFixture('host.exe')
    const certificate = path.join(root, 'fixture.pfx')
    await writeFile(certificate, 'synthetic certificate fixture')
    const signWindows = vi.fn(async () => undefined)
    const runCommand = vi.fn(async () => ({
      stdout: JSON.stringify({ Status: 'Valid', Subject: 'CN=Forge Fixture', Thumbprint: '00AA' }), stderr: '',
    }))
    const signature = await prepareReleaseExecutable(executable, {
      platform: 'win32', runCommand, signWindows,
      env: {
        FORGE_EXTERNAL_CHROME_BUILD_MODE: 'release', FORGE_SEA_NODE: process.execPath,
        WIN_CSC_LINK: certificate, WIN_CSC_KEY_PASSWORD: 'synthetic', FORGE_WINDOWS_SIGNER_SUBJECT: 'CN=Forge Fixture',
      },
    })
    expect(signWindows).toHaveBeenCalledOnce()
    expect(signature).toEqual({ scheme: 'authenticode', mode: 'release', verified: true, signer: 'CN=Forge Fixture', teamId: null })
  })

  it('marks validation hosts unusable for release but permits explicit validation smoke', async () => {
    const { executable } = await executableFixture()
    const signature = { scheme: 'developer-id', mode: 'validation', verified: false, signer: null, teamId: null }
    await expect(verifyReleaseSignature(executable, signature, { platform: 'darwin' }))
      .rejects.toThrow('not release signed')
    await expect(verifyReleaseSignature(executable, signature, { platform: 'darwin', allowValidation: true }))
      .resolves.toEqual(signature)
  })
})
