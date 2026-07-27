import { useEffect } from 'react'

/** Confirms that React mounted the authoritative Electron renderer. */
export function useElectronRendererReady(): void {
  useEffect(() => {
    if (window.electronBridge?.windowRole === 'main') {
      window.electronBridge.markRendererReady?.()
    }
  }, [])
}
