/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHostConnectionSnapshot, BrowserSessionSnapshot, BrowserTabSnapshot } from '@forge/protocol'
import type { BrowserWorkspaceCommandPort } from './BrowserPanel'

vi.mock('@/components/help/HelpTrigger', () => ({ HelpTrigger: () => createElement('button', { 'aria-label': 'Help' }) }))
const { BrowserPanel } = await import('./BrowserPanel')
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = new Date(0).toISOString()
const managedTab = tab('managed-electron', 'managed-1', 'Embedded tab')
const externalTab = tab('external-chrome', 'ext.profile.7', 'Chrome tab')
const host: BrowserHostConnectionSnapshot = {
  connected: true, hostId: 'host-1', hostGeneration: 2, focused: true, connectedAt: now,
  capabilities: { protocolVersions: { minimum: 2, maximum: 2 }, supportedOperations: ['status'], maxResponseBytes: 1024,
    features: { resize: true, recording: true, capturePage: true, downloadEvents: false, downloadArtifacts: false, downloadOpen: false } },
}
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  window.electronBridge = { windowRole: 'main', platform: 'darwin', backendWsUrl: 'ws://local' }
})
afterEach(() => { act(() => root.unmount()); container.remove(); delete window.electronBridge })

function tab(targetAffinity: BrowserTabSnapshot['targetAffinity'], tabId: string, title: string): BrowserTabSnapshot {
  return { targetAffinity, tabId, title, sessionAgentId: 'session-1', profileId: 'profile-1', url: targetAffinity === 'external-chrome' ? '' : 'https://example.com', lifecycle: 'ready', loading: false, live: true, canGoBack: true, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: now, updatedAt: now }
}
function snapshot(tabs: BrowserTabSnapshot[], activeTabId = tabs[0]?.tabId ?? null): BrowserSessionSnapshot {
  return { schemaVersion: 2, sessionAgentId: 'session-1', profileId: 'profile-1', hostingState: 'hosted', tabs, activeTabId, defaultTabId: activeTabId, panelVisible: true, recentActions: [], revision: 1, createdAt: now, updatedAt: now }
}
function port(): BrowserWorkspaceCommandPort {
  return { open: vi.fn(), activate: vi.fn(), close: vi.fn(), resize: vi.fn(), navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), zoom: vi.fn(), capture: vi.fn(async () => ''), startRecording: vi.fn(), stopRecording: vi.fn(), reveal: vi.fn(), popOut: vi.fn(), dock: vi.fn() }
}
function render(state: BrowserSessionSnapshot, commands = port()) {
  act(() => root.render(createElement(BrowserPanel, { sessionAgentId: 'session-1', profileId: 'profile-1', snapshot: state, host, commandPort: commands, popoutAvailable: true })))
  return commands
}

describe('BrowserPanel automatic experience', () => {
  it('renders one tab strip without host or attachment ceremony', () => {
    render(snapshot([managedTab, externalTab], managedTab.tabId))
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2)
    expect(container.querySelector('[aria-label="Browser workspace"]')).not.toBeNull()
    expect(container.querySelector('select[aria-label="Browser host"]')).toBeNull()
    expect(container.textContent).not.toMatch(/attach|detach|lease|candidate|profile alias/i)
  })

  it('shows the embedded surface and its supported controls', () => {
    render(snapshot([managedTab]))
    expect(container.querySelector('[data-browser-automation-viewport]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Start recording"]')).not.toBeNull()
    expect(container.querySelector('select#browser-viewport')).not.toBeNull()
  })

  it('shows a compact Chrome card and hides unsupported controls', () => {
    const commands = render(snapshot([externalTab]))
    expect(container.textContent).toContain('Browser tab open in Chrome')
    expect(container.querySelector('[data-browser-automation-viewport]')).toBeNull()
    expect(container.querySelector('button[aria-label="Start recording"]')).toBeNull()
    expect(container.querySelector('select#browser-viewport')).toBeNull()
    const show = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Show in Chrome')!
    act(() => show.click())
    expect(commands.reveal).toHaveBeenCalledWith(externalTab.tabId)
  })

  it('automatically opens once from an empty hosted session', async () => {
    const commands = render(snapshot([]))
    await act(async () => { await Promise.resolve() })
    expect(commands.open).toHaveBeenCalledTimes(1)
  })
})
