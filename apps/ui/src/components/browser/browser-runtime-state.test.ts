import { describe, expect, it } from 'vitest'
import type { BrowserSessionSnapshot, BrowserTabSnapshot } from '@forge/protocol'
import { countOpenBrowserTabs } from './browser-runtime-state'

const now = new Date(0).toISOString()

function tab(tabId: string, lifecycle: BrowserTabSnapshot['lifecycle']): BrowserTabSnapshot {
  return {
    targetAffinity: 'managed-electron',
    tabId,
    sessionAgentId: 'session-1',
    profileId: 'profile-1',
    url: 'about:blank',
    title: 'Browser tab',
    lifecycle,
    loading: lifecycle === 'loading',
    live: lifecycle !== 'closed',
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    controller: 'none',
    agentCursor: null,
    recording: null,
    viewportSetting: { mode: 'fill' },
    renderedViewport: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  }
}

function snapshot(tabs: BrowserTabSnapshot[]): BrowserSessionSnapshot {
  return {
    schemaVersion: 2,
    sessionAgentId: 'session-1',
    profileId: 'profile-1',
    hostingState: 'hosted',
    tabs,
    activeTabId: tabs[0]?.tabId ?? null,
    defaultTabId: tabs[0]?.tabId ?? null,
    panelVisible: false,
    recentActions: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
}

describe('countOpenBrowserTabs', () => {
  it('counts every live browser tab while excluding retained closed metadata', () => {
    expect(countOpenBrowserTabs(snapshot([
      tab('ready', 'ready'),
      tab('loading', 'loading'),
      tab('restoring', 'restoring'),
      tab('closed', 'closed'),
    ]))).toBe(3)
  })

  it('returns zero before the browser session is available', () => {
    expect(countOpenBrowserTabs(null)).toBe(0)
  })
})
