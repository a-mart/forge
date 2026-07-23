import type { BrowserAutomationRequest, BrowserAutomationResponse, BrowserRenderedViewport, BrowserTabSnapshot, BrowserViewportSetting } from '@forge/protocol'
import type { BrowserWebviewRegistration } from './browser-automation-manager.js'

export const BROWSER_GUEST_HUMAN_INPUT_CHANNEL = 'forge:browser-guest-human-input'
export const BROWSER_GUEST_SYNTHETIC_INPUT_CHANNEL = 'forge:browser-guest-synthetic-input'

export const BROWSER_IPC = {
  config: 'forge:browser-config', register: 'forge:browser-register-webview', unregister: 'forge:browser-unregister-webview',
  presentation: 'forge:browser-presentation', humanNavigate: 'forge:browser-human-navigate', humanHistory: 'forge:browser-human-history',
  humanReload: 'forge:browser-human-reload', humanZoom: 'forge:browser-human-zoom', execute: 'forge:browser-execute', prepareRecording: 'forge:browser-recording-prepare',
  stopRecordingCapture: 'forge:browser-recording-stop-capture', saveRecording: 'forge:browser-recording-save',
  cancelRecording: 'forge:browser-recording-cancel', recordingFrame: 'forge:browser-recording-frame', stateChanged: 'forge:browser-state-changed',
} as const

export interface BrowserBridgeConfig { partition: string; preloadUrl: string; webPreferences: string }
export interface BrowserPresentationRequest {
  tabId: string
  visible: boolean
  viewportSetting?: BrowserViewportSetting
  renderedViewport: BrowserRenderedViewport | null
  hostGeneration: number
  sessionRevision: number
  sequence: number
}
export interface BrowserPresentationAcknowledgement {
  applied: boolean
  tab: BrowserTabSnapshot
  hostGeneration: number
  sessionRevision: number
  sequence: number
}
export interface BrowserAutomationBridge {
  capabilities: { supportedOperations: readonly string[]; playwrightVersion: string; supportsRecording: boolean }
  getWebviewConfig(profileId: string): Promise<BrowserBridgeConfig>
  registerWebview(registration: BrowserWebviewRegistration): Promise<BrowserTabSnapshot>
  unregisterWebview(tabId: string, webContentsId?: number): Promise<void>
  setTabPresentation(request: BrowserPresentationRequest): Promise<BrowserPresentationAcknowledgement>
  navigate(tabId: string, url: string): Promise<BrowserTabSnapshot>
  history(tabId: string, direction: 'back' | 'forward'): Promise<BrowserTabSnapshot>
  reload(tabId: string, hard?: boolean): Promise<BrowserTabSnapshot>
  setZoom(tabId: string, factor: number): Promise<BrowserTabSnapshot>
  invoke(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse>
  onStateChanged(listener: (tab: BrowserTabSnapshot) => void): () => void
}
export const browserBridgeCapabilities = {
  supportedOperations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'recordingStart', 'recordingStop'] as const,
  playwrightVersion: '1.60.0',
  supportsRecording: true,
}
