import { describe, expect, it } from 'vitest'
import { DebuggerController } from '../src/runtime/debugger-controller.js'
import { LeaseManager } from '../src/runtime/lease-manager.js'
import { fakeChrome } from './fakes.js'

describe('operation-scoped debugger bursts', () => {
  it('attaches only after per-tab acquisition and detaches at operation completion', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    const authority = new LeaseManager(chrome, 'payload')
    const debuggerController = new DebuggerController(chrome.debugger)
    await authority.acquire({ tabId: 7, ownerId: 'owner', ownerEpoch: 1, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    expect(chrome.attached.has(7)).toBe(false)
    await debuggerController.attach(7)
    const controlEpoch = await authority.beginAgentControl('owner', 1, 7)
    expect(authority.isOperationCurrent('owner', 1, 7, controlEpoch)).toBe(true)
    await debuggerController.reset(7)
    await authority.finishAgentControl('owner', 1, 7, controlEpoch)
    expect(chrome.attached.has(7)).toBe(false)
    expect(authority.forTab(7)).toMatchObject({ state: 'human' })
  })

  it('does not replay a command after timeout/release', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    const authority = new LeaseManager(chrome, 'payload')
    const debuggerController = new DebuggerController(chrome.debugger)
    await authority.acquire({ tabId: 9, ownerId: 'owner', ownerEpoch: 3, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    await debuggerController.attach(9)
    await debuggerController.reset(9)
    await authority.release('owner', 3, 9)
    const commandCount = chrome.commands.length
    await expect(debuggerController.sendCommand(9, 'Runtime.evaluate', { expression: 'window.mutate()' })).rejects.toThrow(/not attached/u)
    expect(chrome.commands).toHaveLength(commandCount)
  })
})
