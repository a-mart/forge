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
  return { open: vi.fn(), activate: vi.fn(), close: vi.fn(), resize: vi.fn(), navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), zoom: vi.fn(), capture: vi.fn(async () => ''), startRecording: vi.fn(), stopRecording: vi.fn(), reveal: vi.fn(), takeControl: vi.fn(), popOut: vi.fn(), dock: vi.fn() }
}
function render(state: BrowserSessionSnapshot, commands = port(), mode: 'docked' | 'popped-out' = 'docked') {
  act(() => root.render(createElement(BrowserPanel, { sessionAgentId: 'session-1', profileId: 'profile-1', snapshot: state, host, commandPort: commands, mode, popoutAvailable: true })))
  return commands
}

describe('BrowserPanel automatic experience', () => {
  it('renders only managed tabs in the Browser workspace', () => {
    render(snapshot([managedTab, externalTab], externalTab.tabId))
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1)
    expect(container.querySelector('[role="tab"]')?.textContent).toBe('Embedded tab')
    expect(container.textContent).not.toContain('Chrome tab')
    expect(container.querySelector('[aria-label="Browser workspace"]')).not.toBeNull()
  })

  it('projects active and inactive URL/title metadata without reselection', () => {
    const inactive = { ...managedTab, tabId: 'managed-2', url: 'https://old.test', title: 'Old inactive' }
    render(snapshot([managedTab, inactive], managedTab.tabId))

    render(snapshot([
      { ...managedTab, url: 'https://active.test/live', title: 'Live active' },
      { ...inactive, url: 'https://inactive.test/live', title: 'Live inactive' },
    ], managedTab.tabId))

    expect((container.querySelector('#browser-address') as HTMLInputElement).value).toBe('https://active.test/live')
    expect([...container.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual(['Live active', 'Live inactive'])
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Live active')
  })

  it('does not expose External Chrome references or manual Preview controls', () => {
    render(snapshot([managedTab, { ...externalTab, controller: 'agent-idle' }], externalTab.tabId))
    expect(container.querySelector('button[aria-label="Open read-only browser preview"]')).toBeNull()
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Preview')).toBe(false)
    expect(container.textContent).not.toContain('Chrome')
    expect(container.textContent).not.toContain('Agent attached · idle')
    expect(container.textContent).not.toContain('Take Control')
  })

  it('treats an external-only canonical snapshot as an empty managed workspace', () => {
    const commands = render(snapshot([externalTab], externalTab.tabId))
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('Chrome')
    expect(container.textContent).toContain('No browser tabs are open.')
    expect(commands.open).not.toHaveBeenCalled()
  })

  it('dispatches an explicit new-tab command from the plus button', () => {
    const commands = render(snapshot([managedTab]))
    act(() => (container.querySelector('button[aria-label="New browser tab"]') as HTMLButtonElement).click())
    expect(commands.open).toHaveBeenCalledWith()
  })

  it('does not auto-open a blank tab when a background tab snapshot already exists', async () => {
    const commands = render(snapshot([managedTab]))
    await act(async () => { await Promise.resolve() })
    expect(commands.open).not.toHaveBeenCalled()
    expect(container.querySelector('[role="tab"]')?.textContent).toBe('Embedded tab')
  })

  it('lets the last managed tab close without automatically replacing it', () => {
    const commands = render(snapshot([managedTab]))
    act(() => (container.querySelector('button[aria-label="Close Embedded tab"]') as HTMLButtonElement).click())
    expect(commands.close).toHaveBeenCalledWith('managed-1')

    render(snapshot([]), commands)
    expect(container.textContent).toContain('No browser tabs are open.')
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0)
    expect(commands.open).not.toHaveBeenCalled()
  })
})
