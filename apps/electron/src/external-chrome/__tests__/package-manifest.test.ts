import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_CHROME_EXTENSION_ID,
  EXTERNAL_CHROME_PUBLIC_KEY_SHA256,
  parseExternalChromePackageManifest,
} from '../package-manifest.js'

const hash = createHash('sha256').update('fixture').digest('hex')

function developmentManifest() {
  return {
    schemaVersion: 1,
    packageVersion: '0.22.5',
    extension: {
      extensionId: EXTERNAL_CHROME_EXTENSION_ID,
      publicKeySha256: EXTERNAL_CHROME_PUBLIC_KEY_SHA256,
      minimumChromeVersion: '125', shellAbi: 1, shellSha256: hash,
      payloadVersion: 'dev', payloadSha256: hash, payloadDirectory: `dev-${hash}`,
      shellFiles: { 'manifest.json': hash },
      payloadFiles: { 'content-script.js': hash, 'service-worker.js': hash },
    },
    nativeHost: {
      protocol: { min: 1, max: 1, maxMessageBytes: 1_048_576 },
      version: 'development', platform: 'darwin', architecture: 'arm64',
      executable: 'forge-external-chrome-native-host', sha256: hash, required: true,
      signature: { scheme: 'node-shebang', mode: 'development', verified: false, signer: null, teamId: null },
    },
    compatibility: { desktop: { min: '0.22.0', max: '0.22.999' }, shellAbi: { min: 1, max: 1 } },
  }
}

describe('External Chrome package manifest development policy', () => {
  it('rejects a development host by default and accepts it only through the explicit dev policy', () => {
    const manifest = developmentManifest()
    expect(() => parseExternalChromePackageManifest(manifest)).toThrow('not release-verified')
    expect(parseExternalChromePackageManifest(manifest, { allowDevelopmentHost: true })).toEqual(manifest)
  })

  it('rejects an inventory that cannot satisfy the selector-resolved worker path', () => {
    const manifest = developmentManifest()
    manifest.extension.payloadFiles = { 'content-script.js': hash } as typeof manifest.extension.payloadFiles
    expect(() => parseExternalChromePackageManifest(manifest, { allowDevelopmentHost: true }))
      .toThrow('payload inventory does not match the shell ABI')
  })

  it('rejects the POSIX shebang development policy on Windows', () => {
    const manifest = developmentManifest()
    manifest.nativeHost.platform = 'win32'
    manifest.nativeHost.architecture = 'x64'
    expect(() => parseExternalChromePackageManifest(manifest, { allowDevelopmentHost: true }))
      .toThrow('not release-verified')
  })

  it('accepts only an explicit Windows validation SEA provenance through the dev policy', () => {
    const manifest = developmentManifest()
    manifest.nativeHost.platform = 'win32'
    manifest.nativeHost.architecture = 'x64'
    manifest.nativeHost.executable = 'forge-external-chrome-native-host.exe'
    manifest.nativeHost.signature = {
      scheme: 'authenticode', mode: 'validation', verified: false, signer: null, teamId: null,
    }
    manifest.nativeHost.development = {
      source: 'validation-sea', package: '@forge/external-chrome-native-host', bundleSha256: hash, seaConfigSha256: hash,
    }
    expect(() => parseExternalChromePackageManifest(manifest)).toThrow('development native-host provenance is invalid')
    expect(parseExternalChromePackageManifest(manifest, { allowDevelopmentHost: true })).toEqual(manifest)

    manifest.nativeHost.development.source = 'unbounded' as 'validation-sea'
    expect(() => parseExternalChromePackageManifest(manifest, { allowDevelopmentHost: true }))
      .toThrow('development native-host provenance is invalid')
  })

  it('accepts only explicit unsigned Windows release metadata in the production parser', () => {
    const manifest = developmentManifest()
    manifest.nativeHost.platform = 'win32'
    manifest.nativeHost.architecture = 'x64'
    manifest.nativeHost.executable = 'forge-external-chrome-native-host.exe'
    manifest.nativeHost.signature = {
      scheme: 'unsigned', mode: 'release', verified: false, signer: null, teamId: null,
    }
    expect(parseExternalChromePackageManifest(manifest)).toEqual(manifest)

    manifest.nativeHost.signature = { ...manifest.nativeHost.signature, scheme: 'authenticode' }
    expect(() => parseExternalChromePackageManifest(manifest)).toThrow('not release-verified')
  })

  it('does not let the development policy weaken release signature validation', () => {
    const manifest = developmentManifest()
    manifest.nativeHost.signature = {
      scheme: 'node-shebang', mode: 'release', verified: false, signer: null, teamId: null,
    }
    expect(() => parseExternalChromePackageManifest(manifest, { allowDevelopmentHost: true }))
      .toThrow('not release-verified')
  })
})
