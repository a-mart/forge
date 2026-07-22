import type { BrowserAutomationRequest, BrowserAutomationResponse, BrowserTabSnapshot, BrowserViewportSetting } from '@forge/protocol'
import type { BrowserWebviewRegistration } from './browser-automation-manager.js'

export const BROWSER_GUEST_HUMAN_INPUT_CHANNEL = 'forge:browser-guest-human-input'

export const BROWSER_IPC = {
  config: 'forge:browser-config', register: 'forge:browser-register-webview', unregister: 'forge:browser-unregister-webview',
  presentation: 'forge:browser-presentation', execute: 'forge:browser-execute', prepareRecording: 'forge:browser-recording-prepare',
  stopRecordingCapture: 'forge:browser-recording-stop-capture', saveRecording: 'forge:browser-recording-save',
  cancelRecording: 'forge:browser-recording-cancel', recordingFrame: 'forge:browser-recording-frame', stateChanged: 'forge:browser-state-changed',
} as const

export interface BrowserBridgeConfig { partition: string; preloadUrl: string; webPreferences: string }
export interface BrowserAutomationBridge {
  capabilities: { supportedOperations: readonly string[]; playwrightVersion: string; supportsRecording: boolean }
  getWebviewConfig(profileId: string): Promise<BrowserBridgeConfig>
  registerWebview(registration: BrowserWebviewRegistration): Promise<BrowserTabSnapshot>
  unregisterWebview(tabId: string, webContentsId?: number): Promise<void>
  setTabPresentation(tabId: string, visible: boolean, viewportSetting?: BrowserViewportSetting): Promise<BrowserTabSnapshot>
  invoke(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse>
  onStateChanged(listener: (tab: BrowserTabSnapshot) => void): () => void
}
export const browserBridgeCapabilities = {
  supportedOperations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'recordingStart', 'recordingStop'] as const,
  playwrightVersion: '1.60.0',
  supportsRecording: true,
}
