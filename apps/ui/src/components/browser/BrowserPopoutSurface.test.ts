/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHostConnectionSnapshot, BrowserSessionSnapshot, BrowserTabSnapshot } from '@forge/protocol'
import { BrowserPopoutSurface } from './BrowserPopoutSurface'
import type { ManagedBrowserWorkspaceProjection } from '@/lib/electron-bridge'

vi.mock('@/components/help/HelpTrigger', () => ({
  HelpTrigger: () => createElement('button', { type: 'button', 'aria-label': 'Help' }),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root | null = null
beforeEach(() => { container = document.createElement('div'); document.body.append(container) })
afterEach(() => { if (root) act(() => root?.unmount()); root = null; container.remove(); delete window.electronBridge })
const now = new Date(0).toISOString()
const host: BrowserHostConnectionSnapshot = { connected: false, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null }
const connectedHost: BrowserHostConnectionSnapshot = {
  connected: true,
  hostId: 'host-1',
  hostGeneration: 4,
  focused: true,
  capabilities: {
    supportedOperations: ['status'],
    electronVersion: '37',
    chromiumVersion: '138',
    playwrightVersion: '1.60.0',
    maxResponseBytes: 1024,
    supportsSandboxedWebviews: true,
    supportsCapturePage: true,
    supportsRecording: true,
  },
  connectedAt: now,
}
const emptySnapshot: BrowserSessionSnapshot = {
  schemaVersion: 1,
  sessionAgentId: 'session-1',
  profileId: 'profile-1',
  hostingState: 'hosted',
  tabs: [] as BrowserTabSnapshot[],
  activeTabId: null,
  defaultTabId: null,
  panelVisible: true,
  recentActions: [],
  revision: 9,
  createdAt: now,
  updatedAt: now,
}
function bridge(projection: ManagedBrowserWorkspaceProjection | null) {
  return {
    capability: { popoutAvailable: true }, getSnapshot: vi.fn(async () => projection), sendCommand: vi.fn(async () => undefined), popOut: vi.fn(), dock: vi.fn(async () => 'docked' as const), bringToFront: vi.fn(), reportViewport: vi.fn(),
    onProjection: vi.fn(() => () => undefined), onModeChanged: vi.fn(() => () => undefined),
  }
}
describe('BrowserPopoutSurface', () => {
  it('shows a local-only safe state without starting normal app/origin hooks', async () => {
    const projection: ManagedBrowserWorkspaceProjection = { workspaceEpoch: 2, sessionAgentId: null, profileId: null, snapshot: null, host, mode: 'popped-out', popoutAvailable: true, connected: false, publishedAt: new Date(0).toISOString() }
    const workspace = bridge(projection)
    window.electronBridge = { windowRole: 'managed-browser-popout', platform: 'darwin', browserWorkspace: workspace }
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserPopoutSurface)); await Promise.resolve() })
    expect(container.textContent).toContain('Select a local Builder manager')
    expect(window.electronBridge.backendWsUrl).toBeUndefined()
    expect(window.electronBridge.browserAutomation).toBeUndefined()
    expect(workspace.sendCommand).not.toHaveBeenCalled()
  })

  it('auto-opens one blank tab through the shared BrowserPanel without registering a second host', async () => {
    const projection: ManagedBrowserWorkspaceProjection = {
      workspaceEpoch: 3,
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      snapshot: emptySnapshot,
      host: connectedHost,
      mode: 'popped-out',
      popoutAvailable: true,
      connected: true,
      publishedAt: now,
    }
    const workspace = bridge(projection)
    window.electronBridge = { windowRole: 'managed-browser-popout', platform: 'darwin', browserWorkspace: workspace }
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserPopoutSurface)); await Promise.resolve(); await Promise.resolve() })
    expect(container.querySelector('[aria-label="Managed Browser workspace"]')).not.toBeNull()
    expect(workspace.sendCommand).toHaveBeenCalledTimes(1)
    expect(workspace.sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      workspaceEpoch: 3,
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      command: { type: 'open', autoOpenAttemptKey: 'session-1:profile-1:4:9' },
    }))
    expect(window.electronBridge.browserAutomation).toBeUndefined()
    expect(window.electronBridge.backendWsUrl).toBeUndefined()
  })
})
