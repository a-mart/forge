import type { BrowserSessionSnapshot, BrowserTabSnapshot } from '@forge/protocol'
import type { ManagerWsState } from '@/lib/ws-state'

export function countOpenBrowserTabs(snapshot: BrowserSessionSnapshot | null): number {
  return snapshot?.tabs.filter((tab) => tab.lifecycle !== 'closed').length ?? 0
}

export function projectRuntimeBrowserTabState(state: ManagerWsState, runtimeTab: BrowserTabSnapshot): ManagerWsState {
  const session = state.browserSessions[runtimeTab.sessionAgentId]
  if (!session || session.profileId !== runtimeTab.profileId || session.hostingState !== 'hosted') return state
  const index = session.tabs.findIndex((tab) => tab.tabId === runtimeTab.tabId
    && tab.targetAffinity === 'managed-electron'
    && runtimeTab.targetAffinity === 'managed-electron')
  if (index < 0) return state
  const tabs = [...session.tabs]
  tabs[index] = rebaseHostOwnedTabFields(tabs[index]!, runtimeTab)
  return {
    ...state,
    browserSessions: {
      ...state.browserSessions,
      [session.sessionAgentId]: { ...session, tabs },
    },
  }
}

export function rebaseHostOwnedTabFields(canonical: BrowserTabSnapshot, updated: BrowserTabSnapshot): BrowserTabSnapshot {
  return {
    ...canonical,
    url: updated.url, title: updated.title, lifecycle: updated.lifecycle, loading: updated.loading, live: updated.live,
    canGoBack: updated.canGoBack, canGoForward: updated.canGoForward, zoomFactor: updated.zoomFactor,
    controller: updated.controller, agentCursor: updated.agentCursor, recording: updated.recording,
    viewportSetting: updated.viewportSetting, renderedViewport: updated.renderedViewport,
    ...(updated.physicalVisible !== undefined ? { physicalVisible: updated.physicalVisible } : {}),
    error: updated.error, updatedAt: updated.updatedAt,
  }
}
