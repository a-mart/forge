import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getExternalChromeAuthDir,
  getExternalChromeAuthKeyPath,
  getExternalChromeDeploymentDir,
  getExternalChromeDeploymentJournalPath,
  getExternalChromeDeploymentLockPath,
  getExternalChromeExtensionDir,
  getExternalChromeExtensionCurrentPath,
  getExternalChromeExtensionPayloadsDir,
  getExternalChromeInstallStatePath,
  getExternalChromeIntegrationDir,
  getExternalChromeNativeHostDir,
  getExternalChromeNativeHostExecutablePath,
  getExternalChromeNativeHostManifestPath,
  getExternalChromeNativeHostManifestsDir,
  getExternalChromePreviousStatePath,
  getExternalChromeRendezvousPath,
  getExternalChromeRunDir,
  getExternalChromeStateDir,
} from '../storage/data-paths.js'

describe('External Chrome data paths', () => {
  it('keeps every stable child under the authoritative integration root', () => {
    const data = join('/tmp', 'custom-forge')
    const root = join(data, 'integrations', 'external-chrome')
    expect(getExternalChromeIntegrationDir(data)).toBe(root)
    expect(getExternalChromeExtensionDir(data)).toBe(join(root, 'extension'))
    expect(getExternalChromeExtensionPayloadsDir(data)).toBe(join(root, 'extension', 'payloads'))
    expect(getExternalChromeExtensionCurrentPath(data)).toBe(join(root, 'extension', 'current.json'))
    expect(getExternalChromeNativeHostDir(data)).toBe(join(root, 'native-host'))
    expect(getExternalChromeNativeHostExecutablePath(data, 'linux')).toBe(join(root, 'native-host', 'forge-external-chrome-native-host'))
    expect(getExternalChromeNativeHostExecutablePath(data, 'win32')).toBe(join(root, 'native-host', 'forge-external-chrome-native-host.exe'))
    expect(getExternalChromeNativeHostManifestsDir(data)).toBe(join(root, 'native-host-manifests'))
    expect(getExternalChromeNativeHostManifestPath(data)).toBe(join(root, 'native-host-manifests', 'com.forge.external_chrome.json'))
    expect(getExternalChromeStateDir(data)).toBe(join(root, 'state'))
    expect(getExternalChromeInstallStatePath(data)).toBe(join(root, 'state', 'install.json'))
    expect(getExternalChromePreviousStatePath(data)).toBe(join(root, 'state', 'previous.json'))
    expect(getExternalChromeAuthDir(data)).toBe(join(root, 'auth'))
    expect(getExternalChromeAuthKeyPath(data)).toBe(join(root, 'auth', 'native-messaging.key'))
    expect(getExternalChromeRunDir(data)).toBe(join(root, 'run'))
    expect(getExternalChromeRendezvousPath(data)).toBe(join(root, 'run', 'rendezvous.json'))
    expect(getExternalChromeDeploymentDir(data)).toBe(join(root, 'deployment'))
    expect(getExternalChromeDeploymentJournalPath(data)).toBe(join(root, 'deployment', 'journal.json'))
    expect(getExternalChromeDeploymentLockPath(data)).toBe(join(root, 'deploy.lock'))
  })
})
