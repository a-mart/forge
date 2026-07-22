import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserTabSnapshot,
  BrowserViewportSetting,
} from '@forge/protocol'

/**
 * Type declarations and detection for the Electron preload bridge.
 *
 * When the UI is loaded inside an Electron shell, the preload script exposes
 * `window.electronBridge` with explicit backend URLs. This avoids the
 * port-based heuristic that assumes the renderer runs on a known HTTP port.
 */

export interface SleepBlockerStatus {
  /** Feature enabled in settings */
  enabled: boolean
  /** powerSaveBlocker is currently active */
  blocking: boolean
  /** Null when not in grace period, otherwise ms remaining */
  graceRemainingMs: number | null
  /** Human-readable reason */
  reason: string
}

export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'available'; version?: string }
  | { type: 'not-available'; version?: string }
  | { type: 'downloading'; percent?: number }
  | { type: 'downloaded'; version?: string }
  | { type: 'error'; message?: string }

export interface CliInstallResult {
  /** Whether the shim was installed successfully. */
  success: boolean
  /** Absolute path to the installed shim. */
  installedPath: string
  /** Directory containing the shim. */
  binDir: string
  /** Whether binDir is already present on PATH. */
  pathIncluded: boolean
  /** Shell/PowerShell instructions for adding to PATH, or null when already included. */
  pathInstructions: string | null
  /** Error message when success is false. */
  error?: string
}

export interface BrowserBridgeConfig {
  partition: string
  preloadUrl: string
  webPreferences: string
}

export interface BrowserAutomationBridge {
  capabilities: {
    supportedOperations: readonly string[]
    playwrightVersion: string
    supportsRecording: boolean
  }
  getWebviewConfig(profileId: string): Promise<BrowserBridgeConfig>
  registerWebview(registration: { tab: BrowserTabSnapshot; webContentsId: number; visible: boolean }): Promise<BrowserTabSnapshot>
  unregisterWebview(tabId: string, webContentsId?: number): Promise<void>
  setTabPresentation(tabId: string, visible: boolean, viewportSetting?: BrowserViewportSetting): Promise<BrowserTabSnapshot>
  invoke(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse>
  onStateChanged(listener: (tab: BrowserTabSnapshot) => void): () => void
}

export interface ElectronBridge {
  /** HTTP base URL for the backend, e.g. "http://127.0.0.1:47187" */
  backendUrl: string
  /** WebSocket base URL for the backend, e.g. "ws://127.0.0.1:47187" */
  backendWsUrl: string
  /** Returns the Electron app version from the main process. */
  getVersion(): string
  /** Host platform for desktop-specific renderer behavior. */
  platform: string
  /** Managed browser host bridge. Present only in the desktop shell. */
  browserAutomation?: BrowserAutomationBridge
  /** Opens a native file dialog. Available only in Electron. */
  showOpenDialog?(options: {
    title?: string
    defaultPath?: string
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles'>
  }): Promise<{ canceled: boolean; filePaths: string[] }>
  /** Subscribe to Electron-delivered terminal shortcuts. */
  onTerminalShortcut?(listener: (event: { action: 'toggle' | 'new' | 'next' | 'prev' }) => void): () => void
  /** Update the title bar overlay colors (Windows/Linux only). */
  updateTitleBarOverlay?(colors: { color: string; symbolColor: string }): void
  /** Trigger a manual update check. */
  checkForUpdates?(): Promise<void>
  /** Start downloading a found update. */
  downloadUpdate?(): Promise<void>
  /** Quit and install a downloaded update. */
  installUpdate?(): Promise<void>
  /** Get the current beta channel preference. */
  getBetaChannel?(): Promise<boolean>
  /** Set the beta channel preference and trigger an update check if enabled. */
  setBetaChannel?(enabled: boolean): Promise<void>
  /** Subscribe to update status events from the main process. Returns an unsubscribe function. */
  onUpdateStatus?(callback: (status: UpdateStatus) => void): () => void
  /** Reveal a file in the native file manager (Finder / File Explorer). */
  revealInFolder?(filePath: string): Promise<void>
  /** Install (or update) the Forge CLI shim for desktop. Returns install result with PATH instructions. */
  installCli?(): Promise<CliInstallResult>
  /** Verify the installed CLI shim can run. Returns version string on success. */
  verifyCliInstall?(): Promise<{ ok: boolean; output: string }>
  /** Get current sleep blocker settings and status. */
  getSleepBlockerSettings?(): Promise<SleepBlockerStatus>
  /** Update sleep blocker settings. Returns updated status. */
  setSleepBlockerSettings?(patch: { enabled?: boolean; gracePeriodMinutes?: number }): Promise<SleepBlockerStatus | null>
  /** Subscribe to sleep blocker status changes. Returns unsubscribe function. */
  onSleepBlockerStatus?(callback: (status: SleepBlockerStatus) => void): () => void
}

declare global {
  interface Window {
    electronBridge?: ElectronBridge
  }
}

/** Returns true when running inside the Electron shell with a valid bridge. */
export function isElectron(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.electronBridge != null &&
    typeof window.electronBridge.backendWsUrl === 'string' &&
    window.electronBridge.backendWsUrl.length > 0
  )
}
