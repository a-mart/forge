export const EXTERNAL_CHROME_COORDINATOR_OPERATIONS = [
  'status',
  'enable',
  'disable',
  'repair',
  'remove',
] as const

export type ExternalChromeCoordinatorOperation = (typeof EXTERNAL_CHROME_COORDINATOR_OPERATIONS)[number]
export type ExternalChromeCoordinatorState = 'disabled' | 'online' | 'offline' | 'quiesced' | 'other-instance'
export type ExternalChromeAuthorityState = 'none' | 'owned' | 'other-live' | 'stale'
export type ExternalChromeAuthState = 'missing' | 'secure' | 'insecure' | 'invalid'
export type ExternalChromeRegistrationState = 'not-registered' | 'owned' | 'needs-repair' | 'conflict'
export type ExternalChromeTrustState = 'trusted' | 'untrusted' | 'unsupported' | 'missing'

/** Safe renderer projection. It intentionally excludes secrets, endpoints, paths, PIDs, and browser metadata. */
export interface ExternalChromeCoordinatorStatus {
  state: ExternalChromeCoordinatorState
  authority: ExternalChromeAuthorityState
  auth: ExternalChromeAuthState
  registration: ExternalChromeRegistrationState
  trust: ExternalChromeTrustState
  platform: 'darwin' | 'linux' | 'win32' | 'unsupported'
  canEnable: boolean
  canRepair: boolean
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
