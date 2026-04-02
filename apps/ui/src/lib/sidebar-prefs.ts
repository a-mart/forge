const MODEL_ICONS_KEY = 'forge-sidebar-model-icons'
const PROVIDER_USAGE_KEY = 'forge-sidebar-provider-usage'
const PREF_CHANGE_EVENT = 'forge-sidebar-pref-change'

function dispatchSidebarPrefChange(key: string, value: boolean): void {
  window.dispatchEvent(new CustomEvent(PREF_CHANGE_EVENT, { detail: { key, value } }))
}

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
    dispatchSidebarPrefChange(MODEL_ICONS_KEY, enabled)
  } catch {
    // Ignore localStorage write failures
  }
}

export function readSidebarProviderUsagePref(): boolean {
  try {
    const stored = localStorage.getItem(PROVIDER_USAGE_KEY)
    return stored === null ? true : stored === 'true'
  } catch {
    return true
  }
}

export function storeSidebarProviderUsagePref(enabled: boolean): void {
  try {
    localStorage.setItem(PROVIDER_USAGE_KEY, String(enabled))
    dispatchSidebarPrefChange(PROVIDER_USAGE_KEY, enabled)
  } catch {
    // Ignore localStorage write failures
  }
}
