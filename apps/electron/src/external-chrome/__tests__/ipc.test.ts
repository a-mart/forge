import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { installExternalChromeIpc } from '../ipc.js'
import type { ExternalChromeHostCoordinator } from '../coordinator.js'

const status = {
  state: 'disabled' as const,
  authority: 'none' as const,
  auth: 'missing' as const,
  registration: 'not-registered' as const,
  trust: 'missing' as const,
  platform: 'darwin' as const,
  canEnable: true,
  canDisable: true,
  canRepair: true,
  canRollback: true,
  canRemove: true,
  canTakeover: true,
  canReveal: true,
  setup: {
    extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd' as const,
    pathState: 'ready' as const,
    loadUnpackedPath: '/forge-owned/external-chrome/extension',
  },
}

describe('trusted External Chrome IPC', () => {
  it('accepts only exact validated requests from the authoritative renderer and exposes no secret fields', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
    const ipcMain = {
      handle: vi.fn((channel: string, value: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => { handlers.set(channel, value) }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { id: 42 },
    } as unknown as BrowserWindow
    const coordinator = {
      status: vi.fn(async () => status),
      enable: vi.fn(async () => ({ ...status, state: 'online' as const })),
      disable: vi.fn(async () => status),
      repair: vi.fn(async () => status),
      rollback: vi.fn(async () => status),
      remove: vi.fn(async () => status),
      takeover: vi.fn(async () => status),
      validatedLoadUnpackedPath: vi.fn(async () => status.setup.loadUnpackedPath),
      transport: vi.fn(() => ({ inventory: vi.fn(() => []) })),
    } as unknown as ExternalChromeHostCoordinator
    const revealExtensionFolder = vi.fn(async () => undefined)
    const dispose = installExternalChromeIpc({ ipcMain, mainWindow, coordinator, revealExtensionFolder })
    const invoke = handlers.get('forge:external-chrome-control')
    if (!invoke) throw new Error('IPC handler was not installed')

    await expect(invoke({ sender: { id: 7 } } as unknown as IpcMainInvokeEvent, { operation: 'status' }))
      .resolves.toEqual({ ok: false, error: 'invalid-request' })
    await expect(invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation: 'status', key: 'leak' }))
      .resolves.toEqual({ ok: false, error: 'invalid-request' })
    const result = await invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation: 'status' })
    expect(result).toEqual({ ok: true, status })
    expect(JSON.stringify(result)).not.toMatch(/endpoint|pid|secret|keyId/iu)

    await expect(invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, {
      operation: 'reveal-extension-folder', path: '/attacker-controlled',
    })).resolves.toEqual({ ok: false, error: 'invalid-request' })
    await expect(invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, {
      operation: 'reveal-extension-folder',
    })).resolves.toEqual({ ok: true, status })
    expect(revealExtensionFolder).toHaveBeenCalledWith('/forge-owned/external-chrome/extension')

    for (const operation of ['enable', 'disable', 'repair', 'rollback', 'remove', 'takeover'] as const) {
      await expect(invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation }))
        .resolves.toEqual({ ok: true, status: operation === 'enable' ? { ...status, state: 'online' } : status })
    }
    expect(coordinator.rollback).toHaveBeenCalledTimes(1)
    expect(coordinator.takeover).toHaveBeenCalledTimes(1)
    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(2)
  })

  it('strictly validates local attachment input and keeps equal numeric tab IDs namespaced by extension instance', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<any>>()
    const ipcMain = { handle: vi.fn((channel: string, handler: any) => handlers.set(channel, handler)), removeHandler: vi.fn() } as unknown as IpcMain
    const mainWindow = { isDestroyed: () => false, webContents: { id: 42 } } as unknown as BrowserWindow
    const inventory = [
      { extensionInstanceId: 'profile_a', profileAlias: 'Work', chromeVersion: '125', payloadVersion: '1', connectedAt: 'now' },
      { extensionInstanceId: 'profile_b', profileAlias: 'Personal', chromeVersion: '125', payloadVersion: '1', connectedAt: 'now' },
    ]
    const candidate = (extensionInstanceId: string) => ({
      protocolVersion: 1 as const, extensionInstanceId, profileAlias: extensionInstanceId,
      windows: [{ windowId: 1, focused: true, groups: [], tabs: [{ windowId: 1, tabId: 7, groupId: null, title: `${extensionInstanceId} title`, origin: 'https://example.test', active: true, attached: false, restricted: false, debuggerConflict: false }] }],
    })
    const transport = {
      inventory: vi.fn(() => inventory),
      listCandidates: vi.fn(async (instance: string) => candidate(instance)),
      claim: vi.fn(async (input: any) => ({ protocolVersion: 1, leaseId: input.leaseId, leaseEpoch: input.leaseEpoch, sessionAgentId: input.sessionAgentId, extensionInstanceId: input.extensionInstanceId, groupId: null, childPolicy: input.childPolicy, tabs: [{ windowId: 1, tabId: input.tabIds[0], groupId: null, title: `${input.extensionInstanceId} title`, url: 'https://example.test/private', origin: 'https://example.test', active: true }] })),
      release: vi.fn(async () => undefined),
    }
    const coordinator = { status: vi.fn(async () => ({ ...status, state: 'online' as const })), transport: vi.fn(() => transport) } as unknown as ExternalChromeHostCoordinator
    installExternalChromeIpc({ ipcMain, mainWindow, coordinator })
    const invoke = handlers.get('forge:external-chrome-attach')!
    const event = { sender: { id: 42 } } as unknown as IpcMainInvokeEvent

    await expect(invoke(event, { operation: 'candidates', sessionAgentId: 'session-a', profileId: 'profile-a', extensionInstanceId: 'profile_a', leak: true })).resolves.toEqual({ ok: false, error: 'invalid-request' })
    const first = await invoke(event, { operation: 'candidates', sessionAgentId: 'session-a', profileId: 'profile-a', extensionInstanceId: 'profile_a' })
    const second = await invoke(event, { operation: 'candidates', sessionAgentId: 'session-a', profileId: 'profile-a', extensionInstanceId: 'profile_b' })
    expect(first.windows[0].tabs[0]).toMatchObject({ tabId: 7, title: 'profile_a title' })
    expect(second.windows[0].tabs[0]).toMatchObject({ tabId: 7, title: 'profile_b title' })

    const attachment = { operation: 'attach', sessionAgentId: 'session-a', profileId: 'profile-a', extensionInstanceId: 'profile_a', tabIds: [7], childPolicy: 'manual', confirmed: true }
    await expect(invoke(event, { ...attachment, confirmed: false })).resolves.toEqual({ ok: false, error: 'invalid-request' })
    const attached = await invoke(event, attachment)
    expect(attached.status.attachment).toMatchObject({ extensionInstanceId: 'profile_a', tabs: [{ tabId: 7 }], childPolicy: 'manual', state: 'attached' })
    expect(JSON.stringify(attached)).not.toContain('/private')
    const release = { operation: 'lifecycle-release', requestId: 'external-chrome-release:stop:correlation-1', hostId: 'external-host', hostGeneration: 4, sessionAgentId: 'session-a', profileId: 'profile-a', tabId: 'ext.profile_a.7', reason: 'stop' }
    await expect(invoke(event, { ...release, requestId: 'wrong-correlation' })).resolves.toEqual({ ok: false, error: 'invalid-request' })
    await expect(invoke(event, { ...release, tabId: 'ext.profile_b.7' })).resolves.toEqual({ ok: false, error: 'stale-or-lost' })
    const acknowledged = await invoke(event, release)
    expect(acknowledged).toMatchObject({ ok: true, status: { attachment: null } })
    expect(transport.release).toHaveBeenCalledWith('profile_a', expect.stringMatching(/^forge-ui-/u), 1, 'lifecycle-stop')

    await invoke(event, attachment)
    await invoke(event, { operation: 'detach', sessionAgentId: 'session-a', profileId: 'profile-a' })
    expect(transport.release).toHaveBeenLastCalledWith('profile_a', expect.stringMatching(/^forge-ui-/u), 2, 'detached-from-forge')

    await invoke(event, attachment)
    transport.release.mockImplementationOnce(() => new Promise<void>(() => undefined))
    vi.useFakeTimers()
    const timedOut = invoke(event, { ...release, requestId: 'external-chrome-release:delete:correlation-2', reason: 'delete' })
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(timedOut).resolves.toEqual({ ok: false, error: 'operation-failed' })
    vi.useRealTimers()
  })

  it('refreshes relay-created and adopted checkpoints after IPC installation for every lifecycle release', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<any>>()
    const ipcMain = { handle: vi.fn((channel: string, handler: any) => handlers.set(channel, handler)), removeHandler: vi.fn() } as unknown as IpcMain
    const mainWindow = { isDestroyed: () => false, webContents: { id: 42 } } as unknown as BrowserWindow
    let checkpoints: any[] = []
    const release = vi.fn(async (_instance: string, leaseId: string, leaseEpoch: number) => {
      checkpoints = checkpoints.filter((checkpoint) => checkpoint.leaseId !== leaseId || checkpoint.leaseEpoch !== leaseEpoch)
    })
    const transport = {
      leaseCheckpoints: vi.fn(async () => structuredClone(checkpoints)),
      inventory: vi.fn(() => [{ extensionInstanceId: 'profile_a', profileAlias: 'Work', chromeVersion: '125', payloadVersion: '1', connectedAt: 'now' }]),
      release,
    }
    const coordinator = { status: vi.fn(async () => ({ ...status, state: 'online' as const })), transport: vi.fn(() => transport) } as unknown as ExternalChromeHostCoordinator
    installExternalChromeIpc({ ipcMain, mainWindow, coordinator })
    const invoke = handlers.get('forge:external-chrome-attach')!
    const event = { sender: { id: 42 } } as unknown as IpcMainInvokeEvent
    await invoke(event, { operation: 'status', sessionAgentId: 'session-a', profileId: 'profile-a' })

    for (const [index, reason] of ['stop', 'archive', 'delete', 'detach'].entries()) {
      checkpoints = [{
        extensionInstanceId: 'profile_a', sessionAgentId: 'session-a', profileId: 'profile-a', leaseId: `relay-after-install-${index}`,
        leaseEpoch: 20 + index, tabIds: [7], groupId: 9, childPolicy: 'manual', expiresAt: Date.now() + 60_000,
      }]
      await expect(invoke(event, { operation: 'status', sessionAgentId: 'session-a', profileId: 'profile-a' }))
        .resolves.toMatchObject({ ok: true, status: { attachment: { tabs: [{ tabId: 7 }] } } })
      const request = reason === 'detach'
        ? { operation: 'detach', sessionAgentId: 'session-a', profileId: 'profile-a' }
        : { operation: 'lifecycle-release', requestId: `external-chrome-release:${reason}:after-install-${index}`, hostId: 'external-host', hostGeneration: 8, sessionAgentId: 'session-a', profileId: 'profile-a', tabId: 'ext.profile_a.7', reason }
      await expect(invoke(event, request)).resolves.toMatchObject({ ok: true, status: { attachment: null } })
    }
    expect(release.mock.calls.map((call) => call.slice(1))).toEqual([
      ['relay-after-install-0', 20, 'lifecycle-stop'],
      ['relay-after-install-1', 21, 'lifecycle-archive'],
      ['relay-after-install-2', 22, 'lifecycle-delete'],
      ['relay-after-install-3', 23, 'detached-from-forge'],
    ])
  })

  it('reconciles IPC detach authority from durable relay checkpoints after Desktop restart', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<any>>()
    const ipcMain = { handle: vi.fn((channel: string, handler: any) => handlers.set(channel, handler)), removeHandler: vi.fn() } as unknown as IpcMain
    const mainWindow = { isDestroyed: () => false, webContents: { id: 42 } } as unknown as BrowserWindow
    let checkpoints = [{
      extensionInstanceId: 'profile_a', sessionAgentId: 'session-a', profileId: 'profile-a', leaseId: 'lease-before-restart',
      leaseEpoch: 8, tabIds: [7], groupId: 9, childPolicy: 'manual' as const, expiresAt: Date.now() + 60_000,
    }]
    const release = vi.fn(async () => { checkpoints = [] })
    const transport = {
      leaseCheckpoints: vi.fn(async () => structuredClone(checkpoints)),
      inventory: vi.fn(() => [{ extensionInstanceId: 'profile_a', profileAlias: 'Work', chromeVersion: '125', payloadVersion: '1', connectedAt: 'now' }]),
      release,
    }
    const coordinator = { status: vi.fn(async () => ({ ...status, state: 'online' as const })), transport: vi.fn(() => transport) } as unknown as ExternalChromeHostCoordinator
    installExternalChromeIpc({ ipcMain, mainWindow, coordinator })
    const invoke = handlers.get('forge:external-chrome-attach')!
    const event = { sender: { id: 42 } } as unknown as IpcMainInvokeEvent
    await expect(invoke(event, { operation: 'status', sessionAgentId: 'session-a', profileId: 'profile-a' }))
      .resolves.toMatchObject({ ok: true, status: { attachment: { extensionInstanceId: 'profile_a', tabs: [{ tabId: 7 }], state: 'attached' } } })
    await expect(invoke(event, { operation: 'detach', sessionAgentId: 'session-a', profileId: 'profile-a' }))
      .resolves.toMatchObject({ ok: true, status: { attachment: null } })
    expect(release).toHaveBeenCalledWith('profile_a', 'lease-before-restart', 8, 'detached-from-forge')
  })
})
