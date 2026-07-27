/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHostConnectionSnapshot, BrowserSessionSnapshot } from '@forge/protocol'
import { BuilderBrowserPanel } from './BuilderBrowserPanel'

vi.mock('@/components/help/HelpTrigger', () => ({ HelpTrigger: () => createElement('button', { 'aria-label': 'Help' }) }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); delete window.electronBridge })

describe('BuilderBrowserPanel', () => {
  it('composes one Browser without host-selection client calls', async () => {
    window.electronBridge = { windowRole: 'main', backendWsUrl: 'ws://local', platform: 'darwin' }
    const client = { selectBrowserHost: vi.fn(), confirmExternalChromeDetached: vi.fn() }
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container); roots.push(root)
    await act(async () => {
      root.render(createElement(BuilderBrowserPanel, {
        client: client as never, sessionAgentId: 'session-1', profileId: 'profile-1', snapshot, host, commandPort,
      }))
      await Promise.resolve()
    })
    expect(container.querySelector('[aria-label="Browser workspace"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Browser host"]')).toBeNull()
    expect(client.selectBrowserHost).not.toHaveBeenCalled()
    expect(client.confirmExternalChromeDetached).not.toHaveBeenCalled()
    container.remove()
  })
})

const now = new Date(0).toISOString()
const host: BrowserHostConnectionSnapshot = { connected: true, hostId: 'host', hostGeneration: 2, focused: true, capabilities: null, connectedAt: now }
const snapshot: BrowserSessionSnapshot = { schemaVersion: 2, sessionAgentId: 'session-1', profileId: 'profile-1', hostingState: 'hosted', tabs: [], activeTabId: null, defaultTabId: null, panelVisible: true, recentActions: [], revision: 1, createdAt: now, updatedAt: now }
const commandPort = { open: vi.fn(async () => undefined), activate: vi.fn(), close: vi.fn(), resize: vi.fn(), navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), zoom: vi.fn(), capture: vi.fn(async () => ''), startRecording: vi.fn(), stopRecording: vi.fn(), reveal: vi.fn() }
