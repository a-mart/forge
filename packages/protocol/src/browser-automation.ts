/*
 * Browser operation semantics, bounds, and viewport presets are adapted from
 * T3 Code at 9a0a07167f0623c3a7db0ffeff2e3939760309df (MIT). The final product
 * distribution must retain the corresponding third-party notice.
 */

export const BROWSER_AUTOMATION_OPERATIONS = [
  'status',
  'open',
  'navigate',
  'resize',
  'snapshot',
  'click',
  'type',
  'press',
  'scroll',
  'evaluate',
  'waitFor',
  'recordingStart',
  'recordingStop',
] as const

export type BrowserAutomationOperation = (typeof BROWSER_AUTOMATION_OPERATIONS)[number]

export const BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS = 15_000
export const BROWSER_AUTOMATION_MAX_TIMEOUT_MS = 60_000
export const BROWSER_AUTOMATION_MAX_URL_LENGTH = 2_048
export const BROWSER_AUTOMATION_MAX_EVALUATE_BYTES = 64 * 1_024
export const BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_LENGTH = 20_000
export const BROWSER_AUTOMATION_MAX_INTERACTIVE_ELEMENTS = 200
export const BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES = 200
export const BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH = 1_280
export const BROWSER_AUTOMATION_MAX_SAFE_ACTIONS = 100
export const BROWSER_VIEWPORT_MIN_DIMENSION = 240
export const BROWSER_VIEWPORT_MAX_DIMENSION = 3_840
export const BROWSER_VIEWPORT_MAX_AREA = 3_840 * 2_160

export const BROWSER_VIEWPORT_PRESETS = {
  'iphone-se': { label: 'iPhone SE', category: 'phone', width: 375, height: 667 },
  'iphone-xr': { label: 'iPhone XR', category: 'phone', width: 414, height: 896 },
  'iphone-12-pro': { label: 'iPhone 12 Pro', category: 'phone', width: 390, height: 844 },
  'iphone-14-pro-max': { label: 'iPhone 14 Pro Max', category: 'phone', width: 430, height: 932 },
  'pixel-7': { label: 'Pixel 7', category: 'phone', width: 412, height: 915 },
  'samsung-galaxy-s8-plus': { label: 'Samsung Galaxy S8+', category: 'phone', width: 360, height: 740 },
  'samsung-galaxy-s20-ultra': { label: 'Samsung Galaxy S20 Ultra', category: 'phone', width: 412, height: 915 },
  'ipad-mini': { label: 'iPad Mini', category: 'tablet', width: 768, height: 1_024 },
  'ipad-air': { label: 'iPad Air', category: 'tablet', width: 820, height: 1_180 },
  'ipad-pro': { label: 'iPad Pro', category: 'tablet', width: 1_024, height: 1_366 },
  'surface-pro-7': { label: 'Surface Pro 7', category: 'tablet', width: 912, height: 1_368 },
  'surface-duo': { label: 'Surface Duo', category: 'phone', width: 540, height: 720 },
  'galaxy-z-fold-5': { label: 'Galaxy Z Fold 5', category: 'phone', width: 344, height: 882 },
  'asus-zenbook-fold': { label: 'Asus Zenbook Fold', category: 'tablet', width: 853, height: 1_280 },
  'samsung-galaxy-a51-71': { label: 'Samsung Galaxy A51/71', category: 'phone', width: 412, height: 914 },
  'nest-hub': { label: 'Nest Hub', category: 'tablet', width: 1_024, height: 600 },
  'nest-hub-max': { label: 'Nest Hub Max', category: 'tablet', width: 1_280, height: 800 },
} as const

export type BrowserViewportPresetId = keyof typeof BROWSER_VIEWPORT_PRESETS
export type BrowserViewportOrientation = 'portrait' | 'landscape'

export type BrowserViewportSetting =
  | { mode: 'fill' }
  | { mode: 'freeform'; width: number; height: number }
  | {
      mode: 'preset'
      presetId: BrowserViewportPresetId
      orientation: BrowserViewportOrientation
      width: number
      height: number
    }

export interface BrowserRenderedViewport {
  width: number
  height: number
  deviceScaleFactor: number
}

export type BrowserController = 'human' | 'agent' | 'none'
export type BrowserTabLifecycle = 'restoring' | 'loading' | 'ready' | 'failed' | 'closed'
/** Physical host mounting for a Forge browser session. Metadata may remain while unhosted. */
export type BrowserSessionHostingState = 'hosted' | 'unhosted' | 'removed'

export interface BrowserTabSnapshot {
  tabId: string
  sessionAgentId: string
  profileId: string
  url: string
  title: string
  lifecycle: BrowserTabLifecycle
  loading: boolean
  live: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoomFactor: number
  controller: BrowserController
  agentCursor: {
    x: number
    y: number
    phase: 'move' | 'click'
    sequence: number
    createdAt: string
  } | null
  recording: {
    recordingId: string
    startedAt: string
    mimeType: string
  } | null
  viewportSetting: BrowserViewportSetting
  renderedViewport: BrowserRenderedViewport | null
  /** Broker-reported physical webview presentation; absent in legacy persisted snapshots. */
  physicalVisible?: boolean
  error: { code: string; message: string } | null
  createdAt: string
  updatedAt: string
}

export interface BrowserSafeActionSummary {
  id: string
  operation: BrowserAutomationOperation
  tabId: string | null
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  url?: string
  title?: string
  dimensions?: { width: number; height: number }
  artifactPath?: string
  errorCode?: BrowserAutomationErrorCode
  startedAt: string
  completedAt?: string
  elapsedMs?: number
}

export interface BrowserPanelRevealIntent {
  /** Monotonic per-session token. A larger value always represents newer reveal intent. */
  sequence: number
  /** Last sequence presented by an authoritative Electron host. */
  acknowledgedSequence: number
  /** Tab that must be physically presented before this sequence is acknowledged. */
  tabId: string | null
}

export interface BrowserSessionSnapshot {
  schemaVersion: 1
  sessionAgentId: string
  profileId: string
  /** Controls whether the desktop host may mount physical webviews for this session. */
  hostingState: BrowserSessionHostingState
  tabs: BrowserTabSnapshot[]
  activeTabId: string | null
  defaultTabId: string | null
  panelVisible: boolean
  /** Durable reveal intent. Absence is a legacy snapshot with no pending reveal. */
  panelReveal?: BrowserPanelRevealIntent
  recentActions: BrowserSafeActionSummary[]
  revision: number
  createdAt: string
  updatedAt: string
}

/**
 * Renderer → backend physical-tab report. Membership, selection, panel, and
 * action history remain backend-owned; only matched tab runtime fields merge.
 */
export interface BrowserHostSessionStateReport {
  sessionAgentId: string
  profileId: string
  /** Canonical revision the host based this report on. Mismatches are rejected. */
  baseRevision: number
  tabs: BrowserTabSnapshot[]
}

export type BrowserHostSessionStateReportResult =
  | {
      sessionAgentId: string
      profileId: string
      status: 'accepted' | 'revision-conflict'
      /** Canonical state after acceptance, or the state the host must rebase onto. */
      snapshot: BrowserSessionSnapshot
    }
  | {
      sessionAgentId: string
      profileId: string
      status: 'rejected'
      reason: 'invalid-report' | 'session-unavailable' | 'tab-unavailable'
      snapshot?: BrowserSessionSnapshot
    }

export type BrowserHostStateReportResult =
  | {
      hostId: string
      hostGeneration: number
      status: 'processed'
      sessions: BrowserHostSessionStateReportResult[]
    }
  | {
      hostId: string
      hostGeneration: number
      status: 'stale-host-generation'
      sessions: []
    }

export interface BrowserHostCapabilities {
  supportedOperations: BrowserAutomationOperation[]
  electronVersion: string
  chromiumVersion: string
  playwrightVersion: string
  maxResponseBytes: number
  supportsSandboxedWebviews: boolean
  supportsCapturePage: boolean
  supportsRecording: boolean
}

export interface BrowserHostRegistration {
  hostId: string
  clientInstanceId: string
  capabilities: BrowserHostCapabilities
  registeredAt: string
}

export interface BrowserHostConnectionSnapshot {
  connected: boolean
  hostId: string | null
  hostGeneration: number | null
  focused: boolean
  capabilities: BrowserHostCapabilities | null
  connectedAt: string | null
}

export type BrowserAutomationErrorCode =
  | 'unavailable-host'
  | 'unsupported-operation'
  | 'session-not-found'
  | 'tab-not-found'
  | 'tab-session-mismatch'
  | 'invalid-input'
  | 'invalid-url'
  | 'navigation-failed'
  | 'timeout'
  | 'control-interrupted'
  | 'target-not-found'
  | 'invalid-selector'
  | 'target-not-editable'
  | 'coordinates-outside-viewport'
  | 'evaluation-failed'
  | 'result-too-large'
  | 'response-too-large'
  | 'host-disconnected'
  | 'stale-host-generation'
  | 'malformed-response'
  | 'artifact-path-invalid'
  | 'recording-conflict'
  | 'recording-requires-visible-tab'
  | 'recording-not-found'
  | 'request-cancelled'
  | 'execution-failed'

export interface BrowserAutomationFailure {
  code: BrowserAutomationErrorCode
  message: string
  retryable: boolean
  details?: Record<string, string | number | boolean | null>
}

export interface BrowserTabTargetInput {
  tabId?: string
}

export type BrowserStatusInput = BrowserTabTargetInput

export interface BrowserOpenInput extends BrowserTabTargetInput {
  url?: string
  show: boolean
  reuseExistingTab: boolean
}

export interface BrowserNavigateInput extends BrowserTabTargetInput {
  url?: string
  environmentPort?: number
  environmentProtocol?: 'http' | 'https'
  path?: string
  readiness: 'load' | 'domContentLoaded' | 'none'
  timeoutMs: number
}

export type BrowserResizeInput = BrowserTabTargetInput & (
  | { mode: 'fill'; timeoutMs: number }
  | { mode: 'freeform'; width: number; height: number; timeoutMs: number }
  | {
      mode: 'preset'
      presetId: BrowserViewportPresetId
      orientation?: BrowserViewportOrientation
      timeoutMs: number
    }
)

export type BrowserSnapshotInput = BrowserTabTargetInput

export type BrowserClickInput = BrowserTabTargetInput & (
  | { locator: string; timeoutMs: number }
  | { selector: string; timeoutMs: number }
  | { x: number; y: number; timeoutMs: number }
)

export type BrowserTypeInput = BrowserTabTargetInput & {
  text: string
  clear: boolean
  timeoutMs: number
} & ({ locator: string; selector?: never } | { selector: string; locator?: never } | { locator?: never; selector?: never })

export interface BrowserPressInput extends BrowserTabTargetInput {
  key: string
  modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[]
}

export interface BrowserScrollInput extends BrowserTabTargetInput {
  deltaX?: number
  deltaY?: number
  locator?: string
  selector?: string
}

export interface BrowserEvaluateInput extends BrowserTabTargetInput {
  expression: string
  awaitPromise: boolean
  returnByValue: boolean
}

export interface BrowserWaitForInput extends BrowserTabTargetInput {
  locator?: string
  selector?: string
  text?: string
  urlIncludes?: string
  timeoutMs: number
}

export type BrowserRecordingStartInput = BrowserTabTargetInput

export interface BrowserRecordingStopInput extends BrowserTabTargetInput {
  recordingId?: string
}

export interface BrowserAutomationStatusResult {
  available: boolean
  host: BrowserHostConnectionSnapshot
  /** Legacy alias for physicalTabVisible. It is never canonical reveal intent. */
  panelVisible: boolean
  /** Canonical workspace reveal intent persisted by the backend. */
  panelRevealRequested: boolean
  /** Electron-authoritative physical presentation acknowledgement for selectedTab. */
  physicalTabVisible: boolean
  selectedTab: BrowserTabSnapshot | null
}

export interface BrowserOpenResult {
  tab: BrowserTabSnapshot
  created: boolean
  panelRevealRequested: boolean
}

export interface BrowserNavigateResult {
  tab: BrowserTabSnapshot
  readiness: BrowserNavigateInput['readiness']
}

export interface BrowserResizeResult {
  tabId: string
  setting: BrowserViewportSetting
  viewport: BrowserRenderedViewport
}

export interface BrowserSnapshotElement {
  tag: string
  role: string | null
  name: string
  selector: string
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserConsoleEntry {
  level: string
  text: string
  timestamp: string
  source?: string
}

export interface BrowserNetworkEntry {
  url: string
  method: string
  status: number | null
  failed: boolean
  errorText?: string
  timestamp: string
}

export interface BrowserActionTimelineEntry {
  id: string
  action: string
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  startedAt: string
  completedAt?: string
  errorCode?: BrowserAutomationErrorCode
}

export interface BrowserSnapshotResult {
  tabId: string
  url: string
  title: string
  loading: boolean
  viewportSetting: BrowserViewportSetting
  viewport: BrowserRenderedViewport
  visibleText: string
  interactiveElements: BrowserSnapshotElement[]
  accessibility: unknown
  consoleEntries: BrowserConsoleEntry[]
  networkEntries: BrowserNetworkEntry[]
  actionTimeline: BrowserActionTimelineEntry[]
  screenshot: {
    mimeType: 'image/png'
    data: string
    width: number
    height: number
  }
}

export interface BrowserClickResult {
  tabId: string
  point: { x: number; y: number }
}

export interface BrowserTypeResult {
  tabId: string
  characters: number
  cleared: boolean
}

export interface BrowserPressResult {
  tabId: string
  key: string
  modifiers: ('Alt' | 'Control' | 'Meta' | 'Shift')[]
}

export interface BrowserScrollResult {
  tabId: string
  deltaX: number
  deltaY: number
  scrollX: number
  scrollY: number
}

export interface BrowserEvaluateResult {
  tabId: string
  value?: unknown
  remoteObject?: {
    type: string
    subtype?: string
    description?: string
    objectId?: string
  }
  serializedBytes: number
}

export interface BrowserWaitForResult {
  tabId: string
  matched: true
  elapsedMs: number
}

export interface BrowserRecordingStatusResult {
  recordingId: string
  tabId: string
  recording: boolean
  startedAt: string
  mimeType: string
  width: number
  height: number
}

export interface BrowserRecordingArtifactResult {
  recordingId: string
  tabId: string
  path: string
  mimeType: string
  extension: string
  sizeBytes: number
  width: number
  height: number
  createdAt: string
}

export interface BrowserAutomationInputByOperation {
  status: BrowserStatusInput
  open: BrowserOpenInput
  navigate: BrowserNavigateInput
  resize: BrowserResizeInput
  snapshot: BrowserSnapshotInput
  click: BrowserClickInput
  type: BrowserTypeInput
  press: BrowserPressInput
  scroll: BrowserScrollInput
  evaluate: BrowserEvaluateInput
  waitFor: BrowserWaitForInput
  recordingStart: BrowserRecordingStartInput
  recordingStop: BrowserRecordingStopInput
}

export interface BrowserAutomationResultByOperation {
  status: BrowserAutomationStatusResult
  open: BrowserOpenResult
  navigate: BrowserNavigateResult
  resize: BrowserResizeResult
  snapshot: BrowserSnapshotResult
  click: BrowserClickResult
  type: BrowserTypeResult
  press: BrowserPressResult
  scroll: BrowserScrollResult
  evaluate: BrowserEvaluateResult
  waitFor: BrowserWaitForResult
  recordingStart: BrowserRecordingStatusResult
  recordingStop: BrowserRecordingArtifactResult
}

export type BrowserAutomationInput = {
  [Operation in BrowserAutomationOperation]: {
    operation: Operation
    input: BrowserAutomationInputByOperation[Operation]
  }
}[BrowserAutomationOperation]

export type BrowserAutomationResult = {
  [Operation in BrowserAutomationOperation]: {
    operation: Operation
    result: BrowserAutomationResultByOperation[Operation]
  }
}[BrowserAutomationOperation]

interface BrowserAutomationRequestRouting {
  requestId: string
  sessionAgentId: string
  profileId: string
  /** Resolved target, or null only when status/open has no current tab yet. */
  tabId: string | null
  hostId: string
  hostGeneration: number
  deadlineAt: string
  /** Non-null only for operations authorized to write an artifact. */
  artifactDirectory: string | null
}

export type BrowserAutomationRequest = {
  [Operation in BrowserAutomationOperation]: BrowserAutomationRequestRouting & {
    operation: Operation
    input: BrowserAutomationInputByOperation[Operation]
  }
}[BrowserAutomationOperation]

interface BrowserAutomationResponseRouting {
  requestId: string
  sessionAgentId: string
  profileId: string
  tabId: string | null
  hostId: string
  hostGeneration: number
  elapsedMs: number
  updatedTab?: BrowserTabSnapshot
}

export type BrowserAutomationSuccessResponse = {
  [Operation in BrowserAutomationOperation]: BrowserAutomationResponseRouting & {
    ok: true
    operation: Operation
    result: BrowserAutomationResultByOperation[Operation]
    error?: never
  }
}[BrowserAutomationOperation]

export type BrowserAutomationErrorResponse = BrowserAutomationResponseRouting & {
  ok: false
  operation: BrowserAutomationOperation
  result?: never
  error: BrowserAutomationFailure
}

export type BrowserAutomationResponse = BrowserAutomationSuccessResponse | BrowserAutomationErrorResponse

export interface BrowserHostRegisterCommand {
  type: 'browser_host_register'
  registration: BrowserHostRegistration
}

export interface BrowserHostFocusCommand {
  type: 'browser_host_focus'
  hostId: string
  hostGeneration: number
  focused: boolean
}

export interface BrowserHostResponseCommand {
  type: 'browser_host_response'
  response: BrowserAutomationResponse
}

export interface BrowserHostStateReportCommand {
  type: 'browser_host_state_report'
  requestId: string
  hostId: string
  hostGeneration: number
  sessions: BrowserHostSessionStateReport[]
}

export interface BrowserPanelRevealAcknowledgeCommand {
  type: 'browser_panel_reveal_acknowledge'
  requestId: string
  hostId: string
  hostGeneration: number
  sessionAgentId: string
  profileId: string
  tabId: string
  sequence: number
}

export interface BrowserTabOpenCommand {
  type: 'browser_tab_open'
  requestId: string
  sessionAgentId: string
  profileId: string
  url?: string
  activate?: boolean
}

export interface BrowserTabActivateCommand {
  type: 'browser_tab_activate'
  requestId: string
  sessionAgentId: string
  tabId: string
}

export interface BrowserTabCloseCommand {
  type: 'browser_tab_close'
  requestId: string
  sessionAgentId: string
  tabId: string
}

export interface BrowserTabResizeCommand {
  type: 'browser_tab_resize'
  requestId: string
  sessionAgentId: string
  tabId: string
  viewport: BrowserViewportSetting
}

export interface BrowserRecordingStartCommand {
  type: 'browser_recording_start'
  requestId: string
  sessionAgentId: string
  tabId: string
}

export interface BrowserRecordingStopCommand {
  type: 'browser_recording_stop'
  requestId: string
  sessionAgentId: string
  tabId: string
  recordingId: string
}

export type BrowserClientCommand =
  | BrowserHostRegisterCommand
  | BrowserHostFocusCommand
  | BrowserHostResponseCommand
  | BrowserHostStateReportCommand
  | BrowserPanelRevealAcknowledgeCommand
  | BrowserTabOpenCommand
  | BrowserTabActivateCommand
  | BrowserTabCloseCommand
  | BrowserTabResizeCommand
  | BrowserRecordingStartCommand
  | BrowserRecordingStopCommand

export interface BrowserHostConnectedEvent {
  type: 'browser_host_connected'
  host: BrowserHostConnectionSnapshot
}

export interface BrowserHostStateSnapshotEvent {
  type: 'browser_host_state_snapshot'
  hostId: string
  hostGeneration: number
  sessions: BrowserSessionSnapshot[]
}

export interface BrowserHostStateReportResultEvent {
  type: 'browser_host_state_report_result'
  requestId: string
  result: BrowserHostStateReportResult
}

export interface BrowserAutomationRequestEvent {
  type: 'browser_automation_request'
  request: BrowserAutomationRequest
}

export interface BrowserSessionSnapshotEvent {
  type: 'browser_session_snapshot'
  snapshot: BrowserSessionSnapshot
}

export interface BrowserSessionChangedEvent {
  type: 'browser_session_changed'
  snapshot: BrowserSessionSnapshot
  reason: 'host-report' | 'automation' | 'human-command' | 'lifecycle' | 'recovery'
}

export interface BrowserPanelRevealAcknowledgedEvent {
  type: 'browser_panel_reveal_acknowledged'
  requestId: string
  snapshot: BrowserSessionSnapshot
}

export interface BrowserTabCommandSucceededEvent {
  type: 'browser_tab_command_succeeded'
  requestId: string
  commandType: 'browser_tab_open' | 'browser_tab_activate' | 'browser_tab_close' | 'browser_tab_resize'
  snapshot: BrowserSessionSnapshot
}

export type BrowserRecordingCommandSucceededEvent =
  | {
      type: 'browser_recording_command_succeeded'
      requestId: string
      commandType: 'browser_recording_start'
      result: BrowserRecordingStatusResult
      snapshot: BrowserSessionSnapshot
    }
  | {
      type: 'browser_recording_command_succeeded'
      requestId: string
      commandType: 'browser_recording_stop'
      result: BrowserRecordingArtifactResult
      snapshot: BrowserSessionSnapshot
    }

export type BrowserServerEvent =
  | BrowserHostConnectedEvent
  | BrowserHostStateSnapshotEvent
  | BrowserHostStateReportResultEvent
  | BrowserAutomationRequestEvent
  | BrowserSessionSnapshotEvent
  | BrowserSessionChangedEvent
  | BrowserPanelRevealAcknowledgedEvent
  | BrowserTabCommandSucceededEvent
  | BrowserRecordingCommandSucceededEvent

export class BrowserAutomationContractError extends Error {
  readonly operation: BrowserAutomationOperation

  constructor(operation: BrowserAutomationOperation, message: string) {
    super(`Invalid ${operation} input: ${message}`)
    this.name = 'BrowserAutomationContractError'
    this.operation = operation
  }
}

function recordInput(operation: BrowserAutomationOperation, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserAutomationContractError(operation, 'expected an object')
  }
  return value as Record<string, unknown>
}

function knownKeys(operation: BrowserAutomationOperation, input: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key))
  if (unexpected) throw new BrowserAutomationContractError(operation, `unexpected field ${unexpected}`)
}

function optionalId(operation: BrowserAutomationOperation, value: unknown, field = 'tabId'): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new BrowserAutomationContractError(operation, `${field} must be a non-empty string of at most 128 characters`)
  }
  return value
}

function optionalTarget(operation: BrowserAutomationOperation, input: Record<string, unknown>): BrowserTabTargetInput {
  const tabId = optionalId(operation, input.tabId)
  return tabId === undefined ? {} : { tabId }
}

function boundedString(operation: BrowserAutomationOperation, value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) || value.length > maximum) {
    throw new BrowserAutomationContractError(operation, `${field} must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${maximum} characters`)
  }
  return value
}

function timeout(operation: BrowserAutomationOperation, value: unknown): number {
  const resolved = value === undefined ? BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS : value
  if (!Number.isInteger(resolved) || (resolved as number) <= 0 || (resolved as number) > BROWSER_AUTOMATION_MAX_TIMEOUT_MS) {
    throw new BrowserAutomationContractError(operation, `timeoutMs must be an integer from 1 to ${BROWSER_AUTOMATION_MAX_TIMEOUT_MS}`)
  }
  return resolved as number
}

function finite(operation: BrowserAutomationOperation, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BrowserAutomationContractError(operation, `${field} must be finite`)
  }
  return value
}

function selector(operation: BrowserAutomationOperation, value: unknown, field: 'locator' | 'selector'): string | undefined {
  return value === undefined ? undefined : boundedString(operation, value, field, BROWSER_AUTOMATION_MAX_URL_LENGTH)
}

function viewportDimension(operation: BrowserAutomationOperation, value: unknown, field: 'width' | 'height'): number {
  if (!Number.isInteger(value) || (value as number) < BROWSER_VIEWPORT_MIN_DIMENSION || (value as number) > BROWSER_VIEWPORT_MAX_DIMENSION) {
    throw new BrowserAutomationContractError(operation, `${field} must be an integer from ${BROWSER_VIEWPORT_MIN_DIMENSION} to ${BROWSER_VIEWPORT_MAX_DIMENSION}`)
  }
  return value as number
}

export function resolveBrowserViewportPreset(presetId: BrowserViewportPresetId, orientation?: BrowserViewportOrientation): BrowserViewportSetting {
  const preset = BROWSER_VIEWPORT_PRESETS[presetId]
  const resolvedOrientation = orientation ?? (preset.height >= preset.width ? 'portrait' : 'landscape')
  const nativePortrait = preset.height >= preset.width
  const swap = (resolvedOrientation === 'landscape' && nativePortrait) || (resolvedOrientation === 'portrait' && !nativePortrait)
  return {
    mode: 'preset',
    presetId,
    orientation: resolvedOrientation,
    width: swap ? preset.height : preset.width,
    height: swap ? preset.width : preset.height,
  }
}

export function isBrowserAutomationOperation(value: unknown): value is BrowserAutomationOperation {
  return typeof value === 'string' && (BROWSER_AUTOMATION_OPERATIONS as readonly string[]).includes(value)
}

export function parseBrowserAutomationInput<Operation extends BrowserAutomationOperation>(
  operation: Operation,
  value: unknown,
): BrowserAutomationInputByOperation[Operation] {
  const input = recordInput(operation, value)
  const target = optionalTarget(operation, input)

  switch (operation) {
    case 'status':
    case 'snapshot':
    case 'recordingStart': {
      knownKeys(operation, input, ['tabId'])
      return target as BrowserAutomationInputByOperation[Operation]
    }
    case 'open': {
      knownKeys(operation, input, ['tabId', 'url', 'show', 'reuseExistingTab'])
      const url = input.url === undefined ? undefined : boundedString(operation, input.url, 'url', BROWSER_AUTOMATION_MAX_URL_LENGTH)
      if (input.show !== undefined && typeof input.show !== 'boolean') throw new BrowserAutomationContractError(operation, 'show must be boolean')
      if (input.reuseExistingTab !== undefined && typeof input.reuseExistingTab !== 'boolean') throw new BrowserAutomationContractError(operation, 'reuseExistingTab must be boolean')
      const reuseExistingTab = input.reuseExistingTab === undefined ? true : input.reuseExistingTab
      if (target.tabId !== undefined && reuseExistingTab === false) throw new BrowserAutomationContractError(operation, 'tabId cannot be combined with reuseExistingTab=false')
      return { ...target, ...(url === undefined ? {} : { url }), show: input.show === undefined ? true : input.show, reuseExistingTab } as BrowserAutomationInputByOperation[Operation]
    }
    case 'navigate': {
      knownKeys(operation, input, ['tabId', 'url', 'environmentPort', 'environmentProtocol', 'path', 'readiness', 'timeoutMs'])
      const hasUrl = input.url !== undefined
      const hasPort = input.environmentPort !== undefined
      if (hasUrl === hasPort) throw new BrowserAutomationContractError(operation, 'provide exactly one of url or environmentPort')
      const url = hasUrl ? boundedString(operation, input.url, 'url', BROWSER_AUTOMATION_MAX_URL_LENGTH) : undefined
      let environmentPort: number | undefined
      if (hasPort) {
        if (!Number.isInteger(input.environmentPort) || (input.environmentPort as number) < 1 || (input.environmentPort as number) > 65_535) throw new BrowserAutomationContractError(operation, 'environmentPort must be an integer from 1 to 65535')
        environmentPort = input.environmentPort as number
      }
      if (input.environmentProtocol !== undefined && input.environmentProtocol !== 'http' && input.environmentProtocol !== 'https') throw new BrowserAutomationContractError(operation, 'environmentProtocol must be http or https')
      if (!hasPort && (input.environmentProtocol !== undefined || input.path !== undefined)) throw new BrowserAutomationContractError(operation, 'environmentProtocol and path require environmentPort')
      const path = input.path === undefined ? undefined : boundedString(operation, input.path, 'path', BROWSER_AUTOMATION_MAX_URL_LENGTH, true)
      const readiness = input.readiness === undefined ? 'load' : input.readiness
      if (readiness !== 'load' && readiness !== 'domContentLoaded' && readiness !== 'none') throw new BrowserAutomationContractError(operation, 'readiness must be load, domContentLoaded, or none')
      return { ...target, ...(url === undefined ? {} : { url }), ...(environmentPort === undefined ? {} : { environmentPort }), ...(input.environmentProtocol === undefined ? {} : { environmentProtocol: input.environmentProtocol }), ...(path === undefined ? {} : { path }), readiness, timeoutMs: timeout(operation, input.timeoutMs) } as BrowserAutomationInputByOperation[Operation]
    }
    case 'resize': {
      knownKeys(operation, input, ['tabId', 'mode', 'presetId', 'orientation', 'width', 'height', 'timeoutMs'])
      const timeoutMs = timeout(operation, input.timeoutMs)
      if (input.mode === 'fill') {
        if (input.presetId !== undefined || input.orientation !== undefined || input.width !== undefined || input.height !== undefined) throw new BrowserAutomationContractError(operation, 'fill mode does not accept preset or dimensions')
        return { ...target, mode: 'fill', timeoutMs } as BrowserAutomationInputByOperation[Operation]
      }
      if (input.mode === 'freeform') {
        if (input.presetId !== undefined || input.orientation !== undefined) throw new BrowserAutomationContractError(operation, 'freeform mode does not accept a preset')
        const width = viewportDimension(operation, input.width, 'width')
        const height = viewportDimension(operation, input.height, 'height')
        if (width * height > BROWSER_VIEWPORT_MAX_AREA) throw new BrowserAutomationContractError(operation, `viewport area must not exceed ${BROWSER_VIEWPORT_MAX_AREA}`)
        return { ...target, mode: 'freeform', width, height, timeoutMs } as BrowserAutomationInputByOperation[Operation]
      }
      if (input.mode === 'preset') {
        if (input.width !== undefined || input.height !== undefined) throw new BrowserAutomationContractError(operation, 'preset mode does not accept custom dimensions')
        if (typeof input.presetId !== 'string' || !(input.presetId in BROWSER_VIEWPORT_PRESETS)) throw new BrowserAutomationContractError(operation, 'presetId is not supported')
        if (input.orientation !== undefined && input.orientation !== 'portrait' && input.orientation !== 'landscape') throw new BrowserAutomationContractError(operation, 'orientation must be portrait or landscape')
        return { ...target, mode: 'preset', presetId: input.presetId as BrowserViewportPresetId, ...(input.orientation === undefined ? {} : { orientation: input.orientation }), timeoutMs } as BrowserAutomationInputByOperation[Operation]
      }
      throw new BrowserAutomationContractError(operation, 'mode must be fill, freeform, or preset')
    }
    case 'click': {
      knownKeys(operation, input, ['tabId', 'locator', 'selector', 'x', 'y', 'timeoutMs'])
      const locator = selector(operation, input.locator, 'locator')
      const css = selector(operation, input.selector, 'selector')
      const hasX = input.x !== undefined
      const hasY = input.y !== undefined
      if (hasX !== hasY || Number(locator !== undefined) + Number(css !== undefined) + Number(hasX && hasY) !== 1) throw new BrowserAutomationContractError(operation, 'provide exactly one locator, selector, or x/y pair')
      const timeoutMs = timeout(operation, input.timeoutMs)
      if (locator !== undefined) return { ...target, locator, timeoutMs } as BrowserAutomationInputByOperation[Operation]
      if (css !== undefined) return { ...target, selector: css, timeoutMs } as BrowserAutomationInputByOperation[Operation]
      return { ...target, x: finite(operation, input.x, 'x'), y: finite(operation, input.y, 'y'), timeoutMs } as BrowserAutomationInputByOperation[Operation]
    }
    case 'type': {
      knownKeys(operation, input, ['tabId', 'text', 'clear', 'locator', 'selector', 'timeoutMs'])
      const locator = selector(operation, input.locator, 'locator')
      const css = selector(operation, input.selector, 'selector')
      if (locator !== undefined && css !== undefined) throw new BrowserAutomationContractError(operation, 'provide at most one locator or selector')
      if (input.clear !== undefined && typeof input.clear !== 'boolean') throw new BrowserAutomationContractError(operation, 'clear must be boolean')
      return { ...target, text: boundedString(operation, input.text, 'text', BROWSER_AUTOMATION_MAX_EVALUATE_BYTES, true), clear: input.clear === undefined ? false : input.clear, ...(locator === undefined ? {} : { locator }), ...(css === undefined ? {} : { selector: css }), timeoutMs: timeout(operation, input.timeoutMs) } as BrowserAutomationInputByOperation[Operation]
    }
    case 'press': {
      knownKeys(operation, input, ['tabId', 'key', 'modifiers'])
      const key = boundedString(operation, input.key, 'key', 128)
      let modifiers: BrowserPressInput['modifiers']
      if (input.modifiers !== undefined) {
        if (!Array.isArray(input.modifiers) || input.modifiers.some((modifier) => modifier !== 'Alt' && modifier !== 'Control' && modifier !== 'Meta' && modifier !== 'Shift')) throw new BrowserAutomationContractError(operation, 'modifiers contain an unsupported key')
        modifiers = [...new Set(input.modifiers)] as BrowserPressInput['modifiers']
      }
      return { ...target, key, ...(modifiers === undefined ? {} : { modifiers }) } as BrowserAutomationInputByOperation[Operation]
    }
    case 'scroll': {
      knownKeys(operation, input, ['tabId', 'deltaX', 'deltaY', 'locator', 'selector'])
      const locator = selector(operation, input.locator, 'locator')
      const css = selector(operation, input.selector, 'selector')
      if (locator !== undefined && css !== undefined) throw new BrowserAutomationContractError(operation, 'provide at most one locator or selector')
      if (input.deltaX === undefined && input.deltaY === undefined) throw new BrowserAutomationContractError(operation, 'provide deltaX or deltaY')
      return { ...target, ...(input.deltaX === undefined ? {} : { deltaX: finite(operation, input.deltaX, 'deltaX') }), ...(input.deltaY === undefined ? {} : { deltaY: finite(operation, input.deltaY, 'deltaY') }), ...(locator === undefined ? {} : { locator }), ...(css === undefined ? {} : { selector: css }) } as BrowserAutomationInputByOperation[Operation]
    }
    case 'evaluate': {
      knownKeys(operation, input, ['tabId', 'expression', 'awaitPromise', 'returnByValue'])
      if (input.awaitPromise !== undefined && typeof input.awaitPromise !== 'boolean') throw new BrowserAutomationContractError(operation, 'awaitPromise must be boolean')
      if (input.returnByValue !== undefined && typeof input.returnByValue !== 'boolean') throw new BrowserAutomationContractError(operation, 'returnByValue must be boolean')
      return { ...target, expression: boundedString(operation, input.expression, 'expression', BROWSER_AUTOMATION_MAX_EVALUATE_BYTES), awaitPromise: input.awaitPromise === undefined ? true : input.awaitPromise, returnByValue: input.returnByValue === undefined ? true : input.returnByValue } as BrowserAutomationInputByOperation[Operation]
    }
    case 'waitFor': {
      knownKeys(operation, input, ['tabId', 'locator', 'selector', 'text', 'urlIncludes', 'timeoutMs'])
      const locator = selector(operation, input.locator, 'locator')
      const css = selector(operation, input.selector, 'selector')
      if (locator !== undefined && css !== undefined) throw new BrowserAutomationContractError(operation, 'provide at most one locator or selector')
      const text = input.text === undefined ? undefined : boundedString(operation, input.text, 'text', BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_LENGTH)
      const urlIncludes = input.urlIncludes === undefined ? undefined : boundedString(operation, input.urlIncludes, 'urlIncludes', BROWSER_AUTOMATION_MAX_URL_LENGTH)
      if (locator === undefined && css === undefined && text === undefined && urlIncludes === undefined) throw new BrowserAutomationContractError(operation, 'provide at least one wait condition')
      return { ...target, ...(locator === undefined ? {} : { locator }), ...(css === undefined ? {} : { selector: css }), ...(text === undefined ? {} : { text }), ...(urlIncludes === undefined ? {} : { urlIncludes }), timeoutMs: timeout(operation, input.timeoutMs) } as BrowserAutomationInputByOperation[Operation]
    }
    case 'recordingStop': {
      knownKeys(operation, input, ['tabId', 'recordingId'])
      const recordingId = optionalId(operation, input.recordingId, 'recordingId')
      return { ...target, ...(recordingId === undefined ? {} : { recordingId }) } as BrowserAutomationInputByOperation[Operation]
    }
  }
}
