const CONTENT_BRIDGE_SLOT = '__forgeExternalChromeContentBridgeV1__'

interface ContentBridgeMarker {
  active: boolean
  dispose(): void
}

/**
 * Installs exactly one bridge in a live document's isolated world. Repeated executeScript calls are
 * deliberate recovery probes; they must not multiply Ports or trusted-input listeners.
 */
export function installSingletonContentBridge(
  scope: Record<string, unknown>,
  activate: (dispose: () => void) => void,
): boolean {
  const existing = scope[CONTENT_BRIDGE_SLOT] as ContentBridgeMarker | undefined
  if (existing?.active === true) return false

  let disposed = false
  const marker: ContentBridgeMarker = {
    active: true,
    dispose: () => {
      if (disposed) return
      disposed = true
      marker.active = false
      if (scope[CONTENT_BRIDGE_SLOT] === marker) delete scope[CONTENT_BRIDGE_SLOT]
    },
  }
  Object.defineProperty(scope, CONTENT_BRIDGE_SLOT, {
    configurable: true,
    enumerable: false,
    value: marker,
    writable: false,
  })
  try {
    activate(marker.dispose)
    return true
  } catch (error) {
    marker.dispose()
    throw error
  }
}
