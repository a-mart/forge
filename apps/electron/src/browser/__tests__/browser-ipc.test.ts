import { describe, expect, it, vi } from 'vitest'
import { BrowserHostError } from '../browser-errors.js'
import { BROWSER_IPC } from '../browser-bridge-contract.js'
import { installBrowserIpc } from '../browser-ipc.js'

describe('main-owned browser IPC role and lifecycle', () => {
  it('restricts reconciliation/automation to main and disposes the view host once', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const ipcMain = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)), removeHandler: vi.fn((channel) => handlers.delete(channel)) }
    const manager = {
      prepareRecording: vi.fn(async () => { throw new BrowserHostError('recording-requires-visible-tab', 'physical bounds missing', true) }),
      humanNavigate: vi.fn(), humanHistory: vi.fn(), humanReload: vi.fn(), humanSetZoom: vi.fn(), execute: vi.fn(),
      stopRecordingCapture: vi.fn(), saveRecording: vi.fn(), cancelRecording: vi.fn(), setRecordingMimeType: vi.fn(),
    }
    const viewHost = {
      reconcile: vi.fn(async () => ({ applied: true, tabCount: 1 })), ensureProvisional: vi.fn(), commitProvisional: vi.fn(), abortProvisional: vi.fn(),
      setPresentationTarget: vi.fn(), present: vi.fn(), captureScreenshot: vi.fn(), destroy: vi.fn(async () => undefined),
    }
    const mainWindow = { isDestroyed: () => false, webContents: { id: 10 } }
    const dispose = installBrowserIpc({ ipcMain: ipcMain as never, mainWindow: mainWindow as never, manager: manager as never, viewHost: viewHost as never })
    const installedHandlerCount = handlers.size

    await expect(handlers.get(BROWSER_IPC.reconcile)!({ sender: { id: 10 } }, { updateSequence: 1 })).resolves.toMatchObject({ ok: true, value: { applied: true } })
    await expect(handlers.get(BROWSER_IPC.reconcile)!({ sender: { id: 11 } }, {})).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(handlers.get(BROWSER_IPC.prepareRecording)!({ sender: { id: 10 } }, {})).resolves.toMatchObject({ ok: false, error: { code: 'recording-requires-visible-tab' } })

    dispose(); dispose(); await Promise.resolve()
    expect(viewHost.destroy).toHaveBeenCalledOnce()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(installedHandlerCount)
  })

  it('dispatches every registered privileged route and maps sender denial', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const ipcMain = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)), removeHandler: vi.fn() }
    const manager = {
      prepareRecording: vi.fn(async () => ({ recordingId: 'r' })), stopRecordingCapture: vi.fn(async () => ({ recordingId: 'r' })),
      saveRecording: vi.fn(async () => ({ saved: true })), cancelRecording: vi.fn(), setRecordingMimeType: vi.fn(),
      humanNavigate: vi.fn(async () => ({ tabId: 'tab' })), humanHistory: vi.fn(async () => ({ tabId: 'tab' })),
      humanReload: vi.fn(async () => ({ tabId: 'tab' })), humanSetZoom: vi.fn(async () => ({ tabId: 'tab' })),
      execute: vi.fn(async (request) => request), handleLifecycle: vi.fn(async (request) => request),
      revealTarget: vi.fn(async () => ({ targetAffinity: 'managed-electron', revealed: true, tabId: 'tab' })),
      takeControl: vi.fn(async (_session, tabId) => ({ released: true, tabId })),
    }
    const viewHost = {
      reconcile: vi.fn(async () => ({ applied: true, tabCount: 1 })), ensureProvisional: vi.fn(async () => ({ tabId: 'tab' })),
      commitProvisional: vi.fn(async () => undefined), abortProvisional: vi.fn(async () => undefined), setPresentationTarget: vi.fn(),
      present: vi.fn(async () => ({ applied: true })), captureScreenshot: vi.fn(async () => 'data'), destroy: vi.fn(async () => undefined),
    }
    const mainWindow = { isDestroyed: () => false, webContents: { id: 10 } }
    installBrowserIpc({ ipcMain: ipcMain as never, mainWindow: mainWindow as never, manager: manager as never, viewHost: viewHost as never })
    const trusted = { sender: { id: 10 } }
    const routeInputs: Array<[string, unknown]> = [
      [BROWSER_IPC.reconcile, {}], [BROWSER_IPC.ensureProvisional, { tab: {}, workspaceEpoch: 1 }],
      [BROWSER_IPC.commitProvisional, { tabId: 'tab', workspaceEpoch: 1 }], [BROWSER_IPC.abortProvisional, 'tab'],
      [BROWSER_IPC.viewport, {}], [BROWSER_IPC.presentation, {}], [BROWSER_IPC.capture, 'tab'],
      [BROWSER_IPC.humanNavigate, { tabId: 'tab', url: 'https://example.com' }], [BROWSER_IPC.humanHistory, { tabId: 'tab', direction: 'back' }],
      [BROWSER_IPC.humanReload, { tabId: 'tab', hard: true }], [BROWSER_IPC.humanZoom, { tabId: 'tab', factor: 1 }],
      [BROWSER_IPC.execute, { operation: 'status' }], [BROWSER_IPC.lifecycle, { type: 'ready' }],
      [BROWSER_IPC.reveal, { sessionAgentId: 'session', profileId: 'profile', tabId: 'tab' }],
      [BROWSER_IPC.takeControl, { sessionAgentId: 'session', profileId: 'profile', tabId: 'ext.instance.7' }],
      [BROWSER_IPC.prepareRecording, { operation: 'recordingStart' }], [BROWSER_IPC.stopRecordingCapture, { operation: 'recordingStop' }],
      [BROWSER_IPC.saveRecording, { request: { operation: 'recordingStop' }, mimeType: 'video/webm', bytes: new Uint8Array() }],
      [BROWSER_IPC.cancelRecording, 'recording'],
    ]
    for (const [channel, input] of routeInputs) {
      await expect(handlers.get(channel)!(trusted, input)).resolves.toMatchObject({ __forgeBrowserIpcResult: true, ok: true })
      await expect(handlers.get(channel)!({ sender: { id: 99 } }, input)).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    }
    expect(manager.humanNavigate).toHaveBeenCalledWith('tab', 'https://example.com')
    expect(manager.humanReload).toHaveBeenCalledWith('tab', true)
    expect(manager.saveRecording).toHaveBeenCalledOnce()
    expect(manager.takeControl).toHaveBeenCalledWith(
      { sessionAgentId: 'session', profileId: 'profile' },
      'ext.instance.7',
    )
    await expect(handlers.get(BROWSER_IPC.takeControl)!(trusted, {
      sessionAgentId: 'session', profileId: 'profile', tabId: 'tab', unexpected: true,
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    const maximumInstanceTabId = `ext.${'a'.repeat(128)}.7`
    await expect(handlers.get(BROWSER_IPC.takeControl)!(trusted, {
      sessionAgentId: 'session', profileId: 'profile', tabId: maximumInstanceTabId,
    })).resolves.toMatchObject({ ok: true })
    expect(manager.takeControl).toHaveBeenLastCalledWith(
      { sessionAgentId: 'session', profileId: 'profile' },
      maximumInstanceTabId,
    )
    await expect(handlers.get(BROWSER_IPC.takeControl)!(trusted, {
      sessionAgentId: 'session', profileId: 'profile', tabId: `ext.${'a'.repeat(129)}.7`,
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })
})
