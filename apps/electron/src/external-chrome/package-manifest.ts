import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { EXTERNAL_CHROME_EXTENSION_ID } from '@forge/protocol'

export { EXTERNAL_CHROME_EXTENSION_ID }
export const EXTERNAL_CHROME_PUBLIC_KEY_SHA256 = '522752d0309e495182b876bac125709358fd32fd1d105bcd5fce42966eb25b93'

export interface ExternalChromePackageManifest {
  schemaVersion: 1
  packageVersion: string
  extension: {
    extensionId: string
    publicKeySha256: string
    minimumChromeVersion: string
    shellAbi: number
    shellSha256: string
    payloadVersion: string
    payloadSha256: string
    payloadDirectory: string
    shellFiles: Record<string, string>
    payloadFiles: Record<string, string>
  }
  nativeHost: {
    protocol: { min: number; max: number; maxMessageBytes: number }
    version: string
    platform: NodeJS.Platform
    architecture: string
    executable: string
    sha256: string
    required: true
    signature: {
      scheme: string
      mode: 'release'
      verified: true
      signer: string | null
      teamId: string | null
    }
  }
  compatibility: {
    desktop: { min: string; max: string }
    shellAbi: { min: number; max: number }
  }
}

const SHA256 = /^[a-f0-9]{64}$/
const SAFE_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/

export async function readExternalChromePackageManifest(file: string): Promise<ExternalChromePackageManifest> {
  return parseExternalChromePackageManifest(JSON.parse(await readFile(file, 'utf8')))
}

export function parseExternalChromePackageManifest(value: unknown): ExternalChromePackageManifest {
  const root = object(value, 'package manifest')
  exactKeys(root, ['schemaVersion', 'packageVersion', 'extension', 'nativeHost', 'compatibility'], 'package manifest')
  if (root.schemaVersion !== 1) throw new Error('Unsupported External Chrome package manifest schema')
  string(root.packageVersion, 'packageVersion')

  const extension = object(root.extension, 'extension')
  exactKeys(extension, [
    'extensionId', 'publicKeySha256', 'minimumChromeVersion', 'shellAbi', 'shellSha256',
    'payloadVersion', 'payloadSha256', 'payloadDirectory', 'shellFiles', 'payloadFiles',
  ], 'extension')
  if (extension.extensionId !== EXTERNAL_CHROME_EXTENSION_ID) throw new Error('External Chrome extension identity mismatch')
  if (extension.publicKeySha256 !== EXTERNAL_CHROME_PUBLIC_KEY_SHA256) throw new Error('External Chrome public identity mismatch')
  positiveInteger(extension.shellAbi, 'extension.shellAbi')
  hash(extension.shellSha256, 'extension.shellSha256')
  hash(extension.payloadSha256, 'extension.payloadSha256')
  string(extension.minimumChromeVersion, 'extension.minimumChromeVersion')
  string(extension.payloadVersion, 'extension.payloadVersion')
  safeSegment(extension.payloadDirectory, 'extension.payloadDirectory')
  if (!(extension.payloadDirectory as string).endsWith(`-${extension.payloadSha256 as string}`)) {
    throw new Error('External Chrome payload directory identity mismatch')
  }
  const shellFiles = hashInventory(extension.shellFiles, 'extension.shellFiles')
  const payloadFiles = hashInventory(extension.payloadFiles, 'extension.payloadFiles')
  if (Object.keys(shellFiles).length === 0 || Object.keys(payloadFiles).length === 0) throw new Error('External Chrome package inventory must not be empty')

  const nativeHost = object(root.nativeHost, 'nativeHost')
  exactKeys(nativeHost, ['protocol', 'version', 'platform', 'architecture', 'executable', 'sha256', 'required', 'signature'], 'nativeHost')
  if (nativeHost.required !== true) throw new Error('External Chrome packaged native executable must be required')
  string(nativeHost.version, 'nativeHost.version')
  string(nativeHost.platform, 'nativeHost.platform')
  string(nativeHost.architecture, 'nativeHost.architecture')
  safeFile(nativeHost.executable, 'nativeHost.executable')
  hash(nativeHost.sha256, 'nativeHost.sha256')
  const signature = object(nativeHost.signature, 'nativeHost.signature')
  exactKeys(signature, ['scheme', 'mode', 'verified', 'signer', 'teamId'], 'nativeHost.signature')
  string(signature.scheme, 'nativeHost.signature.scheme')
  if (signature.mode !== 'release' || signature.verified !== true) {
    throw new Error('External Chrome native executable signature was not release-verified at packaging')
  }
  nullableString(signature.signer, 'nativeHost.signature.signer')
  nullableString(signature.teamId, 'nativeHost.signature.teamId')
  if (nativeHost.platform === 'darwin') {
    if (!(signature.signer as string | null)?.startsWith('Developer ID Application: ') || signature.teamId === null) {
      throw new Error('External Chrome macOS native executable is missing its Developer ID identity/team')
    }
  }
  if (nativeHost.platform === 'win32' && signature.signer === null) {
    throw new Error('External Chrome Windows native executable is missing its Authenticode signer')
  }
  const protocol = object(nativeHost.protocol, 'nativeHost.protocol')
  exactKeys(protocol, ['min', 'max', 'maxMessageBytes'], 'nativeHost.protocol')
  positiveInteger(protocol.min, 'nativeHost.protocol.min')
  positiveInteger(protocol.max, 'nativeHost.protocol.max')
  positiveInteger(protocol.maxMessageBytes, 'nativeHost.protocol.maxMessageBytes')
  if ((protocol.min as number) > (protocol.max as number)) throw new Error('External Chrome native protocol range is invalid')

  const compatibility = object(root.compatibility, 'compatibility')
  exactKeys(compatibility, ['desktop', 'shellAbi'], 'compatibility')
  const desktop = object(compatibility.desktop, 'compatibility.desktop')
  exactKeys(desktop, ['min', 'max'], 'compatibility.desktop')
  string(desktop.min, 'compatibility.desktop.min')
  string(desktop.max, 'compatibility.desktop.max')
  const shellAbi = object(compatibility.shellAbi, 'compatibility.shellAbi')
  exactKeys(shellAbi, ['min', 'max'], 'compatibility.shellAbi')
  positiveInteger(shellAbi.min, 'compatibility.shellAbi.min')
  positiveInteger(shellAbi.max, 'compatibility.shellAbi.max')

  return value as ExternalChromePackageManifest
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.join('\0') !== wanted.join('\0')) throw new Error(`${label} contains missing or unknown fields`)
}

function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
}

function nullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null && (typeof value !== 'string' || value.length === 0)) throw new Error(`${label} must be a non-empty string or null`)
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`)
}

function hash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`)
}

function safeFile(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_FILE.test(value) || value.includes('\\')) throw new Error(`${label} is not a safe relative file`)
}

function safeSegment(value: unknown, label: string): asserts value is string {
  safeFile(value, label)
  if (value.includes('/')) throw new Error(`${label} must be one path segment`)
}

function hashInventory(value: unknown, label: string): Record<string, string> {
  const inventory = object(value, label)
  for (const [file, digest] of Object.entries(inventory)) {
    safeFile(file, `${label} file`)
    hash(digest, `${label}.${file}`)
  }
  return inventory as Record<string, string>
}
