/**
 * Type declarations and detection for the Electron preload bridge.
 *
 * When the UI is loaded inside an Electron shell, the preload script exposes
 * `window.electronBridge` with explicit backend URLs. This avoids the
 * port-based heuristic that assumes the renderer runs on a known HTTP port.
 */

export interface ElectronBridge {
  /** HTTP base URL for the backend, e.g. "http://127.0.0.1:47187" */
  backendUrl: string
  /** WebSocket base URL for the backend, e.g. "ws://127.0.0.1:47187" */
  backendWsUrl: string
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
