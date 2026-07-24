import {
  BROWSER_AUTOMATION_OPERATIONS,
  EXTERNAL_CHROME_M0_SUPPORTED_OPERATIONS,
  isBrowserAutomationOperation,
  parseBrowserAutomationInput,
  type BrowserAutomationFailure,
  type BrowserAutomationInputByOperation,
  type BrowserAutomationOperation,
  type BrowserAutomationResultByOperation,
} from './browser-automation.js'

/** Stable identity derived from Forge's pinned offline public manifest key. */
export const EXTERNAL_CHROME_EXTENSION_ID = 'fcchfcnadajoejfbiclihglkmbcfhajd'
export const EXTERNAL_CHROME_EXTENSION_ORIGIN = `chrome-extension://${EXTERNAL_CHROME_EXTENSION_ID}/`
export const EXTERNAL_CHROME_NATIVE_HOST_NAME = 'com.forge.external_chrome'

export const EXTERNAL_CHROME_PROTOCOL_MIN_VERSION = 1
export const EXTERNAL_CHROME_PROTOCOL_MAX_VERSION = 1
export const EXTERNAL_CHROME_PROTOCOL_VERSIONS = [1] as const
export type ExternalChromeProtocolVersion = (typeof EXTERNAL_CHROME_PROTOCOL_VERSIONS)[number]

/** Lower Forge bounds apply before the native-messaging transport's platform bounds. */
export const EXTERNAL_CHROME_MAX_MESSAGE_BYTES = 1 * 1_024 * 1_024
export const EXTERNAL_CHROME_MAX_NATIVE_INBOUND_FRAME_BYTES = 64 * 1_024 * 1_024
export const EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES = 1 * 1_024 * 1_024
export const EXTERNAL_CHROME_MAX_ARRAY_ITEMS = 256
export const EXTERNAL_CHROME_MAX_CANDIDATE_TABS = 128
export const EXTERNAL_CHROME_MAX_OBJECT_PROPERTIES = 128
export const EXTERNAL_CHROME_MAX_JSON_DEPTH = 32
export const EXTERNAL_CHROME_MAX_STRING_LENGTH = 256 * 1_024
export const EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH = 128
export const EXTERNAL_CHROME_MAX_LABEL_LENGTH = 512
export const EXTERNAL_CHROME_MAX_URL_LENGTH = 2_048
export const EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH = 1_024

export const EXTERNAL_CHROME_REQUEST_METHODS = [
  'forge.runtime.hello',
  'forge.runtime.ping',
  'forge.browser.listCandidates',
  'forge.browser.claim',
  'forge.browser.create',
  'forge.browser.release',
  'forge.browser.execute',
  'forge.browser.turnEnded',
  'forge.runtime.prepareUpdate',
  'forge.runtime.reload',
] as const

export const EXTERNAL_CHROME_NOTIFICATION_METHODS = [
  'browser.cdpEvent',
  'browser.detached',
  'browser.userControl',
  'browser.tabChanged',
  'browser.downloadChanged',
  'runtime.goodbye',
] as const

export const EXTERNAL_CHROME_METHODS = [
  ...EXTERNAL_CHROME_REQUEST_METHODS,
  ...EXTERNAL_CHROME_NOTIFICATION_METHODS,
] as const

export type ExternalChromeRequestMethod = (typeof EXTERNAL_CHROME_REQUEST_METHODS)[number]
export type ExternalChromeNotificationMethod = (typeof EXTERNAL_CHROME_NOTIFICATION_METHODS)[number]
export type ExternalChromeMethod = (typeof EXTERNAL_CHROME_METHODS)[number]

export const EXTERNAL_CHROME_SUPPORTED_OPERATIONS = EXTERNAL_CHROME_M0_SUPPORTED_OPERATIONS
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
  'attachment-required',
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
  groups: boolean
}

export interface ExternalChromeHelloParams {
  protocol: ExternalChromeProtocolRange
  shellAbi: number
  payloadVersion: string
  extensionId: string
  extensionInstanceId: string
  profileAlias?: string
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

export interface ExternalChromeCandidateTab {
  windowId: number
  tabId: number
  groupId: number | null
  title: string
  origin: string
  active: boolean
  attached: boolean
  restricted: boolean
}

export interface ExternalChromeCandidateGroup {
  groupId: number
  title: string
  collapsed: boolean
}

export interface ExternalChromeCandidateWindow {
  windowId: number
  focused: boolean
  groups: ExternalChromeCandidateGroup[]
  tabs: ExternalChromeCandidateTab[]
}

export interface ExternalChromeListCandidatesParams {
  protocolVersion: ExternalChromeProtocolVersion
  sessionAgentId: string
}

export interface ExternalChromeListCandidatesResult {
  protocolVersion: ExternalChromeProtocolVersion
  extensionInstanceId: string
  profileAlias?: string
  windows: ExternalChromeCandidateWindow[]
}

export type ExternalChromeChildPolicy = 'manual' | 'include-opened-by-leased-tabs'

export interface ExternalChromeLeaseRouting {
  protocolVersion: ExternalChromeProtocolVersion
  leaseId: string
  leaseEpoch: number
}

export interface ExternalChromeSelectedTab {
  windowId: number
  tabId: number
  groupId: number | null
  title: string
  url: string
  origin: string
  active: boolean
}

export interface ExternalChromeClaimParams extends ExternalChromeLeaseRouting {
  sessionAgentId: string
  tabIds: number[]
  groupId?: number
  childPolicy: ExternalChromeChildPolicy
}

export interface ExternalChromeClaimResult extends ExternalChromeLeaseRouting {
  sessionAgentId: string
  extensionInstanceId: string
  groupId: number | null
  childPolicy: ExternalChromeChildPolicy
  tabs: ExternalChromeSelectedTab[]
}

export interface ExternalChromeCreateParams extends ExternalChromeLeaseRouting {
  sessionAgentId: string
  url?: string
  groupTitle: string
}

export interface ExternalChromeCreateResult extends ExternalChromeLeaseRouting {
  sessionAgentId: string
  extensionInstanceId: string
  groupId: number
  tab: ExternalChromeSelectedTab
}

export interface ExternalChromeReleaseParams extends ExternalChromeLeaseRouting {
  reason: string
}

export interface ExternalChromeReleaseResult extends ExternalChromeLeaseRouting {
  releasedTabIds: number[]
}

type ExternalChromeOperationInput<Operation extends BrowserAutomationOperation> = Omit<
  BrowserAutomationInputByOperation[Operation],
  'hostKind' | 'tabId'
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

export interface ExternalChromeTurnEndedParams extends ExternalChromeLeaseRouting {
  turnId: string
  finalTabs: number[]
  handoffTabs: number[]
}

export interface ExternalChromeTurnEndedResult extends ExternalChromeLeaseRouting {
  turnId: string
  releasedTabs: number[]
  handoffTabs: number[]
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
    groupId?: number | null
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

export interface ExternalChromeGoodbyeParams {
  protocolVersion: ExternalChromeProtocolVersion
  reason: string
}

export interface ExternalChromeRequestParamsByMethod {
  'forge.runtime.hello': ExternalChromeHelloParams
  'forge.runtime.ping': ExternalChromePingParams
  'forge.browser.listCandidates': ExternalChromeListCandidatesParams
  'forge.browser.claim': ExternalChromeClaimParams
  'forge.browser.create': ExternalChromeCreateParams
  'forge.browser.release': ExternalChromeReleaseParams
  'forge.browser.execute': ExternalChromeExecuteParams
  'forge.browser.turnEnded': ExternalChromeTurnEndedParams
  'forge.runtime.prepareUpdate': ExternalChromePrepareUpdateParams
  'forge.runtime.reload': ExternalChromeReloadParams
}

export interface ExternalChromeResultByMethod {
  'forge.runtime.hello': ExternalChromeWelcomeResult
  'forge.runtime.ping': ExternalChromePongResult
  'forge.browser.listCandidates': ExternalChromeListCandidatesResult
  'forge.browser.claim': ExternalChromeClaimResult
  'forge.browser.create': ExternalChromeCreateResult
  'forge.browser.release': ExternalChromeReleaseResult
  'forge.browser.execute': ExternalChromeExecuteResult
  'forge.browser.turnEnded': ExternalChromeTurnEndedResult
  'forge.runtime.prepareUpdate': ExternalChromePrepareUpdateResult
  'forge.runtime.reload': ExternalChromeReloadResult
}

export interface ExternalChromeNotificationParamsByMethod {
  'browser.cdpEvent': ExternalChromeCdpEventParams
  'browser.detached': ExternalChromeDetachedParams
  'browser.userControl': ExternalChromeUserControlParams
  'browser.tabChanged': ExternalChromeTabChangedParams
  'browser.downloadChanged': ExternalChromeDownloadChangedParams
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
    const candidate = EXTERNAL_CHROME_PROTOCOL_VERSIONS[index]
    if (candidate >= minimum && candidate <= maximum) return candidate
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
  const keys = ['resize', 'recording', 'downloadEvents', 'downloadArtifacts', 'downloadOpen', 'oopif', 'humanInterruption', 'groups'] as const
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
    const shouldSupport = (EXTERNAL_CHROME_SUPPORTED_OPERATIONS as readonly BrowserAutomationOperation[]).includes(entry.operation)
    if (entry.supported !== shouldSupport) fail('invalid-params', `params.operations support for ${entry.operation} contradicts V1 capability`, EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
  }
  return entries
}

function parseMethods(value: unknown): ExternalChromeMethod[] {
  const methods = uniqueArray(
    boundedArray(value, 'params.methods', EXTERNAL_CHROME_METHODS.length).map((entry, index) => {
      if (typeof entry !== 'string' || !(EXTERNAL_CHROME_METHODS as readonly string[]).includes(entry)) {
        return fail('unknown-method', `params.methods[${index}] is unknown`, EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.methodNotFound)
      }
      return entry as ExternalChromeMethod
    }),
    'params.methods',
  )
  if (methods.length !== EXTERNAL_CHROME_METHODS.length || EXTERNAL_CHROME_METHODS.some((method) => !methods.includes(method))) {
    fail('invalid-params', 'params.methods must contain every V1 method exactly once', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
  }
  return methods
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
  const parsed = uniqueArray(boundedArray(value, path, EXTERNAL_CHROME_MAX_CANDIDATE_TABS).map((entry, index) => integer(entry, `${path}[${index}]`)), path)
  if (!allowEmpty && parsed.length === 0) fail('invalid-envelope', `${path} must not be empty`)
  return parsed
}

function parseSelectedTab(value: unknown, path: string): ExternalChromeSelectedTab {
  const tab = object(value, path)
  strictKeys(tab, path, ['windowId', 'tabId', 'groupId', 'title', 'url', 'origin', 'active'])
  return {
    windowId: integer(tab.windowId, `${path}.windowId`),
    tabId: integer(tab.tabId, `${path}.tabId`),
    groupId: tab.groupId === null ? null : integer(tab.groupId, `${path}.groupId`),
    title: boundedString(tab.title, `${path}.title`, EXTERNAL_CHROME_MAX_LABEL_LENGTH, true),
    url: boundedString(tab.url, `${path}.url`, EXTERNAL_CHROME_MAX_URL_LENGTH),
    origin: boundedString(tab.origin, `${path}.origin`, EXTERNAL_CHROME_MAX_URL_LENGTH),
    active: boolean(tab.active, `${path}.active`),
  }
}

function parseChildPolicy(value: unknown, path: string): ExternalChromeChildPolicy {
  if (value !== 'manual' && value !== 'include-opened-by-leased-tabs') fail('invalid-envelope', `${path} is not a child policy`)
  return value
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
  ]
  if (!knownCodes.includes(error.code)) fail('invalid-result', `${path}.code is unknown`)
  const details = error.details === undefined ? undefined : validateBoundedJson(error.details, `${path}.details`)
  if (details !== undefined && (typeof details !== 'object' || details === null || Array.isArray(details))) fail('invalid-result', `${path}.details must be an object`)
  return {
    code: error.code as BrowserAutomationFailure['code'],
    message: boundedString(error.message, `${path}.message`, EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH),
    retryable: boolean(error.retryable, `${path}.retryable`),
    ...(details === undefined ? {} : { details: details as BrowserAutomationFailure['details'] }),
  }
}

function parseHelloParams(value: unknown): ExternalChromeHelloParams {
  const params = object(value, 'params')
  strictKeys(params, 'params', ['protocol', 'shellAbi', 'payloadVersion', 'extensionId', 'extensionInstanceId', 'chromeVersion', 'methods', 'maxMessageBytes', 'operations', 'features'], ['profileAlias'])
  const extensionId = identifier(params.extensionId, 'params.extensionId')
  if (extensionId !== EXTERNAL_CHROME_EXTENSION_ID) fail('invalid-params', 'params.extensionId does not match the pinned identity', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
  return {
    protocol: parseProtocolRange(params.protocol),
    shellAbi: integer(params.shellAbi, 'params.shellAbi', 1),
    payloadVersion: identifier(params.payloadVersion, 'params.payloadVersion'),
    extensionId,
    extensionInstanceId: identifier(params.extensionInstanceId, 'params.extensionInstanceId'),
    ...(params.profileAlias === undefined ? {} : { profileAlias: boundedString(params.profileAlias, 'params.profileAlias', EXTERNAL_CHROME_MAX_LABEL_LENGTH) }),
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
    case 'forge.browser.listCandidates': {
      strictKeys(params, 'params', ['protocolVersion', 'sessionAgentId'])
      return { protocolVersion: protocolVersion(params.protocolVersion, expected), sessionAgentId: identifier(params.sessionAgentId, 'params.sessionAgentId') }
    }
    case 'forge.browser.claim': {
      strictKeys(params, 'params', ['protocolVersion', 'sessionAgentId', 'leaseId', 'leaseEpoch', 'tabIds', 'childPolicy'], ['groupId'])
      return { ...parseLeaseRouting(params, expected), sessionAgentId: identifier(params.sessionAgentId, 'params.sessionAgentId'), tabIds: parseNumericIdArray(params.tabIds, 'params.tabIds', false), ...(params.groupId === undefined ? {} : { groupId: integer(params.groupId, 'params.groupId') }), childPolicy: parseChildPolicy(params.childPolicy, 'params.childPolicy') }
    }
    case 'forge.browser.create': {
      strictKeys(params, 'params', ['protocolVersion', 'sessionAgentId', 'leaseId', 'leaseEpoch', 'groupTitle'], ['url'])
      return { ...parseLeaseRouting(params, expected), sessionAgentId: identifier(params.sessionAgentId, 'params.sessionAgentId'), ...(params.url === undefined ? {} : { url: boundedString(params.url, 'params.url', EXTERNAL_CHROME_MAX_URL_LENGTH) }), groupTitle: boundedString(params.groupTitle, 'params.groupTitle', EXTERNAL_CHROME_MAX_LABEL_LENGTH) }
    }
    case 'forge.browser.release': {
      strictKeys(params, 'params', ['protocolVersion', 'leaseId', 'leaseEpoch', 'reason'])
      return { ...parseLeaseRouting(params, expected), reason: boundedString(params.reason, 'params.reason', EXTERNAL_CHROME_MAX_SAFE_DETAIL_LENGTH) }
    }
    case 'forge.browser.execute': {
      strictKeys(params, 'params', ['protocolVersion', 'requestId', 'leaseId', 'leaseEpoch', 'tabId', 'operation', 'input', 'deadlineAt'])
      if (!isBrowserAutomationOperation(params.operation)) fail('invalid-params', 'params.operation is unknown', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      const rawInput = object(params.input, 'params.input')
      if ('tabId' in rawInput || 'hostKind' in rawInput) fail('invalid-params', 'params.input must not duplicate routing fields', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      let parsedInput: BrowserAutomationInputByOperation[BrowserAutomationOperation]
      try {
        parsedInput = parseBrowserAutomationInput(params.operation, rawInput)
      } catch {
        return fail('invalid-params', 'params.input is invalid for the operation', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      }
      return { ...parseLeaseRouting(params, expected), requestId: identifier(params.requestId, 'params.requestId'), tabId: integer(params.tabId, 'params.tabId'), operation: params.operation, input: parsedInput, deadlineAt: boundedString(params.deadlineAt, 'params.deadlineAt', EXTERNAL_CHROME_MAX_IDENTIFIER_LENGTH) } as ExternalChromeExecuteParams
    }
    case 'forge.browser.turnEnded': {
      strictKeys(params, 'params', ['protocolVersion', 'leaseId', 'leaseEpoch', 'turnId', 'finalTabs', 'handoffTabs'])
      const finalTabs = parseNumericIdArray(params.finalTabs, 'params.finalTabs')
      const handoffTabs = parseNumericIdArray(params.handoffTabs, 'params.handoffTabs')
      if (finalTabs.some((tabId) => handoffTabs.includes(tabId))) fail('invalid-params', 'finalTabs and handoffTabs must be disjoint', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      return { ...parseLeaseRouting(params, expected), turnId: identifier(params.turnId, 'params.turnId'), finalTabs, handoffTabs }
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

function parseCandidateTab(value: unknown, path: string): ExternalChromeCandidateTab {
  const tab = object(value, path)
  strictKeys(tab, path, ['windowId', 'tabId', 'groupId', 'title', 'origin', 'active', 'attached', 'restricted'])
  return {
    windowId: integer(tab.windowId, `${path}.windowId`), tabId: integer(tab.tabId, `${path}.tabId`),
    groupId: tab.groupId === null ? null : integer(tab.groupId, `${path}.groupId`),
    title: boundedString(tab.title, `${path}.title`, EXTERNAL_CHROME_MAX_LABEL_LENGTH, true),
    origin: boundedString(tab.origin, `${path}.origin`, EXTERNAL_CHROME_MAX_URL_LENGTH),
    active: boolean(tab.active, `${path}.active`), attached: boolean(tab.attached, `${path}.attached`), restricted: boolean(tab.restricted, `${path}.restricted`),
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
  switch (operation) {
    case 'status':
      strictKeys(result, 'result.result', ['available', 'host', 'panelVisible', 'panelRevealRequested', 'physicalTabVisible', 'selectedTab'])
      boolean(result.available, 'result.result.available')
      boolean(result.panelVisible, 'result.result.panelVisible')
      boolean(result.panelRevealRequested, 'result.result.panelRevealRequested')
      boolean(result.physicalTabVisible, 'result.result.physicalTabVisible')
      object(result.host, 'result.result.host')
      if (result.selectedTab !== null) object(result.selectedTab, 'result.result.selectedTab')
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
      strictKeys(result, 'result.result', ['tabId', 'url', 'title', 'loading', 'viewportSetting', 'viewport', 'visibleText', 'interactiveElements', 'accessibility', 'consoleEntries', 'networkEntries', 'actionTimeline', 'screenshot'])
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
    case 'forge.browser.listCandidates': {
      strictKeys(result, 'result', ['protocolVersion', 'extensionInstanceId', 'windows'], ['profileAlias'])
      const windows = boundedArray(result.windows, 'result.windows').map((entry, windowIndex) => {
        const window = object(entry, `result.windows[${windowIndex}]`)
        strictKeys(window, `result.windows[${windowIndex}]`, ['windowId', 'focused', 'groups', 'tabs'])
        const groups = boundedArray(window.groups, `result.windows[${windowIndex}].groups`).map((groupEntry, groupIndex) => {
          const group = object(groupEntry, `result.windows[${windowIndex}].groups[${groupIndex}]`)
          strictKeys(group, `result.windows[${windowIndex}].groups[${groupIndex}]`, ['groupId', 'title', 'collapsed'])
          return { groupId: integer(group.groupId, `result.windows[${windowIndex}].groups[${groupIndex}].groupId`), title: boundedString(group.title, `result.windows[${windowIndex}].groups[${groupIndex}].title`, EXTERNAL_CHROME_MAX_LABEL_LENGTH, true), collapsed: boolean(group.collapsed, `result.windows[${windowIndex}].groups[${groupIndex}].collapsed`) }
        })
        const tabs = boundedArray(window.tabs, `result.windows[${windowIndex}].tabs`, EXTERNAL_CHROME_MAX_CANDIDATE_TABS).map((tab, tabIndex) => parseCandidateTab(tab, `result.windows[${windowIndex}].tabs[${tabIndex}]`))
        return { windowId: integer(window.windowId, `result.windows[${windowIndex}].windowId`), focused: boolean(window.focused, `result.windows[${windowIndex}].focused`), groups, tabs }
      })
      if (windows.reduce((count, window) => count + window.tabs.length, 0) > EXTERNAL_CHROME_MAX_CANDIDATE_TABS) fail('invalid-result', 'candidate tab total exceeds bound')
      return { protocolVersion: protocolVersion(result.protocolVersion, expected), extensionInstanceId: identifier(result.extensionInstanceId, 'result.extensionInstanceId'), ...(result.profileAlias === undefined ? {} : { profileAlias: boundedString(result.profileAlias, 'result.profileAlias', EXTERNAL_CHROME_MAX_LABEL_LENGTH) }), windows }
    }
    case 'forge.browser.claim': {
      strictKeys(result, 'result', ['protocolVersion', 'sessionAgentId', 'leaseId', 'leaseEpoch', 'extensionInstanceId', 'groupId', 'childPolicy', 'tabs'])
      return { ...parseLeaseRouting(result, expected), sessionAgentId: identifier(result.sessionAgentId, 'result.sessionAgentId'), extensionInstanceId: identifier(result.extensionInstanceId, 'result.extensionInstanceId'), groupId: result.groupId === null ? null : integer(result.groupId, 'result.groupId'), childPolicy: parseChildPolicy(result.childPolicy, 'result.childPolicy'), tabs: boundedArray(result.tabs, 'result.tabs', EXTERNAL_CHROME_MAX_CANDIDATE_TABS).map((tab, index) => parseSelectedTab(tab, `result.tabs[${index}]`)) }
    }
    case 'forge.browser.create': {
      strictKeys(result, 'result', ['protocolVersion', 'sessionAgentId', 'leaseId', 'leaseEpoch', 'extensionInstanceId', 'groupId', 'tab'])
      return { ...parseLeaseRouting(result, expected), sessionAgentId: identifier(result.sessionAgentId, 'result.sessionAgentId'), extensionInstanceId: identifier(result.extensionInstanceId, 'result.extensionInstanceId'), groupId: integer(result.groupId, 'result.groupId'), tab: parseSelectedTab(result.tab, 'result.tab') }
    }
    case 'forge.browser.release': {
      strictKeys(result, 'result', ['protocolVersion', 'leaseId', 'leaseEpoch', 'releasedTabIds'])
      return { ...parseLeaseRouting(result, expected), releasedTabIds: parseNumericIdArray(result.releasedTabIds, 'result.releasedTabIds') }
    }
    case 'forge.browser.execute': return parseExecuteResult(value, expected)
    case 'forge.browser.turnEnded': {
      strictKeys(result, 'result', ['protocolVersion', 'leaseId', 'leaseEpoch', 'turnId', 'releasedTabs', 'handoffTabs'])
      return { ...parseLeaseRouting(result, expected), turnId: identifier(result.turnId, 'result.turnId'), releasedTabs: parseNumericIdArray(result.releasedTabs, 'result.releasedTabs'), handoffTabs: parseNumericIdArray(result.handoffTabs, 'result.handoffTabs') }
    }
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
      strictKeys(change, 'params.change', [], ['windowId', 'groupId', 'url', 'title', 'active', 'loading'])
      if (Object.keys(change).length === 0) fail('invalid-params', 'params.change must not be empty', EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.invalidParams)
      return { ...parseLeaseRouting(params, expected), tabId: integer(params.tabId, 'params.tabId'), change: {
        ...(change.windowId === undefined ? {} : { windowId: integer(change.windowId, 'params.change.windowId') }),
        ...(change.groupId === undefined ? {} : { groupId: change.groupId === null ? null : integer(change.groupId, 'params.change.groupId') }),
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
