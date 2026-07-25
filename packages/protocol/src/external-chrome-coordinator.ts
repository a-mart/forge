import { EXTERNAL_CHROME_EXTENSION_ID } from './external-chrome.js'

export const EXTERNAL_CHROME_COORDINATOR_OPERATIONS = [
  'status',
  'enable',
  'disable',
  'repair',
  'rollback',
  'remove',
  'takeover',
  'reveal-extension-folder',
] as const

export type ExternalChromeCoordinatorOperation = (typeof EXTERNAL_CHROME_COORDINATOR_OPERATIONS)[number]
export type ExternalChromeCoordinatorState = 'disabled' | 'online' | 'offline' | 'quiesced' | 'other-instance'
export type ExternalChromeRecoveryState =
  | 'ready'
  | 'updating'
  | 'reconnecting'
  | 'rolled-back'
  | 'manual-extension-reload'
  | 'incompatible-payload'
  | 'authority-owned-by-other-data-dir'
export type ExternalChromeAuthorityState = 'none' | 'owned' | 'other-live' | 'stale'
export type ExternalChromeAuthState = 'missing' | 'secure' | 'insecure' | 'invalid'
export type ExternalChromeRegistrationState = 'not-registered' | 'owned' | 'needs-repair' | 'conflict'
export type ExternalChromeTrustState = 'trusted' | 'untrusted' | 'unsupported' | 'missing'
export type ExternalChromeExtensionPathState = 'ready' | 'missing' | 'mismatch' | 'invalid'

export interface ExternalChromeComponentBuild {
  version?: string
  abi?: number
  sha256: string
}

export interface ExternalChromeBuildInventory {
  desktopVersion?: string
  packageVersion?: string
  shell?: ExternalChromeComponentBuild
  payload?: ExternalChromeComponentBuild
  nativeHost?: ExternalChromeComponentBuild
}

/**
 * Renderer-safe setup projection. The only path is the coordinator-resolved,
 * identity-validated unpacked extension root; callers cannot submit a path.
 */
export interface ExternalChromeSetupStatus {
  extensionId: typeof EXTERNAL_CHROME_EXTENSION_ID
  pathState: ExternalChromeExtensionPathState
  loadUnpackedPath?: string
  packaged?: ExternalChromeBuildInventory
  deployed?: ExternalChromeBuildInventory
  running?: ExternalChromeBuildInventory
}

/** Safe renderer projection. It intentionally excludes secrets, endpoints, PIDs, and browser metadata. */
export interface ExternalChromeCoordinatorStatus {
  state: ExternalChromeCoordinatorState
  authority: ExternalChromeAuthorityState
  auth: ExternalChromeAuthState
  registration: ExternalChromeRegistrationState
  trust: ExternalChromeTrustState
  platform: 'darwin' | 'linux' | 'win32' | 'unsupported'
  canEnable: boolean
  canDisable: boolean
  canRepair: boolean
  canRollback: boolean
  canRemove: boolean
  canTakeover: boolean
  canReveal: boolean
  /** Opaque update/reconnect state; never includes browser metadata. */
  recovery: ExternalChromeRecoveryState
  /** Truncated SHA-256 only, used to identify a conflicting Forge data-dir authority. */
  ownerDataDirHash?: string
  setup: ExternalChromeSetupStatus
  detail?: string
}

export interface ExternalChromeCoordinatorRequest {
  operation: ExternalChromeCoordinatorOperation
}

export function parseExternalChromeCoordinatorRequest(value: unknown): ExternalChromeCoordinatorRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('External Chrome control request must be an object')
  }
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'operation') {
    throw new Error('External Chrome control request fields are invalid')
  }
  const operation = (value as { operation?: unknown }).operation
  if (typeof operation !== 'string' || !(EXTERNAL_CHROME_COORDINATOR_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error('External Chrome control operation is invalid')
  }
  return { operation: operation as ExternalChromeCoordinatorOperation }
}
