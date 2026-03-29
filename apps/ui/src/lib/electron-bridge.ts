/**
 * Type declarations and detection for the Electron preload bridge.
 *
 * When the UI is loaded inside an Electron shell, the preload script exposes
 * `window.electronBridge` with explicit backend URLs. This avoids the
 * port-based heuristic that assumes the renderer runs on a known HTTP port.
 */

export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'available'; version?: string }
  | { type: 'not-available'; version?: string }
  | { type: 'downloading'; percent?: number }
  | { type: 'downloaded'; version?: string }
  | { type: 'error'; message?: string }

export interface ElectronBridge {
  /** HTTP base URL for the backend, e.g. "http://127.0.0.1:47187" */
  backendUrl: string
  /** WebSocket base URL for the backend, e.g. "ws://127.0.0.1:47187" */
  backendWsUrl: string
  /** Returns the Electron app version from the main process. */
  getVersion(): string
  /** Host platform for desktop-specific renderer behavior. */
  platform: string
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
