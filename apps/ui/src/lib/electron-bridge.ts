import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostConnectionSnapshot,
  BrowserRenderedViewport,
  BrowserSessionSnapshot,
  BrowserTabSnapshot,
  BrowserViewportSetting,
  ExternalChromeCoordinatorStatus,
} from '@forge/protocol'

export interface SleepBlockerStatus { enabled: boolean; blocking: boolean; graceRemainingMs: number | null; reason: string }
export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'available'; version?: string }
  | { type: 'not-available'; version?: string }
  | { type: 'downloading'; percent?: number }
  | { type: 'downloaded'; version?: string }
  | { type: 'error'; message?: string }
export interface CliInstallResult { success: boolean; installedPath: string; binDir: string; pathIncluded: boolean; pathInstructions: string | null; error?: string }
export type ExternalChromeControlResult = { ok: true; status: ExternalChromeCoordinatorStatus } | { ok: false; error: 'invalid-request' | 'operation-failed' }
export interface ExternalChromeBridge {
  status(): Promise<ExternalChromeControlResult>; enable(): Promise<ExternalChromeControlResult>; disable(): Promise<ExternalChromeControlResult>
  repair(): Promise<ExternalChromeControlResult>; remove(): Promise<ExternalChromeControlResult>
}

export type ElectronWindowRole = 'main' | 'managed-browser-popout'
export type ManagedBrowserWorkspaceMode = 'docked' | 'opening' | 'popped-out' | 'docking' | 'unavailable'
export interface BrowserViewportMetrics { workspaceEpoch: number; rect: { x: number; y: number; width: number; height: number }; innerWidth: number; innerHeight: number; deviceScaleFactor?: number }
export interface BrowserPresentationRequest {
  tabId: string; visible: boolean; viewportSetting?: BrowserViewportSetting; renderedViewport: BrowserRenderedViewport | null
  hostGeneration: number; sessionRevision: number; sequence: number; workspaceEpoch: number
}
export interface BrowserPresentationAcknowledgement { applied: boolean; tab: BrowserTabSnapshot; hostGeneration: number; sessionRevision: number; sequence: number }
export interface ManagedBrowserReconcileInput {
  controllerInstanceId: string; hostGeneration: number; updateSequence: number; workspaceEpoch: number; sessions: BrowserSessionSnapshot[]
}
export interface BrowserAutomationBridge {
  capabilities: { supportedOperations: readonly string[]; playwrightVersion: string; supportsRecording: boolean }
  reconcile(input: ManagedBrowserReconcileInput): Promise<{ applied: boolean; tabCount: number }>
  ensureProvisional(registration: { tab: BrowserTabSnapshot; visible: boolean; created: boolean; workspaceEpoch: number }): Promise<BrowserTabSnapshot>
  commitProvisional(tabId: string, workspaceEpoch: number): Promise<void>
  abortProvisional(tabId: string): Promise<void>
  reportViewport(metrics: BrowserViewportMetrics): Promise<void>
  setTabPresentation(request: BrowserPresentationRequest): Promise<BrowserPresentationAcknowledgement>
  captureScreenshot(tabId: string): Promise<string>
  navigate(tabId: string, url: string): Promise<BrowserTabSnapshot>
  history(tabId: string, direction: 'back' | 'forward'): Promise<BrowserTabSnapshot>
  reload(tabId: string, hard?: boolean): Promise<BrowserTabSnapshot>
  setZoom(tabId: string, factor: number): Promise<BrowserTabSnapshot>
  invoke(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse>
  onStateChanged(listener: (tab: BrowserTabSnapshot) => void): () => void
}
export interface ManagedBrowserWorkspaceProjection {
  workspaceEpoch: number; sessionAgentId: string | null; profileId: string | null; snapshot: BrowserSessionSnapshot | null
  host: BrowserHostConnectionSnapshot; mode: ManagedBrowserWorkspaceMode; popoutAvailable: boolean; connected: boolean; publishedAt: string
}
export type BrowserWorkspaceCommand =
  | { type: 'open'; autoOpenAttemptKey?: string }
  | { type: 'activate'; tabId: string }
  | { type: 'close'; tabId: string }
  | { type: 'resize'; tabId: string; viewport: BrowserViewportSetting }
  | { type: 'navigate'; tabId: string; url: string }
  | { type: 'history'; tabId: string; direction: 'back' | 'forward' }
  | { type: 'reload'; tabId: string; hard: boolean }
  | { type: 'zoom'; tabId: string; factor: number }
  | { type: 'capture'; tabId: string }
  | { type: 'recordingStart'; tabId: string }
  | { type: 'recordingStop'; tabId: string; recordingId: string }
export interface BrowserWorkspaceCommandRequest { requestId: string; workspaceEpoch: number; sessionAgentId: string; profileId: string; deadlineAt: string; command: BrowserWorkspaceCommand }
export interface BrowserWorkspaceBridge {
  capability: { popoutAvailable: boolean }
  getSnapshot(): Promise<ManagedBrowserWorkspaceProjection | null>
  publish?(projection: ManagedBrowserWorkspaceProjection): Promise<void>
  sendCommand?(request: BrowserWorkspaceCommandRequest): Promise<unknown>
  onCommand?(listener: (request: BrowserWorkspaceCommandRequest) => void): () => void
  replyToCommand?(requestId: string, result: { ok: true; value?: unknown } | { ok: false; error: string }): void
  popOut(workspaceEpoch: number): Promise<ManagedBrowserWorkspaceMode>
  dock(workspaceEpoch: number): Promise<ManagedBrowserWorkspaceMode>
  bringToFront(): Promise<void>
  reportViewport(metrics: BrowserViewportMetrics): Promise<void>
  onProjection(listener: (projection: ManagedBrowserWorkspaceProjection | null) => void): () => void
  onModeChanged(listener: (mode: ManagedBrowserWorkspaceMode) => void): () => void
  onFocusChanged?(listener: (focused: boolean) => void): () => void
}

export interface ElectronBridge {
  windowRole: ElectronWindowRole
  backendUrl?: string
  backendWsUrl?: string
  getVersion?(): string
  platform: string
  browserAutomation?: BrowserAutomationBridge
  browserWorkspace?: BrowserWorkspaceBridge
  externalChrome?: ExternalChromeBridge
  showOpenDialog?(options: { title?: string; defaultPath?: string; properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles'> }): Promise<{ canceled: boolean; filePaths: string[] }>
  onTerminalShortcut?(listener: (event: { action: 'toggle' | 'new' | 'next' | 'prev' }) => void): () => void
  updateTitleBarOverlay?(colors: { color: string; symbolColor: string }): void
  checkForUpdates?(): Promise<void>; downloadUpdate?(): Promise<void>; installUpdate?(): Promise<void>
  getBetaChannel?(): Promise<boolean>; setBetaChannel?(enabled: boolean): Promise<void>
  onUpdateStatus?(callback: (status: UpdateStatus) => void): () => void
  revealInFolder?(filePath: string): Promise<void>; installCli?(): Promise<CliInstallResult>; verifyCliInstall?(): Promise<{ ok: boolean; output: string }>
  getSleepBlockerSettings?(): Promise<SleepBlockerStatus>; setSleepBlockerSettings?(patch: { enabled?: boolean; gracePeriodMinutes?: number }): Promise<SleepBlockerStatus | null>
  onSleepBlockerStatus?(callback: (status: SleepBlockerStatus) => void): () => void
}
declare global { interface Window { electronBridge?: ElectronBridge } }
export function isElectron(): boolean {
  return typeof window !== 'undefined' && window.electronBridge?.windowRole === 'main'
    && typeof window.electronBridge.backendWsUrl === 'string' && window.electronBridge.backendWsUrl.length > 0
}
