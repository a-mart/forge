const MODEL_ICONS_KEY = 'forge-sidebar-model-icons'
const PROVIDER_USAGE_KEY = 'forge-sidebar-provider-usage'
export const HIDE_CLI_SESSIONS_KEY = 'forge-sidebar-hide-cli-sessions'
export const CONVERSATION_THROUGHPUT_DISPLAY_KEY = 'forge-conversation-throughput-display'
export const SIDEBAR_LAYOUT_KEY = 'forge-sidebar-layout'
export const PREFERENCE_CHANGE_EVENT = 'forge-sidebar-pref-change'

export type SidebarLayout = 'classic' | 'rooms-v2'

function dispatchSidebarPrefChange(key: string, value: boolean | SidebarLayout): void {
  window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGE_EVENT, { detail: { key, value } }))
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

export function readHideCliSessionsPref(): boolean {
  try {
    return localStorage.getItem(HIDE_CLI_SESSIONS_KEY) === 'true'
  } catch {
    return false
  }
}

export function storeHideCliSessionsPref(hidden: boolean): void {
  try {
    localStorage.setItem(HIDE_CLI_SESSIONS_KEY, String(hidden))
    dispatchSidebarPrefChange(HIDE_CLI_SESSIONS_KEY, hidden)
  } catch {
    // Ignore localStorage write failures
  }
}

/** Presentation-only rollout seam. Unset installations use the new project view. */
export function readSidebarLayoutPref(): SidebarLayout {
  try {
    return localStorage.getItem(SIDEBAR_LAYOUT_KEY) === 'classic' ? 'classic' : 'rooms-v2'
  } catch {
    return 'rooms-v2'
  }
}

export function storeSidebarLayoutPref(layout: SidebarLayout): void {
  try {
    localStorage.setItem(SIDEBAR_LAYOUT_KEY, layout)
  } catch {
    // Keep the in-memory UI responsive even when browser persistence is unavailable.
  }
  dispatchSidebarPrefChange(SIDEBAR_LAYOUT_KEY, layout)
}

/** Conversation-only presentation preference. Unset installations stay hidden. */
export function readConversationThroughputDisplayPref(): boolean {
  try {
    return localStorage.getItem(CONVERSATION_THROUGHPUT_DISPLAY_KEY) === 'true'
  } catch {
    return false
  }
}

export function storeConversationThroughputDisplayPref(enabled: boolean): void {
  try {
    localStorage.setItem(CONVERSATION_THROUGHPUT_DISPLAY_KEY, String(enabled))
  } catch {
    // Keep the in-memory UI responsive even when browser persistence is unavailable.
  }
  dispatchSidebarPrefChange(CONVERSATION_THROUGHPUT_DISPLAY_KEY, enabled)
}
