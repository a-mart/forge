const MODEL_ICONS_KEY = 'forge-sidebar-model-icons'

export function readSidebarModelIconsPref(): boolean {
  try {
    return localStorage.getItem(MODEL_ICONS_KEY) === 'true'
  } catch {
    return false
  }
}

export function storeSidebarModelIconsPref(enabled: boolean): void {
  try {
    localStorage.setItem(MODEL_ICONS_KEY, String(enabled))
    // Dispatch custom event for same-tab listeners
    window.dispatchEvent(new CustomEvent('forge-sidebar-pref-change', { detail: { key: MODEL_ICONS_KEY, value: enabled } }))
  } catch {
    // Ignore localStorage write failures
  }
}
