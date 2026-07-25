/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHostConnectionSnapshot, BrowserSessionSnapshot } from '@forge/protocol'
import type { ManagerWsClient } from '@/lib/ws-client'
import { BuilderBrowserPanel } from './BuilderBrowserPanel'

vi.mock('@/components/help/HelpTrigger', () => ({
  HelpTrigger: () => createElement('button', { type: 'button', 'aria-label': 'Help' }),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  delete window.electronBridge
  sessionStorage.clear()
})

describe('BuilderSurface browser mutation wiring', () => {
  it('routes host selection and confirmed detach through the local ManagerWsClient', async () => {
    const selectBrowserHost = vi.fn(async () => snapshot('external-chrome', 2))
    const confirmExternalChromeDetached = vi.fn(async () => snapshot('managed-electron', 3))
    const detach = vi.fn(async () => ({ ok: true, status: localStatus(null) }))
    window.electronBridge = {
      windowRole: 'main', backendWsUrl: 'ws://127.0.0.1:47100', platform: 'darwin',
      externalChrome: {
        localStatus: vi.fn(async () => ({ ok: true, status: localStatus({
          sessionAgentId: 'session-1', profileId: 'profile-1', extensionInstanceId: 'profile_a', profileAlias: 'Work',
          groupId: 9, childPolicy: 'manual', tabs: [{ windowId: 1, tabId: 7, groupId: 9, title: 'Fixture', origin: 'https://fixture.invalid', active: true }],
          state: 'attached', attachedAt: new Date(0).toISOString(),
        }) })),
        detach,
      },
    } as unknown as typeof window.electronBridge
    const client = { selectBrowserHost, confirmExternalChromeDetached } as unknown as ManagerWsClient
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(BuilderBrowserPanel, {
      client,
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      snapshot: snapshot('managed-electron', 1),
      host,
      commandPort: commands,
    })))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const selector = container.querySelector('select[aria-label="Browser host"]') as HTMLSelectElement
    await act(async () => {
      selector.value = 'external-chrome'
      selector.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(selectBrowserHost).toHaveBeenCalledWith('session-1', 'profile-1', 'external-chrome')

    const detachButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Detach now from Forge'))
    expect(detachButton).toBeDefined()
    await act(async () => { detachButton!.click(); await Promise.resolve(); await Promise.resolve() })
    expect(confirmExternalChromeDetached).toHaveBeenCalledWith('session-1', 'profile-1')
    expect(detach).toHaveBeenCalledWith('session-1', 'profile-1')
    container.remove()
  })
})

const host: BrowserHostConnectionSnapshot = {
  connected: true, hostId: 'managed-host', hostGeneration: 4, focused: false, capabilities: null, connectedAt: new Date(0).toISOString(),
}
const commands = {
  open: vi.fn(), activate: vi.fn(), close: vi.fn(), resize: vi.fn(), navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), zoom: vi.fn(),
  capture: vi.fn(async () => ''), startRecording: vi.fn(), stopRecording: vi.fn(),
}
function snapshot(hostKind: 'managed-electron' | 'external-chrome', revision: number): BrowserSessionSnapshot {
  return { schemaVersion: 1, sessionAgentId: 'session-1', profileId: 'profile-1', hostKind, hostingState: 'hosted', tabs: [], activeTabId: null, defaultTabId: null, panelVisible: true, recentActions: [], revision, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
}
function localStatus(attachment: unknown) {
  return {
    coordinator: { state: 'online', setup: { pathState: 'ready' } },
    instances: [{ extensionInstanceId: 'profile_a', profileAlias: 'Work', chromeVersion: '125', payloadVersion: '1', connectedAt: new Date(0).toISOString() }],
    attachment,
  }
}
