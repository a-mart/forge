import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ExternalChromeRendezvousDocument } from '@forge/protocol'
import { HOST_MAX_RELAY_RECORD_BYTES } from './constants.js'
import type { Platform } from './platform.js'
import type { RelayClientDependencies } from './relay-client.js'
import {
  DesktopUnavailableError,
  NodeSocketConnector,
  type RelaySecretProvider,
  type RendezvousProvider,
} from './transport.js'

const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=\n?$/u

/** Resolve only Forge-owned siblings of the deployed executable; never Chrome profile state. */
export function resolveInstalledRelayPaths(executable: string): {
  integrationRoot: string
  rendezvous: string
  authKey: string
} {
  const nativeHostDirectory = path.dirname(path.resolve(executable))
  if (path.basename(nativeHostDirectory) !== 'native-host') {
    throw new DesktopUnavailableError('native host is not running from the Forge deployment layout')
  }
  const integrationRoot = path.dirname(nativeHostDirectory)
  return {
    integrationRoot,
    rendezvous: path.join(integrationRoot, 'run', 'rendezvous.json'),
    authKey: path.join(integrationRoot, 'auth', 'native-messaging.key'),
  }
}

export function installedUserScope(platform: Platform, username = os.userInfo().username, uid = process.getuid?.()): string {
  const digest = createHash('sha256').update(`${platform}\0${username}\0${uid ?? ''}`).digest('base64url').slice(0, 32)
  return `user_${digest}`
}

export class InstalledRendezvousProvider implements RendezvousProvider {
  constructor(private readonly file: string) {}

  async read(): Promise<ExternalChromeRendezvousDocument> {
    await assertPrivateRegularFile(this.file)
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > 16 * 1_024) throw new Error('rendezvous is oversized')
      return JSON.parse(raw) as ExternalChromeRendezvousDocument
    } catch (error) {
      throw new DesktopUnavailableError(error instanceof Error ? error.message : 'rendezvous is unavailable')
    }
  }
}

export class InstalledSecretProvider implements RelaySecretProvider {
  constructor(private readonly file: string) {}

  async getSecret(expectedKeyId: string): Promise<Uint8Array> {
    await assertPrivateRegularFile(this.file)
    let text: string
    try { text = await fs.readFile(this.file, 'utf8') } catch (error) {
      throw new DesktopUnavailableError(error instanceof Error ? error.message : 'authentication key is unavailable')
    }
    if (!KEY_PATTERN.test(text)) throw new DesktopUnavailableError('authentication key is malformed')
    const key = Buffer.from(text.trim(), 'base64')
    const actualKeyId = `key-${createHash('sha256').update(key).digest('base64url').slice(0, 24)}`
    if (actualKeyId !== expectedKeyId) {
      key.fill(0)
      throw new DesktopUnavailableError('authentication key does not match rendezvous')
    }
    return key
  }
}

export function createInstalledRelayDependencies(input: {
  executable: string
  platform: Platform
  extensionOrigin: string
}): Pick<RelayClientDependencies, 'rendezvous' | 'secrets' | 'connector' | 'expectedUserScope' | 'expectedExtensionOrigin' | 'platform'> {
  const paths = resolveInstalledRelayPaths(input.executable)
  return {
    rendezvous: new InstalledRendezvousProvider(paths.rendezvous),
    secrets: new InstalledSecretProvider(paths.authKey),
    connector: new NodeSocketConnector(HOST_MAX_RELAY_RECORD_BYTES),
    expectedUserScope: installedUserScope(input.platform),
    expectedExtensionOrigin: input.extensionOrigin,
    platform: input.platform,
  }
}

async function assertPrivateRegularFile(file: string): Promise<void> {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('path is not a regular file')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('path is not private to the current user')
    if (process.getuid !== undefined && stat.uid !== process.getuid()) throw new Error('path is owned by another user')
  } catch (error) {
    throw new DesktopUnavailableError(error instanceof Error ? error.message : 'private file validation failed')
  }
}
