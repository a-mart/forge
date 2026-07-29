import {
  BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES,
  BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS,
  BROWSER_AUTOMATION_MAX_EVALUATE_BYTES,
  BROWSER_AUTOMATION_MAX_INTERACTIVE_ELEMENTS,
  BROWSER_AUTOMATION_MAX_SAFE_ACTIONS,
  BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH,
  BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_LENGTH,
  BROWSER_AUTOMATION_OPERATIONS,
  BROWSER_VIEWPORT_MAX_AREA,
  BROWSER_VIEWPORT_MAX_DIMENSION,
  BROWSER_VIEWPORT_MIN_DIMENSION,
  BROWSER_VIEWPORT_PRESETS,
  EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS,
  isBrowserAutomationOperation,
  parseBrowserAutomationInput,
  type BrowserAutomationFailure,
  type BrowserAutomationInputByOperation,
  type BrowserAutomationOperation,
  type BrowserAutomationResultByOperation,
  type BrowserEligibleTab,
} from './browser-automation.js'

/** Stable identity derived from Forge's pinned offline public manifest key. */
export const EXTERNAL_CHROME_EXTENSION_ID = 'fcchfcnadajoejfbiclihglkmbcfhajd'
export const EXTERNAL_CHROME_EXTENSION_ORIGIN = `chrome-extension://${EXTERNAL_CHROME_EXTENSION_ID}/`
export const EXTERNAL_CHROME_NATIVE_HOST_NAME = 'com.forge.external_chrome'

export const EXTERNAL_CHROME_PROTOCOL_MIN_VERSION = 1
export const EXTERNAL_CHROME_PROTOCOL_MAX_VERSION = 1
export const EXTERNAL_CHROME_PROTOCOL_VERSIONS = [1] as const
export type ExternalChromeProtocolVersion = (typeof EXTERNAL_CHROME_PROTOCOL_VERSIONS)[number]

/** Non-secret, current-user-only Desktop rendezvous consumed by the native messaging host. */
export interface ExternalChromeRendezvousDocument {
  schemaVersion: 1
  endpoint: string
  epoch: string
  expiresAt: string
  keyId: string
  userScope: string
  desktopInstanceId: string
  desktopPid: number
  protocolMin: number
  protocolMax: number
}

/** Lower Forge bounds apply before the native-messaging transport's platform bounds. */
export const EXTERNAL_CHROME_MAX_MESSAGE_BYTES = 1 * 1_024 * 1_024
/** Native relay negotiation currently selects 256 KiB; keep this shared for envelope budgeting. */
export const EXTERNAL_CHROME_MAX_NEGOTIATED_MESSAGE_BYTES = 256 * 1_024
/** Reserved headroom for transport evolution and authenticated relay framing. */
export const EXTERNAL_CHROME_RESPONSE_SAFETY_MARGIN_BYTES = 16 * 1_024
export const EXTERNAL_CHROME_MAX_NATIVE_INBOUND_FRAME_BYTES = 64 * 1_024 * 1_024
export const EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES = 1 * 1_024 * 1_024
export const EXTERNAL_CHROME_MAX_ARRAY_ITEMS = 256
export const EXTERNAL_CHROME_MAX_AUTHORIZED_TABS = 128
export const EXTERNAL_CHROME_MAX_OBJECT_PROPERTIES = 128
export const EXTERNAL_CHROME_MAX_JSON_DEPTH = 32
export const EXTERNAL_CHROME_MAX_STRING_LENGTH = 256 * 1_024
export const EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH = 128
export const EXTERNAL_CHROME_MAX_LABEL_LENGTH = 512
export const EXTERNAL_CHROME_MAX_URL_LENGTH = 2_048
export const EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH = 1_024
const EXTERNAL_CHROME_MAX_DATE_MS = 8_640_000_000_000_000

export const EXTERNAL_CHROME_REQUEST_METHODS = [
  'forge.runtime.hello',
  'forge.runtime.ping',
  'forge.browser.inventory',
  'forge.browser.acquire',
  'forge.browser.release',
  'forge.browser.reveal',
  'forge.browser.execute',
  'forge.runtime.prepareUpdate',
  'forge.runtime.reload',
] as const

export const EXTERNAL_CHROME_NOTIFICATION_METHODS = [
  'browser.cdpEvent',
  'browser.detached',
  'browser.userControl',
  'browser.tabChanged',
  'browser.downloadChanged',
  'browser.leaseChanged',
  'runtime.goodbye',
] as const

export const EXTERNAL_CHROME_METHODS = [
  ...EXTERNAL_CHROME_REQUEST_METHODS,
  ...EXTERNAL_CHROME_NOTIFICATION_METHODS,
] as const

export type ExternalChromeRequestMethod = (typeof EXTERNAL_CHROME_REQUEST_METHODS)[number]
export type ExternalChromeNotificationMethod = (typeof EXTERNAL_CHROME_NOTIFICATION_METHODS)[number]
export type ExternalChromeMethod = (typeof EXTERNAL_CHROME_METHODS)[number]

export const EXTERNAL_CHROME_SUPPORTED_OPERATIONS = EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS
export const EXTERNAL_CHROME_UNSUPPORTED_OPERATIONS = [
  'resize',
  'recordingStart',
  'recordingStop',
] as const satisfies readonly BrowserAutomationOperation[]

export const EXTERNAL_CHROME_JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  transportOrAuthentication: -32010,
  protocolOrVersion: -32020,
  leaseOrScope: -32030,
  targetOrDebugger: -32040,
  execution: -32050,
} as const

export const EXTERNAL_CHROME_TRANSPORT_ERROR_CODES = [
  'transport-unavailable',
  'authentication-failed',
  'message-too-large',
] as const
export const EXTERNAL_CHROME_PROTOCOL_ERROR_CODES = [
  'malformed-message',
  'unknown-method',
  'invalid-params',
  'protocol-version-unsupported',
  'shell-abi-mismatch',
  'payload-version-mismatch',
  'extension-update-required',
] as const
export const EXTERNAL_CHROME_LEASE_ERROR_CODES = [
  'lease-conflict',
  'lease-lost',
  'stale-lease-epoch',
  'scope-mismatch',
] as const
export const EXTERNAL_CHROME_TARGET_ERROR_CODES = [
  'restricted-target',
  'target-not-found',
  'tab-not-found',
  'debugger-unavailable',
  'chrome-policy-blocked',
  'target-detached',
] as const
export const EXTERNAL_CHROME_EXECUTION_ERROR_CODES = [
  'unsupported-operation',
  'invalid-input',
  'invalid-url',
  'navigation-failed',
  'timeout',
  'control-interrupted',
  'invalid-selector',
  'target-not-editable',
  'coordinates-outside-viewport',
  'evaluation-failed',
  'result-too-large',
  'response-too-large',
  'request-cancelled',
  'execution-failed',
] as const

export type ExternalChromeTransportErrorCode = (typeof EXTERNAL_CHROME_TRANSPORT_ERROR_CODES)[number]
export type ExternalChromeProtocolErrorCode = (typeof EXTERNAL_CHROME_PROTOCOL_ERROR_CODES)[number]
export type ExternalChromeLeaseErrorCode = (typeof EXTERNAL_CHROME_LEASE_ERROR_CODES)[number]
export type ExternalChromeTargetErrorCode = (typeof EXTERNAL_CHROME_TARGET_ERROR_CODES)[number]
export type ExternalChromeExecutionErrorCode = (typeof EXTERNAL_CHROME_EXECUTION_ERROR_CODES)[number]
export type ExternalChromeErrorCode =
  | ExternalChromeTransportErrorCode
  | ExternalChromeProtocolErrorCode
  | ExternalChromeLeaseErrorCode
  | ExternalChromeTargetErrorCode
  | ExternalChromeExecutionErrorCode

export type ExternalChromeJsonPrimitive = string | number | boolean | null
export type ExternalChromeJsonValue = ExternalChromeJsonPrimitive | ExternalChromeJsonObject | ExternalChromeJsonValue[]
export interface ExternalChromeJsonObject {
  [key: string]: ExternalChromeJsonValue
}

export interface ExternalChromeProtocolRange {
  min: number
  max: number
}

export interface ExternalChromeOperationCapability {
  operation: BrowserAutomationOperation
  supported: boolean
  reason?: string
}

export interface ExternalChromeFeatures {
  resize: boolean
  recording: boolean
  downloadEvents: boolean
  downloadArtifacts: boolean
  downloadOpen: boolean
  oopif: boolean
  humanInterruption: boolean
}

export interface ExternalChromeHelloParams {
  protocol: ExternalChromeProtocolRange
  shellAbi: number
  payloadVersion: string
  /**
   * Hash parsed from the immutable selected payload directory by the shell-loaded runtime.
   * Absent only on the authenticated pre-M5 V1 hello; that compatibility form is never
   * sufficient for operation readiness.
   */
  payloadSha256?: string
  extensionId: string
  extensionInstanceId: string
  chromeVersion: string
  methods: ExternalChromeMethod[]
  maxMessageBytes: number
  operations: ExternalChromeOperationCapability[]
  features: ExternalChromeFeatures
}

export interface ExternalChromeWelcomeResult {
  protocolVersion: ExternalChromeProtocolVersion
  desktopInstanceId: string
  heartbeatMs: number
  maxMessageBytes: number
  requiredShellAbi: number
  update?: ExternalChromeUpdateDescriptor
}

export interface ExternalChromeUpdateDescriptor {
  payloadVersion: string
  sha256: string
}

export interface ExternalChromePingParams {
  protocolVersion: ExternalChromeProtocolVersion
  nonce: string
  sentAt: string
}

export interface ExternalChromePongResult {
  protocolVersion: ExternalChromeProtocolVersion
  nonce: string
  receivedAt: string
}

export interface ExternalChromeInventoryParams {
  protocolVersion: ExternalChromeProtocolVersion
  sessionAgentId: string
}

export interface ExternalChromeInventoryTab {
  tabId: number
  windowId: number
  title: string
  url: string
  active: boolean
  windowFocused: boolean
  lastAccessed: number
}

export interface ExternalChromeInventoryResult {
  protocolVersion: ExternalChromeProtocolVersion
  tabs: ExternalChromeInventoryTab[]
  truncated: boolean
}

export interface ExternalChromeLeaseRouting {
  protocolVersion: ExternalChromeProtocolVersion
  leaseId: string
  leaseEpoch: number
}

export interface ExternalChromeAcquiredTab {
  tabId: number
  title: string
  url: string
  active: boolean
}

export interface ExternalChromeAcquireParams extends ExternalChromeLeaseRouting {
  sessionAgentId: string
  tabId?: number
  /** Creation is an explicit caller decision; omission of tabId never implies it. */
  createIfNeeded: boolean
}

export interface ExternalChromeAcquireResult extends ExternalChromeLeaseRouting {
  sessionAgentId: string
  extensionInstanceId: string
  tab: ExternalChromeAcquiredTab
  created: boolean
}

export interface ExternalChromeReleaseParams extends ExternalChromeLeaseRouting {
  reason: string
}

export interface ExternalChromeReleaseResult extends ExternalChromeLeaseRouting {
  releasedTabIds: number[]
}

type ExternalChromeOperationInput<Operation extends BrowserAutomationOperation> = Omit<
  BrowserAutomationInputByOperation[Operation],
  'tabId'
>

export type ExternalChromeExecuteParams = {
  [Operation in BrowserAutomationOperation]: ExternalChromeLeaseRouting & {
    requestId: string
    tabId: number
    operation: Operation
    input: ExternalChromeOperationInput<Operation>
    deadlineAt: string
  }
}[BrowserAutomationOperation]

interface ExternalChromeExecuteResultRouting<Operation extends BrowserAutomationOperation> extends ExternalChromeLeaseRouting {
  requestId: string
  tabId: number
  operation: Operation
}

export const EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS = {
  failurePhase: 'debugger-attach',
  mutationState: 'not-started',
  fallbackReason: 'foreign-debugger',
} as const

/**
 * Extension-private proof that Chrome rejected the initial debugger attach because another
 * debugger already owned the tab. The Desktop adapter consumes this exact object and never
 * forwards these host-specific fields to browser callers.
 */
export type ExternalChromeDebuggerAttachConflictDetails = typeof EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS

export function isExternalChromeDebuggerAttachConflictDetails(
  value: unknown,
): value is ExternalChromeDebuggerAttachConflictDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const details = value as Record<string, unknown>
  return Object.keys(details).length === 3 &&
    details.failurePhase === EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS.failurePhase &&
    details.mutationState === EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS.mutationState &&
    details.fallbackReason === EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS.fallbackReason
}

export type ExternalChromeExecuteResult = {
  [Operation in BrowserAutomationOperation]:
    | (ExternalChromeExecuteResultRouting<Operation> & {
        ok: true
        result: BrowserAutomationResultByOperation[Operation]
      })
    | (ExternalChromeExecuteResultRouting<Operation> & {
        ok: false
        error: BrowserAutomationFailure
      })
}[BrowserAutomationOperation]

export interface ExternalChromeRevealParams extends ExternalChromeLeaseRouting {
  tabId: number
}

export interface ExternalChromeRevealResult extends ExternalChromeLeaseRouting {
  tabId: number
  revealed: true
}

export interface ExternalChromePrepareUpdateParams {
  protocolVersion: ExternalChromeProtocolVersion
  payloadVersion: string
  sha256: string
  deadlineAt: string
}

export interface ExternalChromePrepareUpdateResult {
  protocolVersion: ExternalChromeProtocolVersion
  payloadVersion: string
  quiesced: true
}

export interface ExternalChromeReloadParams {
  protocolVersion: ExternalChromeProtocolVersion
  payloadVersion: string
  sha256: string
}

export interface ExternalChromeReloadResult {
  protocolVersion: ExternalChromeProtocolVersion
  payloadVersion: string
  accepted: true
}

export interface ExternalChromeCdpEventParams extends ExternalChromeLeaseRouting {
  tabId: number
  targetId: string
  sessionId?: string
  method: string
  params: ExternalChromeJsonObject
}

export interface ExternalChromeDetachedParams extends ExternalChromeLeaseRouting {
  tabId: number
  reason: string
}

export interface ExternalChromeUserControlParams extends ExternalChromeLeaseRouting {
  tabId: number
  controlEpoch: number
  event: 'pointer' | 'key' | 'wheel' | 'touch'
  at: string
}

export interface ExternalChromeTabChangedParams extends ExternalChromeLeaseRouting {
  tabId: number
  change: {
    windowId?: number
    url?: string
    title?: string
    active?: boolean
    loading?: boolean
  }
}

export interface ExternalChromeDownloadChangedParams extends ExternalChromeLeaseRouting {
  tabId: number
  downloadId: number
  state: 'in-progress' | 'complete' | 'interrupted'
  danger: 'safe' | 'dangerous' | 'unknown'
  filename?: string
  bytesReceived: number
  totalBytes: number
}

export interface ExternalChromeLeaseChangedParams extends ExternalChromeLeaseRouting {
  state: 'acquired' | 'released'
  tabIds: number[]
}

export interface ExternalChromeGoodbyeParams {
  protocolVersion: ExternalChromeProtocolVersion
  reason: string
}

export interface ExternalChromeRequestParamsByMethod {
  'forge.runtime.hello': ExternalChromeHelloParams
  'forge.runtime.ping': ExternalChromePingParams
  'forge.browser.inventory': ExternalChromeInventoryParams
  'forge.browser.acquire': ExternalChromeAcquireParams
  'forge.browser.release': ExternalChromeReleaseParams
  'forge.browser.reveal': ExternalChromeRevealParams
  'forge.browser.execute': ExternalChromeExecuteParams
  'forge.runtime.prepareUpdate': ExternalChromePrepareUpdateParams
  'forge.runtime.reload': ExternalChromeReloadParams
}

export interface ExternalChromeResultByMethod {
  'forge.runtime.hello': ExternalChromeWelcomeResult
  'forge.runtime.ping': ExternalChromePongResult
  'forge.browser.inventory': ExternalChromeInventoryResult
  'forge.browser.acquire': ExternalChromeAcquireResult
  'forge.browser.release': ExternalChromeReleaseResult
  'forge.browser.reveal': ExternalChromeRevealResult
  'forge.browser.execute': ExternalChromeExecuteResult
  'forge.runtime.prepareUpdate': ExternalChromePrepareUpdateResult
  'forge.runtime.reload': ExternalChromeReloadResult
}

export interface ExternalChromeNotificationParamsByMethod {
  'browser.cdpEvent': ExternalChromeCdpEventParams
  'browser.detached': ExternalChromeDetachedParams
  'browser.userControl': ExternalChromeUserControlParams
  'browser.tabChanged': ExternalChromeTabChangedParams
  'browser.downloadChanged': ExternalChromeDownloadChangedParams
  'browser.leaseChanged': ExternalChromeLeaseChangedParams
  'runtime.goodbye': ExternalChromeGoodbyeParams
}

export type ExternalChromeRequest = {
  [Method in ExternalChromeRequestMethod]: {
    jsonrpc: '2.0'
    id: string
    method: Method
    params: ExternalChromeRequestParamsByMethod[Method]
  }
}[ExternalChromeRequestMethod]

export type ExternalChromeNotification = {
  [Method in ExternalChromeNotificationMethod]: {
    jsonrpc: '2.0'
    method: Method
    params: ExternalChromeNotificationParamsByMethod[Method]
  }
}[ExternalChromeNotificationMethod]

export interface ExternalChromeErrorData {
  code: ExternalChromeErrorCode
  retryable: boolean
  requestId?: string
  leaseId?: string
  leaseEpoch?: number
  tabId?: number
  detail?: string
}

export interface ExternalChromeJsonRpcError {
  code: number
  message: string
  data?: ExternalChromeErrorData
}

export type ExternalChromeSuccessResponse<Method extends ExternalChromeRequestMethod = ExternalChromeRequestMethod> =
  Method extends ExternalChromeRequestMethod
    ? {
        jsonrpc: '2.0'
        id: string
        result: ExternalChromeResultByMethod[Method]
      }
    : never

export interface ExternalChromeErrorResponse {
  jsonrpc: '2.0'
  id: string
  error: ExternalChromeJsonRpcError
}

export type ExternalChromeResponse = ExternalChromeSuccessResponse | ExternalChromeErrorResponse
export type ExternalChromeJsonRpcMessage = ExternalChromeRequest | ExternalChromeNotification | ExternalChromeResponse

export const EXTERNAL_CHROME_CONTRACT_FAILURE_CODES = [
  'malformed-json',
  'frame-too-large',
  'invalid-envelope',
  'unknown-method',
  'invalid-params',
  'invalid-result',
  'unsupported-version',
  'response-method-required',
] as const
export type ExternalChromeContractFailureCode = (typeof EXTERNAL_CHROME_CONTRACT_FAILURE_CODES)[number]

export class ExternalChromeContractError extends Error {
  readonly failureCode: ExternalChromeContractFailureCode
  readonly jsonRpcCode: number

  constructor(failureCode: ExternalChromeContractFailureCode, message: string, jsonRpcCode: number) {
    super(`External Chrome contract ${failureCode}: ${message}`)
    this.name = 'ExternalChromeContractError'
    this.failureCode = failureCode
    this.jsonRpcCode = jsonRpcCode
  }
}

export interface ParseExternalChromeJsonRpcOptions {
  expectedResponseMethod?: ExternalChromeRequestMethod
  protocolVersion?: ExternalChromeProtocolVersion
}

function fail(
  failureCode: ExternalChromeContractFailureCode,
  message: string,
  jsonRpcCode: number = EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidRequest,
): never {
  throw new ExternalChromeContractError(failureCode, message, jsonRpcCode)
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('invalid-envelope', `${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function strictKeys(value: Record<string, unknown>, path: string, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  const unexpected = Object.keys(value).sort().find((key) => !allowed.has(key))
  if (unexpected !== undefined) fail('invalid-envelope', `${path} has unexpected field ${unexpected}`)
  const missing = required.find((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (missing !== undefined) fail('invalid-envelope', `${path} is missing field ${missing}`)
}

function boundedString(value: unknown, path: string, max = EXTERNAL_CHROME_MAX_STRING_LENGTH, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    return fail('invalid-envelope', `${path} must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${max} characters`)
  }
  return value
}

function identifier(value: unknown, path: string): string {
  return boundedString(value, path, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
}

function extensionInstanceIdentifier(value: unknown, path: string): string {
  const result = boundedString(value, path, 64)
  if (!/^[A-Za-z0-9_-]+$/u.test(result)) return fail('invalid-envelope', `${path} must be a canonical opaque identifier`)
  return result
}

function integer(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail('invalid-envelope', `${path} must be an integer from ${minimum} to ${maximum}`)
  }
  return value as number
}

function finiteNumber(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    return fail('invalid-envelope', `${path} must be a finite number no less than ${minimum}`)
  }
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return fail('invalid-envelope', `${path} must be boolean`)
  return value
}

function boundedArray(value: unknown, path: string, maximum = EXTERNAL_CHROME_MAX_ARRAY_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return fail('invalid-envelope', `${path} must be an array of at most ${maximum} items`)
  }
  return value
}

function uniqueArray<T>(values: T[], path: string): T[] {
  if (new Set(values).size !== values.length) fail('invalid-envelope', `${path} must not contain duplicates`)
  return values
}

function validateBoundedJson(value: unknown, path: string, depth = 0): ExternalChromeJsonValue {
  if (depth > EXTERNAL_CHROME_MAX_JSON_DEPTH) fail('invalid-envelope', `${path} exceeds maximum JSON depth`)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return boundedString(value, path, EXTERNAL_CHROME_MAX_STRING_LENGTH, true)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid-envelope', `${path} must contain only finite numbers`)
    return value
  }
  if (Array.isArray(value)) {
    return boundedArray(value, path).map((entry, index) => validateBoundedJson(entry, `${path}[${index}]`, depth + 1))
  }
  const record = object(value, path)
  if (Object.keys(record).length > EXTERNAL_CHROME_MAX_OBJECT_PROPERTIES) {
    fail('invalid-envelope', `${path} exceeds maximum object property count`)
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      boundedString(key, `${path} key`, EXTERNAL_CHROME_MAX_LABEL_LENGTH),
      validateBoundedJson(entry, `${path}.${key}`, depth + 1),
    ]),
  )
}

function protocolVersion(value: unknown, expected?: ExternalChromeProtocolVersion): ExternalChromeProtocolVersion {
  if (!EXTERNAL_CHROME_PROTOCOL_VERSIONS.includes(value as ExternalChromeProtocolVersion) || (expected !== undefined && value !== expected)) {
    return fail(
      'unsupported-version',
      `protocolVersion ${String(value)} is not supported`,
      EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.protocolOrVersion,
    )
  }
  return value as ExternalChromeProtocolVersion
}

export function negotiateExternalChromeProtocolVersion(range: ExternalChromeProtocolRange): ExternalChromeProtocolVersion {
  const minimum = integer(range.min, 'protocol.min', 1)
  const maximum = integer(range.max, 'protocol.max', 1)
  if (minimum > maximum) fail('unsupported-version', 'protocol.min must not exceed protocol.max', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.protocolOrVersion)
  for (let index = EXTERNAL_CHROME_PROTOCOL_VERSIONS.length - 1; index >= 0; index -= 1) {
    const version = EXTERNAL_CHROME_PROTOCOL_VERSIONS[index]
    if (version >= minimum && version <= maximum) return version
  }
  return fail('unsupported-version', `protocol range ${minimum}-${maximum} has no supported version`, EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.protocolOrVersion)
}

function parseProtocolRange(value: unknown): ExternalChromeProtocolRange {
  const range = object(value, 'params.protocol')
  strictKeys(range, 'params.protocol', ['min', 'max'])
  const parsed = { min: integer(range.min, 'params.protocol.min', 1), max: integer(range.max, 'params.protocol.max', 1) }
  negotiateExternalChromeProtocolVersion(parsed)
  return parsed
}

function parseFeatures(value: unknown): ExternalChromeFeatures {
  const features = object(value, 'params.features')
  const keys = ['resize', 'recording', 'downloadEvents', 'downloadArtifacts', 'downloadOpen', 'oopif', 'humanInterruption'] as const
  strictKeys(features, 'params.features', keys)
  const parsed = Object.fromEntries(keys.map((key) => [key, boolean(features[key], `params.features.${key}`)])) as unknown as ExternalChromeFeatures
  if (parsed.resize || parsed.recording || parsed.downloadArtifacts || parsed.downloadOpen) {
    fail('invalid-params', 'unqualified V1 features must remain disabled', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
  }
  return parsed
}

function parseOperationCapabilities(value: unknown): ExternalChromeOperationCapability[] {
  const entries = boundedArray(value, 'params.operations', BROWSER_AUTOMATION_OPERATIONS.length).map((entry, index) => {
    const capability = object(entry, `params.operations[${index}]`)
    strictKeys(capability, `params.operations[${index}]`, ['operation', 'supported'], ['reason'])
    if (!isBrowserAutomationOperation(capability.operation)) fail('invalid-params', `params.operations[${index}].operation is unknown`, EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
    const supported = boolean(capability.supported, `params.operations[${index}].supported`)
    const reason = capability.reason === undefined ? undefined : boundedString(capability.reason, `params.operations[${index}].reason`, EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH)
    if (supported && reason !== undefined) fail('invalid-params', `params.operations[${index}].reason is forbidden for a supported operation`, EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
    if (!supported && reason === undefined) fail('invalid-params', `params.operations[${index}].reason is required for an unsupported operation`, EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
    return { operation: capability.operation, supported, ...(reason === undefined ? {} : { reason }) }
  })
  uniqueArray(entries.map((entry) => entry.operation), 'params.operations')
  if (entries.length !== BROWSER_AUTOMATION_OPERATIONS.length || BROWSER_AUTOMATION_OPERATIONS.some((operation) => !entries.some((entry) => entry.operation === operation))) {
    fail('invalid-params', 'params.operations must describe every browser operation exactly once', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
  }
  for (const entry of entries) {
    const maySupport = (EXTERNAL_CHROME_SUPPORTED_OPERATIONS as readonly BrowserAutomationOperation[]).includes(entry.operation)
    if (entry.supported && !maySupport) fail('invalid-params', `params.operations support for ${entry.operation} contradicts V1 capability`, EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
  }
  return entries
}

function parseMethods(value: unknown): ExternalChromeMethod[] {
  const legacyFocusedMethod = 'forge.browser.focusedEligibility'
  const raw = uniqueArray(
    boundedArray(value, 'params.methods', EXTERNAL_CHROME_METHODS.length).map((entry, index) => {
      if (typeof entry !== 'string' || (!(EXTERNAL_CHROME_METHODS as readonly string[]).includes(entry) && entry !== legacyFocusedMethod)) {
        return fail('unknown-method', `params.methods[${index}] is unknown`, EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.methodNotFound)
      }
      return entry
    }),
    'params.methods',
  )
  const current = EXTERNAL_CHROME_METHODS.every((method) => raw.includes(method))
  const legacy = raw.includes(legacyFocusedMethod)
    && !raw.includes('forge.browser.inventory')
    && EXTERNAL_CHROME_METHODS.filter((method) => method !== 'forge.browser.inventory').every((method) => raw.includes(method))
  if (raw.length !== EXTERNAL_CHROME_METHODS.length || (!current && !legacy)) {
    fail('invalid-params', 'params.methods must contain one complete runtime method generation', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
  }
  // The legacy form is hello-only update compatibility. It never makes the
  // stale payload operation-ready; the immutable payload identity gate does.
  return [...EXTERNAL_CHROME_METHODS]
}

function parseUpdate(value: unknown, path: string): ExternalChromeUpdateDescriptor {
  const update = object(value, path)
  strictKeys(update, path, ['payloadVersion', 'sha256'])
  const sha256 = boundedString(update.sha256, `${path}.sha256`, 64)
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail('invalid-envelope', `${path}.sha256 must be lowercase hexadecimal SHA-256`)
  return { payloadVersion: identifier(update.payloadVersion, `${path}.payloadVersion`), sha256 }
}

function parseLeaseRouting(record: Record<string, unknown>, expected?: ExternalChromeProtocolVersion): ExternalChromeLeaseRouting {
  return {
    protocolVersion: protocolVersion(record.protocolVersion, expected),
    leaseId: identifier(record.leaseId, 'params.leaseId'),
    leaseEpoch: integer(record.leaseEpoch, 'params.leaseEpoch', 1),
  }
}

function parseNumericIdArray(value: unknown, path: string, allowEmpty = true): number[] {
  const parsed = uniqueArray(boundedArray(value, path, EXTERNAL_CHROME_MAX_AUTHORIZED_TABS).map((entry, index) => integer(entry, `${path}[${index}]`)), path)
  if (!allowEmpty && parsed.length === 0) fail('invalid-envelope', `${path} must not be empty`)
  return parsed
}

function parseAcquiredTab(value: unknown, path: string): ExternalChromeAcquiredTab {
  const tab = object(value, path)
  strictKeys(tab, path, ['tabId', 'title', 'url', 'active'])
  return {
    tabId: integer(tab.tabId, `${path}.tabId`),
    title: boundedString(tab.title, `${path}.title`, EXTERNAL_CHROME_MAX_LABEL_LENGTH, true),
    url: boundedString(tab.url, `${path}.url`, EXTERNAL_CHROME_MAX_URL_LENGTH),
    active: boolean(tab.active, `${path}.active`),
  }
}

function parseInventoryTab(value: unknown, path: string): ExternalChromeInventoryTab {
  const tab = object(value, path)
  strictKeys(tab, path, ['tabId', 'windowId', 'title', 'url', 'active', 'windowFocused', 'lastAccessed'])
  const lastAccessed = finiteNumber(tab.lastAccessed, `${path}.lastAccessed`)
  if (lastAccessed > EXTERNAL_CHROME_MAX_DATE_MS) fail('invalid-result', `${path}.lastAccessed is outside the timestamp bound`)
  return {
    tabId: integer(tab.tabId, `${path}.tabId`),
    windowId: integer(tab.windowId, `${path}.windowId`),
    title: boundedString(tab.title, `${path}.title`, EXTERNAL_CHROME_MAX_LABEL_LENGTH, true),
    url: boundedString(tab.url, `${path}.url`, EXTERNAL_CHROME_MAX_URL_LENGTH),
    active: boolean(tab.active, `${path}.active`),
    windowFocused: boolean(tab.windowFocused, `${path}.windowFocused`),
    lastAccessed,
  }
}

function parseBrowserFailure(value: unknown, path: string): BrowserAutomationFailure {
  const error = object(value, path)
  strictKeys(error, path, ['code', 'message', 'retryable'], ['details'])
  if (typeof error.code !== 'string') fail('invalid-result', `${path}.code must be a string`)
  const knownCodes = [
    ...EXTERNAL_CHROME_LEASE_ERROR_CODES,
    ...EXTERNAL_CHROME_TARGET_ERROR_CODES,
    ...EXTERNAL_CHROME_EXECUTION_ERROR_CODES,
    'unavailable-host', 'session-not-found', 'tab-session-mismatch', 'host-disconnected', 'stale-host-generation',
    'malformed-response', 'artifact-path-invalid', 'recording-conflict', 'recording-requires-visible-tab', 'recording-not-found',
    'extension-update-required',
  ]
  if (!knownCodes.includes(error.code)) fail('invalid-result', `${path}.code is unknown`)
  let details: BrowserAutomationFailure['details'] | undefined
  if (error.details !== undefined) {
    const rawDetails = object(error.details, `${path}.details`)
    if (Object.keys(rawDetails).length > EXTERNAL_CHROME_MAX_OBJECT_PROPERTIES) fail('invalid-result', `${path}.details exceeds property bound`)
    const hasAttachEvidenceField = ['failurePhase', 'mutationState', 'fallbackReason']
      .some((key) => Object.prototype.hasOwnProperty.call(rawDetails, key))
    if (hasAttachEvidenceField && (error.code !== 'debugger-unavailable' || !isExternalChromeDebuggerAttachConflictDetails(rawDetails))) {
      fail('invalid-result', `${path}.details has malformed debugger attach conflict evidence`)
    }
    details = Object.fromEntries(Object.entries(rawDetails).map(([key, entry]) => {
      boundedString(key, `${path}.details key`, EXTERNAL_CHROME_MAX_LABEL_LENGTH)
      if (entry === null || typeof entry === 'boolean') return [key, entry]
      if (typeof entry === 'string') return [key, boundedString(entry, `${path}.details.${key}`, EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH, true)]
      if (typeof entry === 'number' && Number.isFinite(entry)) return [key, entry]
      return fail('invalid-result', `${path}.details.${key} must be a JSON primitive`)
    }))
  }
  return {
    code: error.code as BrowserAutomationFailure['code'],
    message: boundedString(error.message, `${path}.message`, EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH),
    retryable: boolean(error.retryable, `${path}.retryable`),
    ...(details === undefined ? {} : { details }),
  }
}

function parseHelloParams(value: unknown): ExternalChromeHelloParams {
  const params = object(value, 'params')
  strictKeys(params, 'params', ['protocol', 'shellAbi', 'payloadVersion', 'extensionId', 'extensionInstanceId', 'chromeVersion', 'methods', 'maxMessageBytes', 'operations', 'features'], ['payloadSha256'])
  const extensionId = identifier(params.extensionId, 'params.extensionId')
  if (extensionId !== EXTERNAL_CHROME_EXTENSION_ID) fail('invalid-params', 'params.extensionId does not match the pinned identity', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
  return {
    protocol: parseProtocolRange(params.protocol),
    shellAbi: integer(params.shellAbi, 'params.shellAbi', 1),
    payloadVersion: identifier(params.payloadVersion, 'params.payloadVersion'),
    ...(params.payloadSha256 === undefined ? {} : { payloadSha256: (() => {
      const digest = boundedString(params.payloadSha256, 'params.payloadSha256', 64)
      if (!/^[a-f0-9]{64}$/u.test(digest)) fail('invalid-params', 'params.payloadSha256 must be lowercase SHA-256', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      return digest
    })() }),
    extensionId,
    extensionInstanceId: extensionInstanceIdentifier(params.extensionInstanceId, 'params.extensionInstanceId'),
    chromeVersion: boundedString(params.chromeVersion, 'params.chromeVersion', EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH),
    methods: parseMethods(params.methods),
    maxMessageBytes: integer(params.maxMessageBytes, 'params.maxMessageBytes', 1, EXTERNAL_CHROME_MAX_MESSAGE_BYTES),
    operations: parseOperationCapabilities(params.operations),
    features: parseFeatures(params.features),
  }
}

function parseRequestParams(method: ExternalChromeRequestMethod, value: unknown, expected?: ExternalChromeProtocolVersion): ExternalChromeRequestParamsByMethod[ExternalChromeRequestMethod] {
  if (method === 'forge.runtime.hello') return parseHelloParams(value)
  const params = object(value, 'params')
  switch (method) {
    case 'forge.runtime.ping': {
      strictKeys(params, 'params', ['protocolVersion', 'nonce', 'sentAt'])
      return { protocolVersion: protocolVersion(params.protocolVersion, expected), nonce: identifier(params.nonce, 'params.nonce'), sentAt: boundedString(params.sentAt, 'params.sentAt', EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH) }
    }
    case 'forge.browser.inventory': {
      strictKeys(params, 'params', ['protocolVersion', 'sessionAgentId'])
      return {
        protocolVersion: protocolVersion(params.protocolVersion, expected),
        sessionAgentId: identifier(params.sessionAgentId, 'params.sessionAgentId'),
      }
    }
    case 'forge.browser.acquire': {
      strictKeys(params, 'params', ['protocolVersion', 'sessionAgentId', 'leaseId', 'leaseEpoch', 'createIfNeeded'], ['tabId'])
      const tabId = params.tabId === undefined ? undefined : integer(params.tabId, 'params.tabId')
      const createIfNeeded = boolean(params.createIfNeeded, 'params.createIfNeeded')
      if ((tabId === undefined) !== createIfNeeded) {
        fail('invalid-params', 'params must select exactly one existing tab or explicitly request creation', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      }
      return {
        ...parseLeaseRouting(params, expected),
        sessionAgentId: identifier(params.sessionAgentId, 'params.sessionAgentId'),
        ...(tabId === undefined ? {} : { tabId }),
        createIfNeeded,
      }
    }
    case 'forge.browser.release': {
      strictKeys(params, 'params', ['protocolVersion', 'leaseId', 'leaseEpoch', 'reason'])
      return { ...parseLeaseRouting(params, expected), reason: boundedString(params.reason, 'params.reason', EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH) }
    }
    case 'forge.browser.reveal': {
      strictKeys(params, 'params', ['protocolVersion', 'leaseId', 'leaseEpoch', 'tabId'])
      return { ...parseLeaseRouting(params, expected), tabId: integer(params.tabId, 'params.tabId') }
    }
    case 'forge.browser.execute': {
      strictKeys(params, 'params', ['protocolVersion', 'requestId', 'leaseId', 'leaseEpoch', 'tabId', 'operation', 'input', 'deadlineAt'])
      if (!isBrowserAutomationOperation(params.operation)) fail('invalid-params', 'params.operation is unknown', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      const rawInput = object(params.input, 'params.input')
      if ('tabId' in rawInput) fail('invalid-params', 'params.input must not duplicate routing fields', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      let parsedInput: BrowserAutomationInputByOperation[BrowserAutomationOperation]
      try {
        parsedInput = parseBrowserAutomationInput(params.operation, rawInput)
      } catch {
        return fail('invalid-params', 'params.input is invalid for the operation', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      }
      return { ...parseLeaseRouting(params, expected), requestId: identifier(params.requestId, 'params.requestId'), tabId: integer(params.tabId, 'params.tabId'), operation: params.operation, input: parsedInput, deadlineAt: boundedString(params.deadlineAt, 'params.deadlineAt', EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH) } as ExternalChromeExecuteParams
    }
    case 'forge.runtime.prepareUpdate': {
      strictKeys(params, 'params', ['protocolVersion', 'payloadVersion', 'sha256', 'deadlineAt'])
      return { protocolVersion: protocolVersion(params.protocolVersion, expected), ...parseUpdate({ payloadVersion: params.payloadVersion, sha256: params.sha256 }, 'params.update'), deadlineAt: boundedString(params.deadlineAt, 'params.deadlineAt', EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH) }
    }
    case 'forge.runtime.reload': {
      strictKeys(params, 'params', ['protocolVersion', 'payloadVersion', 'sha256'])
      return { protocolVersion: protocolVersion(params.protocolVersion, expected), ...parseUpdate({ payloadVersion: params.payloadVersion, sha256: params.sha256 }, 'params.update') }
    }
  }
}

function enumeration<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail('invalid-result', `${path} is unknown`)
  return value as T
}

function nullableIdentifier(value: unknown, path: string): string | null {
  return value === null ? null : identifier(value, path)
}

function validateViewportSetting(value: unknown, path: string): void {
  const setting = object(value, path)
  if (setting.mode === 'fill') {
    strictKeys(setting, path, ['mode'])
    return
  }
  if (setting.mode === 'freeform') {
    strictKeys(setting, path, ['mode', 'width', 'height'])
  } else if (setting.mode === 'preset') {
    strictKeys(setting, path, ['mode', 'presetId', 'orientation', 'width', 'height'])
    enumeration(setting.presetId, `${path}.presetId`, Object.keys(BROWSER_VIEWPORT_PRESETS))
    enumeration(setting.orientation, `${path}.orientation`, ['portrait', 'landscape'])
  } else {
    fail('invalid-result', `${path}.mode is unknown`)
  }
  const width = integer(setting.width, `${path}.width`, BROWSER_VIEWPORT_MIN_DIMENSION, BROWSER_VIEWPORT_MAX_DIMENSION)
  const height = integer(setting.height, `${path}.height`, BROWSER_VIEWPORT_MIN_DIMENSION, BROWSER_VIEWPORT_MAX_DIMENSION)
  if (width * height > BROWSER_VIEWPORT_MAX_AREA) fail('invalid-result', `${path} exceeds maximum viewport area`)
}

function validateRenderedViewport(value: unknown, path: string): void {
  const viewport = object(value, path)
  strictKeys(viewport, path, ['width', 'height', 'deviceScaleFactor'])
  integer(viewport.width, `${path}.width`, 1, BROWSER_VIEWPORT_MAX_DIMENSION)
  integer(viewport.height, `${path}.height`, 1, BROWSER_VIEWPORT_MAX_DIMENSION)
  finiteNumber(viewport.deviceScaleFactor, `${path}.deviceScaleFactor`, Number.MIN_VALUE)
}

function validateBrowserCapabilities(value: unknown, path: string): void {
  const capabilities = object(value, path)
  strictKeys(capabilities, path, ['supportedOperations', 'maxResponseBytes'], [
    'protocolVersions', 'features', 'runtimeVersions',
  ])
  if (capabilities.protocolVersions !== undefined) {
    const versions = object(capabilities.protocolVersions, `${path}.protocolVersions`)
    strictKeys(versions, `${path}.protocolVersions`, ['minimum', 'maximum'])
    const minimum = integer(versions.minimum, `${path}.protocolVersions.minimum`, 1)
    const maximum = integer(versions.maximum, `${path}.protocolVersions.maximum`, 1)
    if (minimum > maximum) fail('invalid-result', `${path}.protocolVersions is reversed`)
  }
  uniqueArray(boundedArray(capabilities.supportedOperations, `${path}.supportedOperations`, BROWSER_AUTOMATION_OPERATIONS.length).map((entry, index) => {
    if (!isBrowserAutomationOperation(entry)) fail('invalid-result', `${path}.supportedOperations[${index}] is unknown`)
    return entry
  }), `${path}.supportedOperations`)
  integer(capabilities.maxResponseBytes, `${path}.maxResponseBytes`, 1, EXTERNAL_CHROME_MAX_MESSAGE_BYTES)
  if (capabilities.features !== undefined) {
    const features = object(capabilities.features, `${path}.features`)
    strictKeys(features, `${path}.features`, ['resize', 'recording', 'capturePage', 'downloadEvents', 'downloadArtifacts', 'downloadOpen'])
    for (const key of Object.keys(features)) boolean(features[key], `${path}.features.${key}`)
  }
  if (capabilities.runtimeVersions !== undefined) {
    const versions = object(capabilities.runtimeVersions, `${path}.runtimeVersions`)
    strictKeys(versions, `${path}.runtimeVersions`, [], ['electron', 'chromium', 'playwright', 'chrome', 'extension'])
    for (const [key, entry] of Object.entries(versions)) boundedString(entry, `${path}.runtimeVersions.${key}`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
  }
}

function validateBrowserHost(value: unknown, path: string): void {
  const host = object(value, path)
  strictKeys(host, path, ['connected', 'hostId', 'hostGeneration', 'focused', 'capabilities', 'connectedAt'])
  boolean(host.connected, `${path}.connected`)
  nullableIdentifier(host.hostId, `${path}.hostId`)
  if (host.hostGeneration !== null) integer(host.hostGeneration, `${path}.hostGeneration`, 1)
  boolean(host.focused, `${path}.focused`)
  if (host.capabilities !== null) validateBrowserCapabilities(host.capabilities, `${path}.capabilities`)
  if (host.connectedAt !== null) boundedString(host.connectedAt, `${path}.connectedAt`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
}

function validateBrowserTab(value: unknown, path: string): void {
  const tab = object(value, path)
  strictKeys(tab, path, [
    'targetAffinity', 'tabId', 'sessionAgentId', 'profileId', 'url', 'title', 'lifecycle', 'loading', 'live', 'canGoBack',
    'canGoForward', 'zoomFactor', 'controller', 'agentCursor', 'recording', 'viewportSetting', 'renderedViewport',
    'error', 'createdAt', 'updatedAt',
  ], ['physicalVisible'])
  enumeration(tab.targetAffinity, `${path}.targetAffinity`, ['managed-electron', 'external-chrome'])
  identifier(tab.tabId, `${path}.tabId`)
  identifier(tab.sessionAgentId, `${path}.sessionAgentId`)
  identifier(tab.profileId, `${path}.profileId`)
  boundedString(tab.url, `${path}.url`, EXTERNAL_CHROME_MAX_URL_LENGTH)
  boundedString(tab.title, `${path}.title`, EXTERNAL_CHROME_MAX_LABEL_LENGTH, true)
  enumeration(tab.lifecycle, `${path}.lifecycle`, ['restoring', 'loading', 'ready', 'failed', 'closed'])
  for (const key of ['loading', 'live', 'canGoBack', 'canGoForward'] as const) boolean(tab[key], `${path}.${key}`)
  finiteNumber(tab.zoomFactor, `${path}.zoomFactor`, Number.MIN_VALUE)
  enumeration(tab.controller, `${path}.controller`, ['human', 'agent', 'none'])
  if (tab.agentCursor !== null) {
    const cursor = object(tab.agentCursor, `${path}.agentCursor`)
    strictKeys(cursor, `${path}.agentCursor`, ['x', 'y', 'phase', 'sequence', 'createdAt'])
    finiteNumber(cursor.x, `${path}.agentCursor.x`, Number.NEGATIVE_INFINITY)
    finiteNumber(cursor.y, `${path}.agentCursor.y`, Number.NEGATIVE_INFINITY)
    enumeration(cursor.phase, `${path}.agentCursor.phase`, ['move', 'click'])
    integer(cursor.sequence, `${path}.agentCursor.sequence`)
    boundedString(cursor.createdAt, `${path}.agentCursor.createdAt`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
  }
  if (tab.recording !== null) {
    const recording = object(tab.recording, `${path}.recording`)
    strictKeys(recording, `${path}.recording`, ['recordingId', 'startedAt', 'mimeType'])
    identifier(recording.recordingId, `${path}.recording.recordingId`)
    boundedString(recording.startedAt, `${path}.recording.startedAt`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
    boundedString(recording.mimeType, `${path}.recording.mimeType`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
  }
  validateViewportSetting(tab.viewportSetting, `${path}.viewportSetting`)
  if (tab.renderedViewport !== null) validateRenderedViewport(tab.renderedViewport, `${path}.renderedViewport`)
  if (tab.physicalVisible !== undefined) boolean(tab.physicalVisible, `${path}.physicalVisible`)
  if (tab.error !== null) {
    const error = object(tab.error, `${path}.error`)
    strictKeys(error, `${path}.error`, ['code', 'message'])
    identifier(error.code, `${path}.error.code`)
    boundedString(error.message, `${path}.error.message`, EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH)
  }
  boundedString(tab.createdAt, `${path}.createdAt`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
  boundedString(tab.updatedAt, `${path}.updatedAt`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
}

function validateEligibleTab(value: unknown, path: string): BrowserEligibleTab {
  const tab = object(value, path)
  strictKeys(tab, path, ['targetAffinity', 'tabId', 'browserProfileId', 'windowId', 'title', 'url', 'active', 'windowFocused', 'lastAccessedAt'])
  if (tab.targetAffinity !== 'external-chrome') fail('invalid-result', `${path}.targetAffinity must be external-chrome`)
  const lastAccessedAt = boundedString(tab.lastAccessedAt, `${path}.lastAccessedAt`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
  const timestamp = Date.parse(lastAccessedAt)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== lastAccessedAt) {
    fail('invalid-result', `${path}.lastAccessedAt must be a canonical ISO timestamp`)
  }
  return {
    targetAffinity: 'external-chrome',
    tabId: identifier(tab.tabId, `${path}.tabId`),
    browserProfileId: identifier(tab.browserProfileId, `${path}.browserProfileId`),
    windowId: identifier(tab.windowId, `${path}.windowId`),
    title: boundedString(tab.title, `${path}.title`, EXTERNAL_CHROME_MAX_LABEL_LENGTH, true),
    url: boundedString(tab.url, `${path}.url`, EXTERNAL_CHROME_MAX_URL_LENGTH),
    active: boolean(tab.active, `${path}.active`),
    windowFocused: boolean(tab.windowFocused, `${path}.windowFocused`),
    lastAccessedAt,
  }
}

function validateSnapshotCompaction(value: unknown, path: string): void {
  const compaction = object(value, path)
  strictKeys(compaction, path, ['omitted'])
  const omitted = object(compaction.omitted, `${path}.omitted`)
  strictKeys(omitted, `${path}.omitted`, [], [
    'accessibilityNodes', 'consoleEntries', 'networkEntries', 'actionTimelineEntries', 'interactiveElements', 'visibleTextCharacters',
  ])
  for (const key of Object.keys(omitted)) integer(omitted[key], `${path}.omitted.${key}`, 1)
}

function validateSnapshotResult(result: Record<string, unknown>, path: string): void {
  validateViewportSetting(result.viewportSetting, `${path}.viewportSetting`)
  validateRenderedViewport(result.viewport, `${path}.viewport`)
  boundedString(result.visibleText, `${path}.visibleText`, BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_LENGTH, true)
  boundedArray(result.interactiveElements, `${path}.interactiveElements`, BROWSER_AUTOMATION_MAX_INTERACTIVE_ELEMENTS).forEach((entry, index) => {
    const elementPath = `${path}.interactiveElements[${index}]`
    const element = object(entry, elementPath)
    strictKeys(element, elementPath, ['tag', 'role', 'name', 'selector', 'x', 'y', 'width', 'height'])
    boundedString(element.tag, `${elementPath}.tag`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
    if (element.role !== null) boundedString(element.role, `${elementPath}.role`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
    boundedString(element.name, `${elementPath}.name`, EXTERNAL_CHROME_MAX_LABEL_LENGTH, true)
    boundedString(element.selector, `${elementPath}.selector`, EXTERNAL_CHROME_MAX_URL_LENGTH)
    for (const key of ['x', 'y', 'width', 'height'] as const) finiteNumber(element[key], `${elementPath}.${key}`, Number.NEGATIVE_INFINITY)
  })
  validateBoundedJson(result.accessibility, `${path}.accessibility`)
  boundedArray(result.consoleEntries, `${path}.consoleEntries`, BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES).forEach((entry, index) => {
    const entryPath = `${path}.consoleEntries[${index}]`
    const consoleEntry = object(entry, entryPath)
    strictKeys(consoleEntry, entryPath, ['level', 'text', 'timestamp'], ['source'])
    boundedString(consoleEntry.level, `${entryPath}.level`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
    boundedString(consoleEntry.text, `${entryPath}.text`, EXTERNAL_CHROME_MAX_STRING_LENGTH, true)
    boundedString(consoleEntry.timestamp, `${entryPath}.timestamp`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
    if (consoleEntry.source !== undefined) boundedString(consoleEntry.source, `${entryPath}.source`, EXTERNAL_CHROME_MAX_URL_LENGTH)
  })
  boundedArray(result.networkEntries, `${path}.networkEntries`, BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES).forEach((entry, index) => {
    const entryPath = `${path}.networkEntries[${index}]`
    const network = object(entry, entryPath)
    strictKeys(network, entryPath, ['url', 'method', 'status', 'failed', 'timestamp'], ['errorText'])
    boundedString(network.url, `${entryPath}.url`, EXTERNAL_CHROME_MAX_URL_LENGTH)
    boundedString(network.method, `${entryPath}.method`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
    if (network.status !== null) integer(network.status, `${entryPath}.status`, 0, 999)
    boolean(network.failed, `${entryPath}.failed`)
    if (network.errorText !== undefined) boundedString(network.errorText, `${entryPath}.errorText`, EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH)
    boundedString(network.timestamp, `${entryPath}.timestamp`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
  })
  boundedArray(result.actionTimeline, `${path}.actionTimeline`, BROWSER_AUTOMATION_MAX_SAFE_ACTIONS).forEach((entry, index) => {
    const entryPath = `${path}.actionTimeline[${index}]`
    const action = object(entry, entryPath)
    strictKeys(action, entryPath, ['id', 'action', 'status', 'startedAt'], ['completedAt', 'errorCode'])
    identifier(action.id, `${entryPath}.id`)
    boundedString(action.action, `${entryPath}.action`, EXTERNAL_CHROME_MAX_LABEL_LENGTH)
    enumeration(action.status, `${entryPath}.status`, ['running', 'succeeded', 'failed', 'interrupted'])
    boundedString(action.startedAt, `${entryPath}.startedAt`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
    if (action.completedAt !== undefined) boundedString(action.completedAt, `${entryPath}.completedAt`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
    if (action.errorCode !== undefined) parseBrowserFailure({ code: action.errorCode, message: 'validation', retryable: false }, `${entryPath}.errorCode`)
  })
  if (result.compaction !== undefined) validateSnapshotCompaction(result.compaction, `${path}.compaction`)
  const screenshot = object(result.screenshot, `${path}.screenshot`)
  strictKeys(screenshot, `${path}.screenshot`, ['mimeType', 'data', 'width', 'height'])
  if (screenshot.mimeType !== 'image/png') fail('invalid-result', `${path}.screenshot.mimeType must be image/png`)
  boundedString(screenshot.data, `${path}.screenshot.data`, EXTERNAL_CHROME_MAX_STRING_LENGTH, true)
  integer(screenshot.width, `${path}.screenshot.width`, 1, BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH)
  integer(screenshot.height, `${path}.screenshot.height`, 1, BROWSER_VIEWPORT_MAX_DIMENSION)
}

function validateStrictOperationResult(operation: BrowserAutomationOperation, result: Record<string, unknown>): void {
  const path = 'result.result'
  switch (operation) {
    case 'status':
      validateBrowserHost(result.host, `${path}.host`)
      if (result.selectedTab !== null) validateBrowserTab(result.selectedTab, `${path}.selectedTab`)
      boundedArray(result.eligibleTabs, `${path}.eligibleTabs`, BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS)
        .forEach((tab, index) => validateEligibleTab(tab, `${path}.eligibleTabs[${index}]`))
      return
    case 'open': validateBrowserTab(result.tab, `${path}.tab`); return
    case 'navigate': validateBrowserTab(result.tab, `${path}.tab`); return
    case 'resize': validateViewportSetting(result.setting, `${path}.setting`); validateRenderedViewport(result.viewport, `${path}.viewport`); return
    case 'snapshot': validateSnapshotResult(result, path); return
    case 'press':
      uniqueArray(boundedArray(result.modifiers, `${path}.modifiers`, 4).map((entry) => enumeration(entry, `${path}.modifiers`, ['Alt', 'Control', 'Meta', 'Shift'])), `${path}.modifiers`)
      return
    case 'evaluate':
      if (result.value !== undefined) validateBoundedJson(result.value, `${path}.value`)
      if (result.remoteObject !== undefined) {
        const remote = object(result.remoteObject, `${path}.remoteObject`)
        strictKeys(remote, `${path}.remoteObject`, ['type'], ['subtype', 'description', 'objectId'])
        boundedString(remote.type, `${path}.remoteObject.type`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
        for (const key of ['subtype', 'description', 'objectId'] as const) if (remote[key] !== undefined) boundedString(remote[key], `${path}.remoteObject.${key}`, key === 'description' ? EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH : EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
      }
      integer(result.serializedBytes, `${path}.serializedBytes`, 0, BROWSER_AUTOMATION_MAX_EVALUATE_BYTES)
      return
    case 'recordingStart':
      boundedString(result.startedAt, `${path}.startedAt`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
      boundedString(result.mimeType, `${path}.mimeType`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
      integer(result.width, `${path}.width`, 1, BROWSER_VIEWPORT_MAX_DIMENSION)
      integer(result.height, `${path}.height`, 1, BROWSER_VIEWPORT_MAX_DIMENSION)
      return
    case 'recordingStop':
      boundedString(result.path, `${path}.path`, EXTERNAL_CHROME_MAX_URL_LENGTH)
      boundedString(result.mimeType, `${path}.mimeType`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
      boundedString(result.extension, `${path}.extension`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
      integer(result.width, `${path}.width`, 1, BROWSER_VIEWPORT_MAX_DIMENSION)
      integer(result.height, `${path}.height`, 1, BROWSER_VIEWPORT_MAX_DIMENSION)
      boundedString(result.createdAt, `${path}.createdAt`, EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
      break
    default: break
  }
}

function parseOperationResult(
  operation: BrowserAutomationOperation,
  value: unknown,
): BrowserAutomationResultByOperation[BrowserAutomationOperation] {
  const bounded = validateBoundedJson(value, 'result.result')
  if (typeof bounded !== 'object' || bounded === null || Array.isArray(bounded)) {
    return fail('invalid-result', 'result.result must be an object')
  }
  const result = bounded as Record<string, unknown>
  validateStrictOperationResult(operation, result)
  switch (operation) {
    case 'status':
      strictKeys(result, 'result.result', ['available', 'host', 'panelVisible', 'panelRevealRequested', 'physicalTabVisible', 'selectedTab', 'eligibleTabs', 'eligibleTabsTruncated'])
      boolean(result.available, 'result.result.available')
      boolean(result.panelVisible, 'result.result.panelVisible')
      boolean(result.panelRevealRequested, 'result.result.panelRevealRequested')
      boolean(result.physicalTabVisible, 'result.result.physicalTabVisible')
      object(result.host, 'result.result.host')
      if (result.selectedTab !== null) object(result.selectedTab, 'result.result.selectedTab')
      boundedArray(result.eligibleTabs, 'result.result.eligibleTabs', BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS)
      boolean(result.eligibleTabsTruncated, 'result.result.eligibleTabsTruncated')
      break
    case 'open':
      strictKeys(result, 'result.result', ['tab', 'created', 'panelRevealRequested'])
      object(result.tab, 'result.result.tab')
      boolean(result.created, 'result.result.created')
      boolean(result.panelRevealRequested, 'result.result.panelRevealRequested')
      break
    case 'navigate':
      strictKeys(result, 'result.result', ['tab', 'readiness'])
      object(result.tab, 'result.result.tab')
      if (result.readiness !== 'load' && result.readiness !== 'domContentLoaded' && result.readiness !== 'none') fail('invalid-result', 'result.result.readiness is unknown')
      break
    case 'resize':
      strictKeys(result, 'result.result', ['tabId', 'setting', 'viewport'])
      identifier(result.tabId, 'result.result.tabId')
      object(result.setting, 'result.result.setting')
      object(result.viewport, 'result.result.viewport')
      break
    case 'snapshot':
      strictKeys(result, 'result.result', ['tabId', 'url', 'title', 'loading', 'viewportSetting', 'viewport', 'visibleText', 'interactiveElements', 'accessibility', 'consoleEntries', 'networkEntries', 'actionTimeline', 'screenshot'], ['compaction'])
      identifier(result.tabId, 'result.result.tabId')
      boundedString(result.url, 'result.result.url', EXTERNAL_CHROME_MAX_URL_LENGTH)
      boundedString(result.title, 'result.result.title', EXTERNAL_CHROME_MAX_LABEL_LENGTH, true)
      boolean(result.loading, 'result.result.loading')
      object(result.viewportSetting, 'result.result.viewportSetting')
      object(result.viewport, 'result.result.viewport')
      boundedString(result.visibleText, 'result.result.visibleText', EXTERNAL_CHROME_MAX_STRING_LENGTH, true)
      boundedArray(result.interactiveElements, 'result.result.interactiveElements')
      boundedArray(result.consoleEntries, 'result.result.consoleEntries')
      boundedArray(result.networkEntries, 'result.result.networkEntries')
      boundedArray(result.actionTimeline, 'result.result.actionTimeline')
      object(result.screenshot, 'result.result.screenshot')
      break
    case 'click': {
      strictKeys(result, 'result.result', ['tabId', 'point'])
      identifier(result.tabId, 'result.result.tabId')
      const point = object(result.point, 'result.result.point')
      strictKeys(point, 'result.result.point', ['x', 'y'])
      finiteNumber(point.x, 'result.result.point.x', Number.NEGATIVE_INFINITY)
      finiteNumber(point.y, 'result.result.point.y', Number.NEGATIVE_INFINITY)
      break
    }
    case 'type':
      strictKeys(result, 'result.result', ['tabId', 'characters', 'cleared'])
      identifier(result.tabId, 'result.result.tabId')
      integer(result.characters, 'result.result.characters')
      boolean(result.cleared, 'result.result.cleared')
      break
    case 'press':
      strictKeys(result, 'result.result', ['tabId', 'key', 'modifiers'])
      identifier(result.tabId, 'result.result.tabId')
      boundedString(result.key, 'result.result.key', EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH)
      boundedArray(result.modifiers, 'result.result.modifiers', 4)
      break
    case 'scroll':
      strictKeys(result, 'result.result', ['tabId', 'deltaX', 'deltaY', 'scrollX', 'scrollY'])
      identifier(result.tabId, 'result.result.tabId')
      finiteNumber(result.deltaX, 'result.result.deltaX', Number.NEGATIVE_INFINITY)
      finiteNumber(result.deltaY, 'result.result.deltaY', Number.NEGATIVE_INFINITY)
      finiteNumber(result.scrollX, 'result.result.scrollX', Number.NEGATIVE_INFINITY)
      finiteNumber(result.scrollY, 'result.result.scrollY', Number.NEGATIVE_INFINITY)
      break
    case 'evaluate':
      strictKeys(result, 'result.result', ['tabId', 'serializedBytes'], ['value', 'remoteObject'])
      identifier(result.tabId, 'result.result.tabId')
      integer(result.serializedBytes, 'result.result.serializedBytes')
      if (result.remoteObject !== undefined) object(result.remoteObject, 'result.result.remoteObject')
      break
    case 'waitFor':
      strictKeys(result, 'result.result', ['tabId', 'matched', 'elapsedMs'])
      identifier(result.tabId, 'result.result.tabId')
      if (result.matched !== true) fail('invalid-result', 'result.result.matched must be true')
      finiteNumber(result.elapsedMs, 'result.result.elapsedMs')
      break
    case 'recordingStart':
      strictKeys(result, 'result.result', ['recordingId', 'tabId', 'recording', 'startedAt', 'mimeType', 'width', 'height'])
      identifier(result.recordingId, 'result.result.recordingId')
      identifier(result.tabId, 'result.result.tabId')
      boolean(result.recording, 'result.result.recording')
      break
    case 'recordingStop':
      strictKeys(result, 'result.result', ['recordingId', 'tabId', 'path', 'mimeType', 'extension', 'sizeBytes', 'width', 'height', 'createdAt'])
      identifier(result.recordingId, 'result.result.recordingId')
      identifier(result.tabId, 'result.result.tabId')
      integer(result.sizeBytes, 'result.result.sizeBytes')
      break
  }
  return bounded as unknown as BrowserAutomationResultByOperation[BrowserAutomationOperation]
}

function parseExecuteResult(value: unknown, expected?: ExternalChromeProtocolVersion): ExternalChromeExecuteResult {
  const result = object(value, 'result')
  strictKeys(result, 'result', ['protocolVersion', 'requestId', 'leaseId', 'leaseEpoch', 'tabId', 'operation', 'ok'], ['result', 'error'])
  if (!isBrowserAutomationOperation(result.operation)) fail('invalid-result', 'result.operation is unknown')
  const routing = { ...parseLeaseRouting(result, expected), requestId: identifier(result.requestId, 'result.requestId'), tabId: integer(result.tabId, 'result.tabId'), operation: result.operation }
  if (result.ok === true) {
    if (result.result === undefined || result.error !== undefined) fail('invalid-result', 'successful execute result requires result and forbids error')
    const operationResult = parseOperationResult(result.operation, result.result)
    return { ...routing, ok: true, result: operationResult } as ExternalChromeExecuteResult
  }
  if (result.ok === false) {
    if (result.error === undefined || result.result !== undefined) fail('invalid-result', 'failed execute result requires error and forbids result')
    return { ...routing, ok: false, error: parseBrowserFailure(result.error, 'result.error') } as ExternalChromeExecuteResult
  }
  return fail('invalid-result', 'result.ok must be boolean')
}

function parseResult(method: ExternalChromeRequestMethod, value: unknown, expected?: ExternalChromeProtocolVersion): ExternalChromeResultByMethod[ExternalChromeRequestMethod] {
  const result = object(value, 'result')
  switch (method) {
    case 'forge.runtime.hello': {
      strictKeys(result, 'result', ['protocolVersion', 'desktopInstanceId', 'heartbeatMs', 'maxMessageBytes', 'requiredShellAbi'], ['update'])
      return { protocolVersion: protocolVersion(result.protocolVersion, expected), desktopInstanceId: identifier(result.desktopInstanceId, 'result.desktopInstanceId'), heartbeatMs: integer(result.heartbeatMs, 'result.heartbeatMs', 1, 300_000), maxMessageBytes: integer(result.maxMessageBytes, 'result.maxMessageBytes', 1, EXTERNAL_CHROME_MAX_MESSAGE_BYTES), requiredShellAbi: integer(result.requiredShellAbi, 'result.requiredShellAbi', 1), ...(result.update === undefined ? {} : { update: parseUpdate(result.update, 'result.update') }) }
    }
    case 'forge.runtime.ping': {
      strictKeys(result, 'result', ['protocolVersion', 'nonce', 'receivedAt'])
      return { protocolVersion: protocolVersion(result.protocolVersion, expected), nonce: identifier(result.nonce, 'result.nonce'), receivedAt: boundedString(result.receivedAt, 'result.receivedAt', EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH) }
    }
    case 'forge.browser.inventory': {
      strictKeys(result, 'result', ['protocolVersion', 'tabs', 'truncated'])
      const tabs = boundedArray(result.tabs, 'result.tabs', BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS)
        .map((tab, index) => parseInventoryTab(tab, `result.tabs[${index}]`))
      if (new Set(tabs.map((tab) => tab.tabId)).size !== tabs.length) fail('invalid-result', 'result.tabs contains duplicate tab IDs')
      return {
        protocolVersion: protocolVersion(result.protocolVersion, expected),
        tabs,
        truncated: boolean(result.truncated, 'result.truncated'),
      }
    }
    case 'forge.browser.acquire': {
      strictKeys(result, 'result', ['protocolVersion', 'sessionAgentId', 'leaseId', 'leaseEpoch', 'extensionInstanceId', 'tab', 'created'])
      return {
        ...parseLeaseRouting(result, expected),
        sessionAgentId: identifier(result.sessionAgentId, 'result.sessionAgentId'),
        extensionInstanceId: extensionInstanceIdentifier(result.extensionInstanceId, 'result.extensionInstanceId'),
        tab: parseAcquiredTab(result.tab, 'result.tab'),
        created: boolean(result.created, 'result.created'),
      }
    }
    case 'forge.browser.release': {
      strictKeys(result, 'result', ['protocolVersion', 'leaseId', 'leaseEpoch', 'releasedTabIds'])
      return { ...parseLeaseRouting(result, expected), releasedTabIds: parseNumericIdArray(result.releasedTabIds, 'result.releasedTabIds') }
    }
    case 'forge.browser.reveal': {
      strictKeys(result, 'result', ['protocolVersion', 'leaseId', 'leaseEpoch', 'tabId', 'revealed'])
      if (result.revealed !== true) fail('invalid-result', 'result.revealed must be true')
      return { ...parseLeaseRouting(result, expected), tabId: integer(result.tabId, 'result.tabId'), revealed: true }
    }
    case 'forge.browser.execute': return parseExecuteResult(value, expected)
    case 'forge.runtime.prepareUpdate': {
      strictKeys(result, 'result', ['protocolVersion', 'payloadVersion', 'quiesced'])
      if (result.quiesced !== true) fail('invalid-result', 'result.quiesced must be true')
      return { protocolVersion: protocolVersion(result.protocolVersion, expected), payloadVersion: identifier(result.payloadVersion, 'result.payloadVersion'), quiesced: true }
    }
    case 'forge.runtime.reload': {
      strictKeys(result, 'result', ['protocolVersion', 'payloadVersion', 'accepted'])
      if (result.accepted !== true) fail('invalid-result', 'result.accepted must be true')
      return { protocolVersion: protocolVersion(result.protocolVersion, expected), payloadVersion: identifier(result.payloadVersion, 'result.payloadVersion'), accepted: true }
    }
  }
}

function parseNotificationParams(method: ExternalChromeNotificationMethod, value: unknown, expected?: ExternalChromeProtocolVersion): ExternalChromeNotificationParamsByMethod[ExternalChromeNotificationMethod] {
  const params = object(value, 'params')
  switch (method) {
    case 'browser.cdpEvent': {
      strictKeys(params, 'params', ['protocolVersion', 'leaseId', 'leaseEpoch', 'tabId', 'targetId', 'method', 'params'], ['sessionId'])
      const payload = validateBoundedJson(params.params, 'params.params')
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) fail('invalid-params', 'params.params must be an object', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      return { ...parseLeaseRouting(params, expected), tabId: integer(params.tabId, 'params.tabId'), targetId: identifier(params.targetId, 'params.targetId'), ...(params.sessionId === undefined ? {} : { sessionId: identifier(params.sessionId, 'params.sessionId') }), method: boundedString(params.method, 'params.method', EXTERNAL_CHROME_MAX_LABEL_LENGTH), params: payload }
    }
    case 'browser.detached': {
      strictKeys(params, 'params', ['protocolVersion', 'leaseId', 'leaseEpoch', 'tabId', 'reason'])
      return { ...parseLeaseRouting(params, expected), tabId: integer(params.tabId, 'params.tabId'), reason: boundedString(params.reason, 'params.reason', EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH) }
    }
    case 'browser.userControl': {
      strictKeys(params, 'params', ['protocolVersion', 'leaseId', 'leaseEpoch', 'tabId', 'controlEpoch', 'event', 'at'])
      if (params.event !== 'pointer' && params.event !== 'key' && params.event !== 'wheel' && params.event !== 'touch') fail('invalid-params', 'params.event is unknown', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      return { ...parseLeaseRouting(params, expected), tabId: integer(params.tabId, 'params.tabId'), controlEpoch: integer(params.controlEpoch, 'params.controlEpoch', 0), event: params.event, at: boundedString(params.at, 'params.at', EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH) }
    }
    case 'browser.tabChanged': {
      strictKeys(params, 'params', ['protocolVersion', 'leaseId', 'leaseEpoch', 'tabId', 'change'])
      const change = object(params.change, 'params.change')
      strictKeys(change, 'params.change', [], ['windowId', 'url', 'title', 'active', 'loading'])
      if (Object.keys(change).length === 0) fail('invalid-params', 'params.change must not be empty', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      return { ...parseLeaseRouting(params, expected), tabId: integer(params.tabId, 'params.tabId'), change: {
        ...(change.windowId === undefined ? {} : { windowId: integer(change.windowId, 'params.change.windowId') }),
        ...(change.url === undefined ? {} : { url: boundedString(change.url, 'params.change.url', EXTERNAL_CHROME_MAX_URL_LENGTH) }),
        ...(change.title === undefined ? {} : { title: boundedString(change.title, 'params.change.title', EXTERNAL_CHROME_MAX_LABEL_LENGTH, true) }),
        ...(change.active === undefined ? {} : { active: boolean(change.active, 'params.change.active') }),
        ...(change.loading === undefined ? {} : { loading: boolean(change.loading, 'params.change.loading') }),
      } }
    }
    case 'browser.downloadChanged': {
      strictKeys(params, 'params', ['protocolVersion', 'leaseId', 'leaseEpoch', 'tabId', 'downloadId', 'state', 'danger', 'bytesReceived', 'totalBytes'], ['filename'])
      if (params.state !== 'in-progress' && params.state !== 'complete' && params.state !== 'interrupted') fail('invalid-params', 'params.state is unknown', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      if (params.danger !== 'safe' && params.danger !== 'dangerous' && params.danger !== 'unknown') fail('invalid-params', 'params.danger is unknown', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      return { ...parseLeaseRouting(params, expected), tabId: integer(params.tabId, 'params.tabId'), downloadId: integer(params.downloadId, 'params.downloadId'), state: params.state, danger: params.danger, ...(params.filename === undefined ? {} : { filename: boundedString(params.filename, 'params.filename', EXTERNAL_CHROME_MAX_URL_LENGTH) }), bytesReceived: finiteNumber(params.bytesReceived, 'params.bytesReceived'), totalBytes: finiteNumber(params.totalBytes, 'params.totalBytes') }
    }
    case 'browser.leaseChanged': {
      strictKeys(params, 'params', ['protocolVersion', 'leaseId', 'leaseEpoch', 'state', 'tabIds'])
      if (params.state !== 'acquired' && params.state !== 'released') fail('invalid-params', 'params.state is unknown', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      return {
        ...parseLeaseRouting(params, expected), state: params.state,
        tabIds: parseNumericIdArray(params.tabIds, 'params.tabIds', params.state === 'released'),
      }
    }
    case 'runtime.goodbye': {
      strictKeys(params, 'params', ['protocolVersion', 'reason'])
      return { protocolVersion: protocolVersion(params.protocolVersion, expected), reason: boundedString(params.reason, 'params.reason', EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH) }
    }
  }
}

function errorFamilyCode(code: ExternalChromeErrorCode): number {
  if ((EXTERNAL_CHROME_TRANSPORT_ERROR_CODES as readonly string[]).includes(code)) return EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.transportOrAuthentication
  if ((EXTERNAL_CHROME_PROTOCOL_ERROR_CODES as readonly string[]).includes(code)) return EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.protocolOrVersion
  if ((EXTERNAL_CHROME_LEASE_ERROR_CODES as readonly string[]).includes(code)) return EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.leaseOrScope
  if ((EXTERNAL_CHROME_TARGET_ERROR_CODES as readonly string[]).includes(code)) return EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.targetOrDebugger
  return EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.execution
}

function parseError(value: unknown): ExternalChromeJsonRpcError {
  const error = object(value, 'error')
  strictKeys(error, 'error', ['code', 'message'], ['data'])
  const code = integer(error.code, 'error.code', -32_768, -1)
  const message = boundedString(error.message, 'error.message', EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH)
  const standardCodes: number[] = [-32700, -32600, -32601, -32602, -32603]
  if (error.data === undefined) {
    if (!standardCodes.includes(code)) fail('invalid-result', 'custom JSON-RPC errors require error.data')
    return { code, message }
  }
  const data = object(error.data, 'error.data')
  strictKeys(data, 'error.data', ['code', 'retryable'], ['requestId', 'leaseId', 'leaseEpoch', 'tabId', 'detail'])
  const allCodes = [
    ...EXTERNAL_CHROME_TRANSPORT_ERROR_CODES,
    ...EXTERNAL_CHROME_PROTOCOL_ERROR_CODES,
    ...EXTERNAL_CHROME_LEASE_ERROR_CODES,
    ...EXTERNAL_CHROME_TARGET_ERROR_CODES,
    ...EXTERNAL_CHROME_EXECUTION_ERROR_CODES,
  ] as readonly string[]
  if (typeof data.code !== 'string' || !allCodes.includes(data.code)) fail('invalid-result', 'error.data.code is unknown')
  const forgeCode = data.code as ExternalChromeErrorCode
  if (code !== errorFamilyCode(forgeCode)) fail('invalid-result', 'error.code does not match error.data.code family')
  return { code, message, data: {
    code: forgeCode,
    retryable: boolean(data.retryable, 'error.data.retryable'),
    ...(data.requestId === undefined ? {} : { requestId: identifier(data.requestId, 'error.data.requestId') }),
    ...(data.leaseId === undefined ? {} : { leaseId: identifier(data.leaseId, 'error.data.leaseId') }),
    ...(data.leaseEpoch === undefined ? {} : { leaseEpoch: integer(data.leaseEpoch, 'error.data.leaseEpoch', 1) }),
    ...(data.tabId === undefined ? {} : { tabId: integer(data.tabId, 'error.data.tabId') }),
    ...(data.detail === undefined ? {} : { detail: boundedString(data.detail, 'error.data.detail', EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH) }),
  } }
}

export function parseExternalChromeJsonRpcFrame(
  frame: string,
  options: ParseExternalChromeJsonRpcOptions = {},
): ExternalChromeJsonRpcMessage {
  if (typeof frame !== 'string') fail('malformed-json', 'frame must be a string', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.parseError)
  if (utf8ByteLength(frame) > EXTERNAL_CHROME_MAX_MESSAGE_BYTES) {
    fail('frame-too-large', `frame exceeds ${EXTERNAL_CHROME_MAX_MESSAGE_BYTES} bytes`, EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.transportOrAuthentication)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(frame)
  } catch {
    return fail('malformed-json', 'frame is not valid JSON', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.parseError)
  }
  const envelope = object(parsed, 'message')
  if (envelope.jsonrpc !== '2.0') fail('invalid-envelope', 'message.jsonrpc must equal 2.0')

  if (typeof envelope.method === 'string') {
    if ((EXTERNAL_CHROME_REQUEST_METHODS as readonly string[]).includes(envelope.method)) {
      strictKeys(envelope, 'message', ['jsonrpc', 'id', 'method', 'params'])
      const method = envelope.method as ExternalChromeRequestMethod
      return { jsonrpc: '2.0', id: identifier(envelope.id, 'message.id'), method, params: parseRequestParams(method, envelope.params, options.protocolVersion) } as ExternalChromeRequest
    }
    if ((EXTERNAL_CHROME_NOTIFICATION_METHODS as readonly string[]).includes(envelope.method)) {
      strictKeys(envelope, 'message', ['jsonrpc', 'method', 'params'])
      const method = envelope.method as ExternalChromeNotificationMethod
      return { jsonrpc: '2.0', method, params: parseNotificationParams(method, envelope.params, options.protocolVersion) } as ExternalChromeNotification
    }
    return fail('unknown-method', `message.method ${envelope.method} is unknown`, EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.methodNotFound)
  }

  if ('result' in envelope) {
    strictKeys(envelope, 'message', ['jsonrpc', 'id', 'result'])
    if (options.expectedResponseMethod === undefined) fail('response-method-required', 'a success response requires expectedResponseMethod')
    return { jsonrpc: '2.0', id: identifier(envelope.id, 'message.id'), result: parseResult(options.expectedResponseMethod, envelope.result, options.protocolVersion) } as ExternalChromeSuccessResponse
  }
  if ('error' in envelope) {
    strictKeys(envelope, 'message', ['jsonrpc', 'id', 'error'])
    return { jsonrpc: '2.0', id: identifier(envelope.id, 'message.id'), error: parseError(envelope.error) }
  }
  return fail('invalid-envelope', 'message must be a request, notification, success response, or error response')
}
