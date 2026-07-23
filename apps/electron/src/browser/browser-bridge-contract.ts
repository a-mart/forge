import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostConnectionSnapshot,
  BrowserRenderedViewport,
  BrowserSessionSnapshot,
  BrowserTabSnapshot,
  BrowserViewportSetting,
} from '@forge/protocol'
import type { BrowserTabRegistration } from './browser-automation-manager.js'
import type { BrowserViewportMetrics, ManagedBrowserReconcileInput } from './managed-browser-view-host.js'

export const BROWSER_GUEST_HUMAN_INPUT_CHANNEL = 'forge:browser-guest-human-input'
export const BROWSER_GUEST_SYNTHETIC_INPUT_CHANNEL = 'forge:browser-guest-synthetic-input'
export const BROWSER_GUEST_AGENT_CURSOR_CHANNEL = 'forge:browser-guest-agent-cursor'

export const BROWSER_IPC = {
  reconcile: 'forge:browser-reconcile', ensureProvisional: 'forge:browser-ensure-provisional',
  commitProvisional: 'forge:browser-commit-provisional', abortProvisional: 'forge:browser-abort-provisional',
  presentation: 'forge:browser-presentation', viewport: 'forge:browser-viewport', capture: 'forge:browser-capture',
  humanNavigate: 'forge:browser-human-navigate', humanHistory: 'forge:browser-human-history',
  humanReload: 'forge:browser-human-reload', humanZoom: 'forge:browser-human-zoom', execute: 'forge:browser-execute',
  prepareRecording: 'forge:browser-recording-prepare', stopRecordingCapture: 'forge:browser-recording-stop-capture',
  saveRecording: 'forge:browser-recording-save', cancelRecording: 'forge:browser-recording-cancel',
  recordingFrame: 'forge:browser-recording-frame', stateChanged: 'forge:browser-state-changed',
  // Historical renderer-webview channels retained only by the legacy fixture.
  config: 'forge:browser-config', register: 'forge:browser-register-webview', unregister: 'forge:browser-unregister-webview',
} as const

export const BROWSER_WORKSPACE_IPC = {
  publish: 'forge:browser-workspace-publish', snapshot: 'forge:browser-workspace-snapshot',
  projection: 'forge:browser-workspace-projection', command: 'forge:browser-workspace-command',
  commandForward: 'forge:browser-workspace-command-forward', commandReply: 'forge:browser-workspace-command-reply',
  popOut: 'forge:browser-workspace-popout', dock: 'forge:browser-workspace-dock',
  bringToFront: 'forge:browser-workspace-bring-to-front', mode: 'forge:browser-workspace-mode',
  focus: 'forge:browser-workspace-focus', viewport: 'forge:browser-workspace-viewport',
} as const

export type ElectronWindowRole = 'main' | 'managed-browser-popout'
export type ManagedBrowserWorkspaceMode = 'docked' | 'opening' | 'popped-out' | 'docking' | 'unavailable'

export interface BrowserPresentationRequest {
  tabId: string
  visible: boolean
  viewportSetting?: BrowserViewportSetting
  renderedViewport: BrowserRenderedViewport | null
  hostGeneration: number
  sessionRevision: number
  sequence: number
  workspaceEpoch: number
}
export interface BrowserPresentationAcknowledgement {
  applied: boolean
  tab: BrowserTabSnapshot
  hostGeneration: number
  sessionRevision: number
  sequence: number
}

export interface ManagedBrowserWorkspaceProjection {
  workspaceEpoch: number
  sessionAgentId: string | null
  profileId: string | null
  snapshot: BrowserSessionSnapshot | null
  host: BrowserHostConnectionSnapshot
  mode: ManagedBrowserWorkspaceMode
  popoutAvailable: boolean
  connected: boolean
  publishedAt: string
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

export interface BrowserWorkspaceCommandRequest {
  requestId: string
  workspaceEpoch: number
  sessionAgentId: string
  profileId: string
  deadlineAt: string
  command: BrowserWorkspaceCommand
}

export interface BrowserAutomationBridge {
  capabilities: { supportedOperations: readonly string[]; playwrightVersion: string; supportsRecording: boolean }
  reconcile(input: ManagedBrowserReconcileInput): Promise<{ applied: boolean; tabCount: number }>
  ensureProvisional(registration: BrowserTabRegistration & { workspaceEpoch: number }): Promise<BrowserTabSnapshot>
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

export const browserBridgeCapabilities = {
  supportedOperations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'recordingStart', 'recordingStop'] as const,
  playwrightVersion: '1.60.0',
  supportsRecording: true,
}
