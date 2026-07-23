/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPopoutSurface } from './BrowserPopoutSurface'
import type { ManagedBrowserWorkspaceProjection } from '@/lib/electron-bridge'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root | null = null
beforeEach(() => { container = document.createElement('div'); document.body.append(container) })
afterEach(() => { if (root) act(() => root?.unmount()); root = null; container.remove(); delete window.electronBridge })
const host = { connected: false, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null }
function bridge(projection: ManagedBrowserWorkspaceProjection | null) {
  return {
    capability: { popoutAvailable: true }, getSnapshot: vi.fn(async () => projection), sendCommand: vi.fn(), popOut: vi.fn(), dock: vi.fn(async () => 'docked' as const), bringToFront: vi.fn(), reportViewport: vi.fn(),
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
})
